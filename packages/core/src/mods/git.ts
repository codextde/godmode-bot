/**
 * Plugins from git repositories. Each installed commit is a checkout of its own under
 * `<data>/plugins/git/<mod id>/<commit>/`, made with Godmode's hardened git (no prompts, no clone hooks), so a run that
 * loads one version keeps it while an update lays down the next. What a plugin brings — skills, commands, agents, hooks,
 * MCP servers — is read from its folder.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { ModContents } from "@godmode/shared";
import { githubRepoOf, isValidBranch, MOD_HOOKS_PATH, MOD_MANIFEST_PATH, MOD_NAME_RE, modNameFrom, parseGitUrl } from "@godmode/shared";
import { config } from "../config";
import { claudeEnv, resolveClaudeCommand } from "../runner/claude";
import { runCommand, stripAnsi } from "../services/doctor";
import { gitFailure, runGit } from "../services/workspaceSources";
import type { McpServerJson } from "../types";
import { badRequest, HttpError } from "../util";

const CLONE_TIMEOUT_MS = 10 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 30_000;
const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
/** Small files kept with the plugin's record: the options its manifest declares, and what the human reads on its page. */
const KEY_FILES = [MOD_MANIFEST_PATH, MOD_HOOKS_PATH, ".mcp.json"];
const KEY_FILE_MAX_BYTES = 100_000;
const MAX_WALK = 100_000;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Is `path` really inside Godmode's checkouts? A repository can ship links that lead anywhere on this computer: what
 * they point at is neither read nor listed.
 */
function contained(path: string): boolean {
  try {
    return realpathSync(path).startsWith(realpathSync(checkoutsRoot()) + sep);
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return contained(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/** Where a plugin comes from, as typed: "owner/repo", a GitHub link (`/tree/<ref>/<folder>` too) or a clone URL. */
export interface GitTarget {
  url: string;
  repo: string;
  web: string | null;
  ref: string | null;
  path: string;
}

export function cleanPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || !PATH_SEGMENT.test(s))) throw badRequest(`"${path}" isn't a folder of the repository`);
  return segments.join("/");
}

