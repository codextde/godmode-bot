import { createHash } from "node:crypto";
import {
  GithubErrorCode,
  pullRequestUrl,
  type PullRequestAutoMerge,
  type PullRequestCheck,
  type PullRequestCheckState,
  type PullRequestFile,
  type PullRequestMergeMethod,
  type PullRequestRef,
  type PullRequestReview,
  type PullRequestView,
  type PullRequestViewState,
} from "@godmode/shared";
import { resolveGh, runCommand, toolPath } from "../services/doctor";
import { logger } from "../log";
import { HttpError, childEnv } from "../util";

const log = logger("github");

const API = "https://api.github.com";
const HOST = "github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const RESERVE_RATIO = 0.1;
const FALLBACK_COOLDOWN_MS = 30_000;
const MAX_FALLBACK_COOLDOWN_MS = 15 * 60_000;
const TOKEN_TTL_MS = 10 * 60_000;
const NO_TOKEN_TTL_MS = 60_000;
const CACHE_CAPACITY = 256;
const DETAIL_TTL_MS = 60_000;
const SETTLED_DETAIL_TTL_MS = 10 * 60_000;
const CHECKS_TTL_MS = 15_000;
const SETTLED_CHECKS_TTL_MS = 10 * 60_000;
const FILES_PER_PAGE = 100;
const REPO_TTL_MS = 10 * 60_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Credential {
  token: string | null;
  scope: string;
}

interface Quota {
  limit: number;
  remaining: number;
  resetAtMs: number;
}

interface Pause {
  attempt: number;
  retryAtMs: number;
}

interface CacheEntry {
  etag: string | null;
  body: unknown;
  at: number;
}

interface Read {
  body: unknown;
  stale: boolean;
  retryAtMs?: number;
}

interface ReadOptions {
  ttlMs: number | ((body: unknown) => number);
  interactive: boolean;
  force?: boolean;
}

class GithubPaused extends Error {
  constructor(public retryAtMs: number) {
    super("GitHub requests are paused until the rate limit resets");
  }
}

class GithubFailure extends Error {
  constructor(
    public kind: "not_found" | "unauthorized" | "rate_limited" | "unreachable" | "failed",
    message: string,
    public retryAtMs: number | null = null,
  ) {
    super(message);
  }
}

let fetchImpl: Fetch = (url, init) => fetch(url, init);
let tokenOverride: (() => Promise<string | null>) | undefined;
let clock = () => Date.now();

let heldToken: { value: string | null; until: number } | null = null;
let tokenLookup: Promise<string | null> | null = null;
const quotas = new Map<string, Quota>();
const pauses = new Map<string, Pause>();
const cache = new Map<string, CacheEntry>();
const flights = new Map<string, Promise<PullRequestView>>();
let active = 0;
const waiting: (() => void)[] = [];

export function __setGithubForTests(opts: { fetch?: Fetch; token?: () => Promise<string | null>; now?: () => number } | null) {
  fetchImpl = opts?.fetch ?? ((url, init) => fetch(url, init));
  tokenOverride = opts?.token;
  clock = opts?.now ?? (() => Date.now());
  heldToken = null;
  tokenLookup = null;
  quotas.clear();
  pauses.clear();
  cache.clear();
  flights.clear();
}