export function gitTarget(input: string, ref?: string | null): GitTarget {
  const raw = input.trim();
  if (!raw) throw badRequest("Enter a GitHub repository, e.g. owner/repo");
  if (ref && !isValidBranch(ref)) throw badRequest(`"${ref}" isn't a branch or tag name`);
  const repo = githubRepoOf(raw);
  if (repo) {
    // github.com/owner/repo/tree/<ref>/<folder>: a branch name with slashes can't be told from the folder, so the ref is one segment.
    const rest = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/tree\/([^/?#]+)((?:\/[^?#]*)?)/.exec(raw);
    let linked: { ref: string; path: string } | null = null;
    if (rest) {
      try {
        linked = { ref: decodeURIComponent(rest[1]!), path: decodeURIComponent(rest[2] ?? "") };
      } catch {
        throw badRequest("That link isn't a valid GitHub address.");
      }
      if (!isValidBranch(linked.ref)) throw badRequest(`"${linked.ref}" isn't a branch or tag name`);
    }
    return {
      url: `https://github.com/${repo}.git`,
      repo,
      web: `https://github.com/${repo}`,
      ref: ref || linked?.ref || null,
      path: linked?.path ? cleanPath(linked.path) : "",
    };
  }
  const parsed = parseGitUrl(raw);
  if ("error" in parsed) throw badRequest(parsed.error);
  const web = /^https:\/\//.test(parsed.url) ? parsed.url.replace(/\.git$/i, "") : null;
  return { url: parsed.url, repo: parsed.name, web, ref: ref || parsed.branch, path: "" };
}

export function checkoutsRoot(): string {
  return join(config().dataDir, "plugins", "git");
}

export function checkoutPath(modId: string, commit: string): string {
  return join(checkoutsRoot(), modId, commit.slice(0, 12));
}

export function pluginDirIn(checkout: string, path: string): string {
  return path ? join(checkout, ...path.split("/")) : checkout;
}

function gitError(res: Parameters<typeof gitFailure>[0], url: string, ref: string | null): HttpError {
  return new HttpError(502, gitFailure(res, url, ref), "git_failed");
}

/** The commit `ref` (default: the default branch) points at now. */
export async function latestCommit(url: string, ref: string | null): Promise<string> {
  // An annotated tag is an object of its own: "<tag>^{}" asks for the commit it names too.
  const res = await runGit(["ls-remote", "--", url, ...(ref ? [ref, `${ref}^{}`] : ["HEAD"])], { cwd: tmpdir(), timeoutMs: LS_REMOTE_TIMEOUT_MS });
  if (!res.ok) throw gitError(res, url, ref);
  const lines = res.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && /^[0-9a-f]{40,64}$/.test(parts[0]!));
  const pick = ref
    ? (lines.find(([, name]) => name === `refs/heads/${ref}`) ??
      lines.find(([, name]) => name === `refs/tags/${ref}^{}`) ??
      lines.find(([, name]) => name === `refs/tags/${ref}`) ??
      lines.find(([, name]) => name === ref))
    : lines.find(([, name]) => name === "HEAD");
  if (!pick) throw new HttpError(404, ref ? `The repository has no branch or tag "${ref}".` : "The repository is empty.", "git_failed");
  return pick[0];
}

/** Clone the newest commit of `ref` into `dest` (a folder that doesn't exist yet); returns that commit. */
export async function cloneLatest(url: string, ref: string | null, dest: string): Promise<string> {
  mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 });
  const args = (depth: boolean) => ["clone", "--quiet", "--no-tags", "--single-branch", ...(depth ? ["--depth", "1"] : []), ...(ref ? ["--branch", ref] : []), "--", url, dest];
  let res = await runGit(args(true), { cwd: tmpdir(), timeoutMs: CLONE_TIMEOUT_MS });
  // Servers that can't send part of the history (git's "dumb" HTTP) get asked for all of it.
  if (!res.ok && !res.timedOut && /shallow|dumb/i.test(res.stderr)) {
    rmSync(dest, { recursive: true, force: true });
    res = await runGit(args(false), { cwd: tmpdir(), timeoutMs: CLONE_TIMEOUT_MS });
  }
  if (!res.ok) {
    rmSync(dest, { recursive: true, force: true });
    throw gitError(res, url, ref);
  }
  const head = await runGit(["rev-parse", "HEAD"], { cwd: dest, timeoutMs: 10_000 });
  const commit = head.stdout.trim();
  if (!head.ok || !/^[0-9a-f]{40,64}$/.test(commit)) throw new HttpError(502, "The clone has no commit to install.", "git_failed");
  return commit;
}

/** Check out exactly `commit` into `dest`: a plugin whose checkout is gone (a restored backup, a runner) comes back as it was. */
export async function cloneAt(url: string, commit: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const opts = { cwd: dest, timeoutMs: CLONE_TIMEOUT_MS };
  const fetched =
    (await runGit(["init", "--quiet"], opts)).ok &&
    (await runGit(["fetch", "--quiet", "--depth", "1", "--", url, commit], opts)).ok &&
    (await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], opts)).ok;
  if (fetched) return;
  // Servers that don't hand out single commits: the whole history, then the commit.
  rmSync(dest, { recursive: true, force: true });
  const res = await runGit(["clone", "--quiet", "--no-checkout", "--", url, dest], { cwd: tmpdir(), timeoutMs: CLONE_TIMEOUT_MS });
  if (!res.ok) {
    rmSync(dest, { recursive: true, force: true });
    throw gitError(res, url, null);
  }
  const checkout = await runGit(["checkout", "--quiet", "--detach", commit], opts);
  if (!checkout.ok) {
    rmSync(dest, { recursive: true, force: true });
    throw new HttpError(502, `The repository no longer has the installed commit ${commit.slice(0, 7)}. Uninstall the plugin and install it again.`, "git_failed");
  }
}

/** A path a manifest names, inside `dir`; null when it leads out. */
function inside(dir: string, path: string): string | null {
  const full = resolve(dir, path);
  if (full !== dir && !full.startsWith(dir + sep)) return null;
  return !existsSync(full) || contained(full) ? full : null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const PLUGIN_PARTS = ["skills", "commands", "agents", "hooks/hooks.json", ".mcp.json"];

function looksLikePlugin(dir: string): boolean {
  return isFile(join(dir, ...MOD_MANIFEST_PATH.split("/"))) || PLUGIN_PARTS.some((part) => existsSync(join(dir, ...part.split("/"))));
}

export interface ResolvedPlugin {
  /** Its folder in the repository; "" is the root. */
  path: string;
  name: string;
  description: string;
  /** The manifest to lay into its folder when it ships none: Claude Code would name it after the folder otherwise. */
  manifest: Json | null;
}

/** What a marketplace entry may say in place of the plugin's own manifest. */
const LISTING_FIELDS = ["version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "commands", "agents", "hooks", "mcpServers", "userConfig"];

/**
 * Which plugin of the checkout to install: the one at `path` (a GitHub link can name a folder), else the root's own, else
 * the one the repository's marketplace lists (`plugin` names it when there are several).
 */
export function resolvePlugin(checkout: string, path: string, plugin: string | undefined, fallbackName: string): ResolvedPlugin {
  const base = pluginDirIn(checkout, path);
  if (!isDir(base) || !contained(base)) throw badRequest(`The repository has no folder "${path}".`);
  const market = readJson(join(base, ...MARKETPLACE_PATH.split("/")));
  const listed = (isObj(market) && Array.isArray(market.plugins) ? market.plugins : []).filter(isObj).filter((p) => typeof p.name === "string");
  const relative = (listing: Json) => (typeof listing.source === "string" ? inside(base, listing.source) : null);
  const local = listed.filter((p) => relative(p));
  const ownName = readName(base);
  const pathOf = (dir: string) => (dir === checkout ? "" : dir.slice(checkout.length + 1).split(sep).join("/"));

  let chosen: { dir: string; path: string; listing: Json | null };
  if (plugin && ownName === plugin) {
    chosen = { dir: base, path, listing: listed.find((p) => p.name === plugin && relative(p) === base) ?? null };
  } else if (plugin && listed.some((p) => p.name === plugin)) {
    const listing = listed.find((p) => p.name === plugin)!;
    const dir = relative(listing);
    if (!dir) throw badRequest(`"${plugin}" lives in another repository: install it from there.`);
    chosen = { dir, path: pathOf(dir), listing };
  } else if (plugin && (ownName !== null || listed.length > 0)) {
    throw badRequest(`The repository has no plugin "${plugin}".`);
  } else if (ownName !== null) {
    chosen = { dir: base, path, listing: listed.find((p) => relative(p) === base && p.name === ownName) ?? null };
  } else if (local.length === 1) {
    const dir = relative(local[0]!)!;
    chosen = { dir, path: pathOf(dir), listing: local[0]! };
  } else if (local.length > 1) {
    throw new HttpError(409, `This repository has ${local.length} plugins. Pick the one to install.`, "pick_plugin", {
      plugins: local.map((p) => ({ name: String(p.name), description: typeof p.description === "string" ? p.description : "" })),
    });
  } else if (listed.length > 0) {
    throw badRequest("The plugins this repository lists live in other repositories: install them from there.");
  } else if (looksLikePlugin(base)) {
    chosen = { dir: base, path, listing: null };
  } else {
    throw badRequest("No Claude Code plugin in this repository: it has no .claude-plugin/plugin.json, skills, commands or agents.");
  }
  if (!isDir(chosen.dir) || !contained(chosen.dir)) throw badRequest("No Claude Code plugin in that folder of the repository.");

  const manifest = readJson(join(chosen.dir, ...MOD_MANIFEST_PATH.split("/")));
  const declared = isObj(manifest) && typeof manifest.name === "string" ? manifest.name : null;
  const name = declared ?? (typeof chosen.listing?.name === "string" ? chosen.listing.name : MOD_NAME_RE.test(fallbackName) ? fallbackName : modNameFrom(fallbackName));
  if (!MOD_NAME_RE.test(name)) throw badRequest(`The plugin calls itself "${name}", a name Claude Code can't load: lowercase letters, digits and dashes.`);
  const description = isObj(manifest) && typeof manifest.description === "string" ? manifest.description : typeof chosen.listing?.description === "string" ? chosen.listing.description : "";
  let written: Json | null = null;
  if (declared === null) {
    // A plugin its marketplace describes, or one that is only folders: the manifest says what the entry says.
    written = { name };
    for (const field of LISTING_FIELDS) if (chosen.listing && chosen.listing[field] !== undefined) written[field] = chosen.listing[field];
    if (!looksLikePlugin(chosen.dir) && !["skills", "commands", "agents", "hooks", "mcpServers"].some((f) => written![f] !== undefined)) {
      throw badRequest("No Claude Code plugin in that folder of the repository.");
    }
  }
  return { path: chosen.path, name, description, manifest: written };
}

/** Lay the manifest of a plugin that ships none into its folder (see `ResolvedPlugin.manifest`). */
export function writeManifest(dir: string, manifest: Json): void {
  const file = join(dir, ...MOD_MANIFEST_PATH.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  // Never through a link the repository laid there.
  if (!contained(join(file, ".."))) throw badRequest("No Claude Code plugin in that folder of the repository.");
  rmSync(file, { force: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readName(dir: string): string | null {
  const manifest = readJson(join(dir, ...MOD_MANIFEST_PATH.split("/")));
  return isObj(manifest) && typeof manifest.name === "string" ? manifest.name : null;
}

/** The plugin's manifest, hooks and MCP config as text, for its record (options, and what its page shows). */
export function keyFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of KEY_FILES) {
    const file = join(dir, ...path.split("/"));
    try {
      // Not through a link: a repository could point one at any file of this computer, and the text is kept and shown.
      const s = lstatSync(file);
      if (s.isFile() && s.size <= KEY_FILE_MAX_BYTES && contained(file)) out[path] = readFileSync(file, "utf8");
    } catch {
      /* unreadable: left out */
    }
  }
  return out;
}

/** "./skills/x/" or ["./a", "./b"] → the folders or files, inside `dir`. */
function manifestPaths(dir: string, value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return list.map((p) => inside(dir, p)).filter((p): p is string => !!p);
}

function frontmatterName(file: string): string | null {
  try {
    if (!contained(file)) return null;
    const head = readFileSync(file, "utf8").slice(0, 4000);
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1];
    const name = front ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front)?.[1] : null;
    return name?.trim() || null;
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return contained(dir) ? readdirSync(dir).sort() : [];
  } catch {
    return [];
  }
}

function skillsIn(path: string, into: Set<string>) {
  if (isFile(join(path, "SKILL.md"))) {
    into.add(frontmatterName(join(path, "SKILL.md")) ?? basename(path));
    return;
  }
  for (const entry of list(path)) {
    const skill = join(path, entry, "SKILL.md");
    if (isFile(skill)) into.add(frontmatterName(skill) ?? entry);
  }
}

function markdownIn(path: string, into: Set<string>, depth = 0) {
  if (isFile(path)) {
    if (path.endsWith(".md")) into.add(frontmatterName(path) ?? basename(path, ".md"));
    return;
  }
  if (depth > 2) return;
  for (const entry of list(path)) {
    if (entry.startsWith(".") || /^readme\.md$/i.test(entry)) continue;
    const full = join(path, entry);
    if (isDir(full)) markdownIn(full, into, depth + 1);
    else if (entry.endsWith(".md")) into.add(depth === 0 ? basename(entry, ".md") : `${basename(path)}:${basename(entry, ".md")}`);
  }
}

/** Hook events a hooks file (or the manifest's inline `hooks`) runs something on; `modules` are function hooks. */
function hookEvents(value: unknown, into: Set<string>) {
  if (!isObj(value)) return;
  const hooks = isObj(value.hooks) ? value.hooks : "hooks" in value ? {} : value;
  for (const [event, entries] of Object.entries(hooks)) if (event !== "modules" && Array.isArray(entries) && entries.length) into.add(event);
}

function mcpNames(value: unknown, into: Set<string>) {
  if (!isObj(value)) return;
  const servers = isObj(value.mcpServers) ? value.mcpServers : value;
  for (const name of Object.keys(servers)) into.add(name);
}

/** What the plugin in `dir` brings, as Claude Code finds it: its default folders and what its manifest adds. */
export function inventory(dir: string): ModContents {
  const manifest = readJson(join(dir, ...MOD_MANIFEST_PATH.split("/")));
  const m = isObj(manifest) ? manifest : {};
  const skills = new Set<string>();
  const commands = new Set<string>();
  const agents = new Set<string>();
  const hooks = new Set<string>();
  const mcp = new Set<string>();
  for (const path of [join(dir, "skills"), ...manifestPaths(dir, m.skills)]) skillsIn(path, skills);
  for (const path of [join(dir, "commands"), ...manifestPaths(dir, m.commands)]) markdownIn(path, commands);
  for (const path of [join(dir, "agents"), ...manifestPaths(dir, m.agents)]) markdownIn(path, agents);

  const hookSources: unknown[] = [readJson(join(dir, ...MOD_HOOKS_PATH.split("/")))];
  for (const entry of Array.isArray(m.hooks) ? m.hooks : m.hooks === undefined ? [] : [m.hooks]) {
    if (typeof entry === "string") {
      const file = inside(dir, entry);
      if (file) hookSources.push(readJson(file));
    } else hookSources.push(entry);
  }
  for (const source of hookSources) hookEvents(source, hooks);

  const mcpSources: unknown[] = m.mcpServers === undefined ? [readJson(join(dir, ".mcp.json"))] : [];
  for (const entry of Array.isArray(m.mcpServers) ? m.mcpServers : m.mcpServers === undefined ? [] : [m.mcpServers]) {
    if (typeof entry === "string") {
      const file = inside(dir, entry);
      if (file) mcpSources.push(readJson(file));
    } else mcpSources.push(entry);
  }
  for (const source of mcpSources) mcpNames(source, mcp);

  let files = 0;
  let bytes = 0;
  const walk = (path: string) => {
    for (const entry of list(path)) {
      if (files >= MAX_WALK) return;
      if (entry === ".git") continue;
      const full = join(path, entry);
      let s;
      try {
        // Links aren't followed: one could lead out of the checkout, or back into it.
        s = lstatSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full);
      else if (s.isFile()) {
        files++;
        bytes += s.size;
      }
    }
  };
  walk(dir);

  // A command that is also a skill's name is one thing to the human.
  for (const skill of skills) commands.delete(skill);
  return {
    skills: [...skills].sort(),
    commands: [...commands].sort(),
    agents: [...agents].sort(),
    hooks: [...hooks],
    mcpServers: [...mcp].sort(),
    files,
    bytes,
    alwaysOnTokens: null,
  };
}

/** What Claude Code says the plugin adds to every session, in tokens (`claude plugin details`); null when it can't say. */
export async function alwaysOnTokens(dir: string, name: string): Promise<number | null> {
  const cmd = resolveClaudeCommand();
  if (!cmd) return null;
  const res = await runCommand([...cmd, "--plugin-dir", dir, "plugin", "details", name], { timeoutMs: 30_000, env: claudeEnv(), cwd: tmpdir() });
  const m = /Always-on:\s*~?\s*([\d.,]+)\s*(k)?\s*tok/i.exec(stripAnsi(res.stdout));
  if (!m) return null;
  const value = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** The version the manifest names at `commit`, read from GitHub without cloning; null elsewhere or when it can't. */
export async function remoteVersion(repo: string, web: string | null, path: string, commit: string): Promise<string | null> {
  if (!web?.startsWith("https://github.com/")) return null;
  const file = [path, MOD_MANIFEST_PATH].filter(Boolean).join("/");
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${file}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const manifest = (await res.json()) as unknown;
    return isObj(manifest) && typeof manifest.version === "string" ? manifest.version.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/** The plugin's version in its manifest. */
export function manifestVersion(dir: string): string | null {
  const manifest = readJson(join(dir, ...MOD_MANIFEST_PATH.split("/")));
  return isObj(manifest) && typeof manifest.version === "string" ? manifest.version.slice(0, 40) : null;
}

/** Does the plugin ship something Claude Code starts as a program? */
export function contentsStartPrograms(dir: string, contents: ModContents): boolean {
  return contents.hooks.length > 0 || contents.mcpServers.length > 0 || ["bin", "monitors", ".lsp.json"].some((p) => existsSync(join(dir, p)));
}

/** The file the validator reads: with a marketplace beside it, the folder alone would be checked as the marketplace. */
export function validateTarget(dir: string): string {
  const manifest = join(dir, ...MOD_MANIFEST_PATH.split("/"));
  return isFile(manifest) && isFile(join(dir, ...MARKETPLACE_PATH.split("/"))) ? manifest : dir;
}

function fill(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (whole, key: string) => (Object.hasOwn(vars, key) ? vars[key]! : whole));
}

function fillAll(record: unknown, vars: Record<string, string>): Record<string, string> | undefined {
  if (!isObj(record)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) if (typeof value === "string") out[key] = fill(value, vars);
  return out;
}

/**
 * The MCP servers the plugin in `dir` declares (`.mcp.json`, or what its manifest's `mcpServers` names), under the names
 * Claude Code gives them ("plugin_<plugin>_<server>", so their tools are `mcp__plugin_<plugin>_<server>__…` as the
 * plugin's own skills expect). Runs take their MCP servers from Godmode's config alone, so a plugin's go in there.
 */
export function pluginMcpServers(dir: string, plugin: string, dataDir: string, options: Record<string, unknown>): Record<string, McpServerJson> {
  const manifest = readJson(join(dir, ...MOD_MANIFEST_PATH.split("/")));
  const declared = isObj(manifest) ? manifest.mcpServers : undefined;
  const sources: unknown[] = declared === undefined ? [readJson(join(dir, ".mcp.json"))] : [];
  for (const entry of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
    if (typeof entry === "string") {
      const file = inside(dir, entry);
      if (file) sources.push(readJson(file));
    } else sources.push(entry);
  }
  const vars: Record<string, string> = { CLAUDE_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_DATA: dataDir };
  for (const [key, value] of Object.entries(options)) vars[`user_config.${key}`] = Array.isArray(value) ? value.join(",") : String(value);
  const out: Record<string, McpServerJson> = {};
  for (const source of sources) {
    if (!isObj(source)) continue;
    const servers = isObj(source.mcpServers) ? source.mcpServers : source;
    for (const [name, def] of Object.entries(servers)) {
      if (!isObj(def) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
      const id = `plugin_${plugin}_${name}`;
      if (typeof def.command === "string") {
        const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string").map((a) => fill(a, vars)) : undefined;
        out[id] = { command: fill(def.command, vars), ...(args ? { args } : {}), env: { ...fillAll(def.env, vars), CLAUDE_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_DATA: dataDir } };
      } else if (typeof def.url === "string" && (def.type === "http" || def.type === "sse")) {
        const headers = fillAll(def.headers, vars);
        out[id] = { type: def.type, url: fill(def.url, vars), ...(headers ? { headers } : {}) };
      }
    }
  }
  return out;
}