async function lookupToken(): Promise<string | null> {
  if (tokenOverride) return tokenOverride();
  const fromEnv = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const gh = resolveGh();
  if (!gh) return null;
  const res = await runCommand([gh, "auth", "token", "--hostname", HOST], {
    env: childEnv({ PATH: toolPath(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }),
    timeoutMs: 10_000,
  });
  const token = res.code === 0 ? res.stdout.trim() : "";
  return /^[A-Za-z0-9_]{20,255}$/.test(token) ? token : null;
}

async function credential(): Promise<Credential> {
  const now = clock();
  if (!heldToken || heldToken.until <= now) {
    tokenLookup ??= lookupToken()
      .catch((err) => {
        log.warn("Couldn't read the GitHub CLI's token", err);
        return null;
      })
      .finally(() => {
        tokenLookup = null;
      });
    const value = await tokenLookup;
    heldToken = { value, until: clock() + (value ? TOKEN_TTL_MS : NO_TOKEN_TTL_MS) };
  }
  const token = heldToken.value;
  return { token, scope: token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "anonymous" };
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function quotaFrom(headers: Headers): (Quota & { resource: string }) | null {
  const resource = headers.get("x-ratelimit-resource")?.trim() || "core";
  const limit = Number(headers.get("x-ratelimit-limit"));
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!headers.has("x-ratelimit-limit") || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(reset)) return null;
  return { resource, limit, remaining, resetAtMs: reset * 1000 };
}

function observe(scope: string, headers: Headers) {
  const quota = quotaFrom(headers);
  if (!quota) return;
  const key = `${scope}\0${quota.resource}`;
  const previous = quotas.get(key);
  if (previous && quota.resetAtMs < previous.resetAtMs) return;
  quotas.set(key, { limit: quota.limit, remaining: quota.remaining, resetAtMs: quota.resetAtMs });
}

function admit(scope: string, interactive: boolean) {
  const now = clock();
  const pause = pauses.get(scope);
  if (pause && pause.retryAtMs > now) throw new GithubPaused(pause.retryAtMs);
  const quota = quotas.get(`${scope}\0core`);
  if (!quota || quota.resetAtMs <= now) return;
  const floor = interactive ? 1 : quota.limit * RESERVE_RATIO;
  if (quota.remaining < floor) throw new GithubPaused(quota.resetAtMs);
}

function retryAtFrom(headers: Headers, now: number): number | null {
  const after = headers.get("retry-after")?.trim();
  if (after) {
    if (/^\d+$/.test(after)) return now + Number(after) * 1000;
    const at = Date.parse(after);
    if (Number.isFinite(at) && at > now) return at;
  }
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
  return Number.isFinite(reset) && reset > now ? reset : null;
}

function recordRateLimit(scope: string, headers: Headers): number {
  const now = clock();
  const previous = pauses.get(scope);
  const attempt = (previous?.attempt ?? 0) + 1;
  const proposed = retryAtFrom(headers, now) ?? now + Math.min(FALLBACK_COOLDOWN_MS * 2 ** (attempt - 1), MAX_FALLBACK_COOLDOWN_MS);
  const retryAtMs = previous && previous.retryAtMs > now ? Math.max(previous.retryAtMs, proposed) : proposed;
  pauses.set(scope, { attempt, retryAtMs });
  return retryAtMs;
}

function recordSuccess(scope: string) {
  const pause = pauses.get(scope);
  if (pause && pause.retryAtMs <= clock()) pauses.delete(scope);
}

function isRateLimited(status: number, headers: Headers, body: string): boolean {
  return status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(body)));
}

function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_CAPACITY) cache.delete(cache.keys().next().value!);
}

async function send(path: string, cred: Credential, etag: string | null, write?: { method: string; body: unknown }): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "godmode-bot",
  };
  if (cred.token) headers.authorization = `Bearer ${cred.token}`;
  if (etag) headers["if-none-match"] = etag;
  if (write) headers["content-type"] = "application/json";
  try {
    return await fetchImpl(`${API}${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
    });
  } catch (err) {
    throw new GithubFailure("unreachable", `Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function read(path: string, opts: ReadOptions): Promise<Read> {
  const cred = await credential();
  const key = `${cred.scope}\0${path}`;
  const cached = cache.get(key);
  const ttlMs = cached ? (typeof opts.ttlMs === "number" ? opts.ttlMs : opts.ttlMs(cached.body)) : 0;
  if (cached && !opts.force && clock() - cached.at < ttlMs) return { body: cached.body, stale: false };
  try {
    return await withSlot(async () => {
      admit(cred.scope, opts.interactive);
      const res = await send(path, cred, cached?.etag ?? null);
      observe(cred.scope, res.headers);
      if (res.status === 304 && cached) {
        recordSuccess(cred.scope);
        remember(key, { ...cached, at: clock() });
        return { body: cached.body, stale: false };
      }
      if (res.ok) {
        const body = (await res.json()) as unknown;
        recordSuccess(cred.scope);
        remember(key, { etag: res.headers.get("etag"), body, at: clock() });
        return { body, stale: false };
      }
      const text = await res.text().catch(() => "");
      if (isRateLimited(res.status, res.headers, text)) {
        const retryAtMs = recordRateLimit(cred.scope, res.headers);
        throw new GithubFailure("rate_limited", "GitHub's rate limit is used up", retryAtMs);
      }
      if (res.status === 401) {
        heldToken = null;
        throw new GithubFailure("unauthorized", "GitHub refused this computer's GitHub login");
      }
      if (res.status === 404 || res.status === 403) throw new GithubFailure("not_found", "GitHub can't find this");
      throw new GithubFailure("failed", `GitHub answered HTTP ${res.status}`);
    });
  } catch (err) {
    const retryAtMs = err instanceof GithubPaused ? err.retryAtMs : err instanceof GithubFailure && err.kind === "rate_limited" ? err.retryAtMs : null;
    if (cached && (err instanceof GithubPaused || (err instanceof GithubFailure && (err.kind === "rate_limited" || err.kind === "unreachable")))) {
      return { body: cached.body, stale: true, ...(retryAtMs ? { retryAtMs } : {}) };
    }
    if (err instanceof GithubPaused) throw new GithubFailure("rate_limited", err.message, err.retryAtMs);
    throw err;
  }
}

async function readOptional(path: string, opts: ReadOptions): Promise<Read | null> {
  try {
    return await read(path, opts);
  } catch (err) {
    if (err instanceof GithubFailure && err.kind !== "unauthorized") return null;
    throw err;
  }
}

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function stateOf(pull: Json): PullRequestViewState {
  if (pull.merged === true || pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft === true ? "draft" : "open";
}

function isSettled(state: PullRequestViewState) {
  return state === "merged" || state === "closed";
}

function mergeableOf(pull: Json): PullRequestView["mergeable"] {
  switch (pull.mergeable_state) {
    case "dirty":
      return "conflicting";
    case "blocked":
      return "blocked";
    case "clean":
    case "unstable":
    case "has_hooks":
    case "behind":
      return "clean";
    default:
      return "unknown";
  }
}

function autoMergeOf(pull: Json): PullRequestAutoMerge | null {
  const auto = pull.auto_merge;
  if (!auto || typeof auto !== "object") return null;
  const raw = str(obj(auto).merge_method);
  const method = raw === "merge" || raw === "squash" || raw === "rebase" ? raw : "merge";
  return { method, enabledBy: str(obj(obj(auto).enabled_by).login) };
}

function checkRunState(run: Json): PullRequestCheckState {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "neutral":
    case "skipped":
    case "stale":
      return "neutral";
    default:
      return "failure";
  }
}

function statusState(status: Json): PullRequestCheckState {
  switch (status.state) {
    case "success":
      return "success";
    case "pending":
      return "pending";
    default:
      return "failure";
  }
}

export function checksOf(runs: unknown, combined: unknown): PullRequestCheck[] {
  const byName = new Map<string, PullRequestCheck & { at: string }>();
  for (const raw of arr(obj(runs).check_runs)) {
    const run = obj(raw);
    const name = str(run.name);
    if (!name) continue;
    const at = str(run.started_at) || str(run.completed_at);
    const previous = byName.get(name);
    if (previous && previous.at > at) continue;
    byName.set(name, { name, state: checkRunState(run), url: strOrNull(run.html_url) ?? strOrNull(run.details_url), at });
  }
  for (const raw of arr(obj(combined).statuses)) {
    const status = obj(raw);
    const name = str(status.context);
    if (!name || byName.has(name)) continue;
    byName.set(name, { name, state: statusState(status), url: strOrNull(status.target_url), at: str(status.updated_at) });
  }
  const order: Record<PullRequestCheckState, number> = { failure: 0, pending: 1, success: 2, neutral: 3 };
  return [...byName.values()]
    .map(({ name, state, url }) => ({ name, state, url }))
    .sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
}

export function reviewsOf(raw: unknown): PullRequestReview[] {
  const byAuthor = new Map<string, PullRequestReview>();
  for (const item of arr(raw)) {
    const review = obj(item);
    const user = obj(review.user);
    const author = str(user.login);
    if (!author) continue;
    const state = review.state === "APPROVED" ? "approved" : review.state === "CHANGES_REQUESTED" ? "changes_requested" : review.state === "COMMENTED" ? "commented" : null;
    if (!state) {
      if (review.state === "DISMISSED") byAuthor.delete(author);
      continue;
    }
    const previous = byAuthor.get(author);
    if (state === "commented" && previous && previous.state !== "commented") continue;
    byAuthor.set(author, { author, avatarUrl: strOrNull(user.avatar_url), state });
  }
  return [...byAuthor.values()];
}

function filesOf(raw: unknown): PullRequestFile[] {
  return arr(raw).map((item) => {
    const file = obj(item);
    return { path: str(file.filename), status: str(file.status), additions: num(file.additions), deletions: num(file.deletions) };
  });
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof GithubFailure) {
    const retryAt = err.retryAtMs ? new Date(err.retryAtMs).toISOString() : null;
    switch (err.kind) {
      case "rate_limited":
        return new HttpError(429, "GitHub's rate limit is used up for now", GithubErrorCode.RateLimited, { retryAt });
      case "not_found":
        return new HttpError(404, "GitHub can't find this pull request", GithubErrorCode.NotFound);
      case "unauthorized":
        return new HttpError(403, "GitHub refused this computer's GitHub login", GithubErrorCode.Unauthorized);
      case "unreachable":
        return new HttpError(502, err.message, GithubErrorCode.Unreachable);
      default:
        return new HttpError(502, err.message, GithubErrorCode.Unreachable);
    }
  }
  return new HttpError(502, err instanceof Error ? err.message : "GitHub failed", GithubErrorCode.Unreachable);
}

async function load(ref: PullRequestRef, opts: { interactive: boolean; force: boolean }): Promise<PullRequestView> {
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const pullRead = await read(`${base}/pulls/${ref.number}`, { ttlMs: (body) => (isSettled(stateOf(obj(body))) ? SETTLED_DETAIL_TTL_MS : DETAIL_TTL_MS), ...opts });
  const pull = obj(pullRead.body);
  const state = stateOf(pull);
  const settled = isSettled(state);
  const head = obj(pull.head);
  const sha = str(head.sha);
  const checksTtl = settled ? SETTLED_CHECKS_TTL_MS : CHECKS_TTL_MS;
  const sub = { interactive: opts.interactive, force: opts.force };
  const [runs, statuses, reviews, files, repo] = await Promise.all([
    sha ? readOptional(`${base}/commits/${sha}/check-runs?per_page=100`, { ttlMs: checksTtl, ...sub }) : null,
    sha ? readOptional(`${base}/commits/${sha}/status?per_page=100`, { ttlMs: checksTtl, ...sub }) : null,
    readOptional(`${base}/pulls/${ref.number}/reviews?per_page=100`, { ttlMs: settled ? SETTLED_DETAIL_TTL_MS : DETAIL_TTL_MS, ...sub }),
    readOptional(`${base}/pulls/${ref.number}/files?per_page=${FILES_PER_PAGE}`, { ttlMs: settled ? SETTLED_DETAIL_TTL_MS : DETAIL_TTL_MS, ...sub }),
    settled ? null : readOptional(base, { ttlMs: REPO_TTL_MS, ...sub }),
  ]);
  const repository = obj(repo?.body);
  const mergeMethods = (["merge", "squash", "rebase"] as const).filter((m) => repository[m === "merge" ? "allow_merge_commit" : `allow_${m}_merge`] !== false);
  const signedIn = !!(await credential()).token;
  const reads = [pullRead, runs, statuses, reviews, files].filter((r): r is Read => !!r);
  const stale = reads.some((r) => r.stale);
  const retryAtMs = Math.max(0, ...reads.map((r) => r.retryAtMs ?? 0));
  const user = obj(pull.user);
  return {
    ref,
    url: strOrNull(pull.html_url) ?? pullRequestUrl(ref),
    title: str(pull.title),
    state,
    author: str(user.login),
    authorAvatarUrl: strOrNull(user.avatar_url),
    body: str(pull.body),
    baseBranch: str(obj(pull.base).ref),
    headBranch: str(head.label) || str(head.ref),
    createdAt: str(pull.created_at),
    updatedAt: str(pull.updated_at),
    mergedAt: strOrNull(pull.merged_at),
    closedAt: strOrNull(pull.closed_at),
    additions: num(pull.additions),
    deletions: num(pull.deletions),
    changedFiles: num(pull.changed_files),
    commits: num(pull.commits),
    comments: num(pull.comments) + num(pull.review_comments),
    mergeable: settled ? "unknown" : mergeableOf(pull),
    labels: arr(pull.labels).map((l) => ({ name: str(obj(l).name), color: str(obj(l).color) })).filter((l) => l.name),
    checks: runs || statuses ? checksOf(runs?.body, statuses?.body) : null,
    reviews: reviews ? reviewsOf(reviews.body) : null,
    files: files ? filesOf(files.body) : null,
    fetchedAt: new Date(clock()).toISOString(),
    stale,
    retryAt: retryAtMs ? new Date(retryAtMs).toISOString() : null,
    signedIn,
    headSha: sha,
    mergeMethods: repo ? mergeMethods : [],
    canMerge: signedIn && !settled && !!repo && obj(repository.permissions).push === true,
    autoMerge: settled ? null : autoMergeOf(pull),
    autoMergeAllowed: !settled && repository.allow_auto_merge === true,
  };
}

export async function getPullRequest(ref: PullRequestRef, opts: { interactive?: boolean; force?: boolean } = {}): Promise<PullRequestView> {
  const interactive = opts.interactive ?? true;
  const force = !!opts.force;
  const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}${force ? "!" : ""}`;
  let flight = flights.get(key);
  if (!flight) {
    flight = load(ref, { interactive, force }).finally(() => flights.delete(key));
    flights.set(key, flight);
  }
  try {
    return await flight;
  } catch (err) {
    throw toHttpError(err);
  }
}

function forget(ref: PullRequestRef) {
  const marker = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/`;
  for (const key of [...cache.keys()]) if (key.includes(marker)) cache.delete(key);
}

function refusalOf(text: string): string {
  try {
    const parsed = obj(JSON.parse(text));
    return str(parsed.message) || str(obj(arr(parsed.errors)[0]).message);
  } catch {
    return "";
  }
}

async function writeGithub(ref: PullRequestRef, path: string, method: string, payload: unknown): Promise<unknown> {
  const cred = await credential();
  if (!cred.token) throw new HttpError(403, "Sign this computer in to GitHub first: run “gh auth login” in Terminal", GithubErrorCode.Unauthorized);
  try {
    return await withSlot(async () => {
      admit(cred.scope, true);
      const res = await send(path, cred, null, { method, body: payload });
      observe(cred.scope, res.headers);
      const text = await res.text().catch(() => "");
      if (res.ok) {
        recordSuccess(cred.scope);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      }
      if (isRateLimited(res.status, res.headers, text)) throw new GithubFailure("rate_limited", "GitHub's rate limit is used up", recordRateLimit(cred.scope, res.headers));
      if (res.status === 401) {
        heldToken = null;
        throw new GithubFailure("unauthorized", "GitHub refused this computer's GitHub login");
      }
      if (res.status === 404) throw new GithubFailure("not_found", "GitHub can't find this pull request");
      const message = res.status === 409 ? "The pull request changed since it was loaded. Look at the new changes, then merge again." : refusalOf(text);
      throw new HttpError(409, message || `GitHub refused it (HTTP ${res.status})`, GithubErrorCode.MergeRefused);
    });
  } catch (err) {
    if (err instanceof GithubPaused) throw toHttpError(new GithubFailure("rate_limited", err.message, err.retryAtMs));
    throw toHttpError(err);
  } finally {
    forget(ref);
  }
}

export async function mergePullRequest(ref: PullRequestRef, method: PullRequestMergeMethod, headSha: string): Promise<PullRequestView> {
  const path = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/merge`;
  await writeGithub(ref, path, "PUT", { merge_method: method, sha: headSha });
  log.info(`Merged ${ref.owner}/${ref.repo}#${ref.number} (${method})`);
  return getPullRequest(ref, { force: true });
}

const ENABLE_AUTO_MERGE = "mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }";
const DISABLE_AUTO_MERGE = "mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }";

export async function setAutoMerge(ref: PullRequestRef, method: PullRequestMergeMethod | null): Promise<PullRequestView> {
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  let id: string;
  try {
    id = str(obj((await read(`${base}/pulls/${ref.number}`, { ttlMs: DETAIL_TTL_MS, interactive: true })).body).node_id);
  } catch (err) {
    throw toHttpError(err);
  }
  if (!id) throw new HttpError(404, "GitHub can't find this pull request", GithubErrorCode.NotFound);
  const query = method ? ENABLE_AUTO_MERGE : DISABLE_AUTO_MERGE;
  const variables = method ? { id, method: method.toUpperCase() } : { id };
  const answer = obj(await writeGithub(ref, "/graphql", "POST", { query, variables }));
  const problem = str(obj(arr(answer.errors)[0]).message);
  if (problem) throw new HttpError(409, problem, GithubErrorCode.MergeRefused);
  log.info(`${method ? `Enabled auto-merge (${method})` : "Disabled auto-merge"} for ${ref.owner}/${ref.repo}#${ref.number}`);
  return getPullRequest(ref, { force: true });
}
