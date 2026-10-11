/**
 * Requests about a chat on a runner go to the runner (owner: remote).
 *
 * The UI talks to this computer as always; this middleware recognises the requests that concern a runner's chat (or its
 * runs, its browser tab, the runner's screen) and forwards them over the link, so the runner — where the chat lives —
 * answers. It runs after authentication: phones and dashboards were already checked like for any other request. What
 * only makes sense here (pinning and archiving a chat) stays here.
 */
import type { Context, MiddlewareHandler } from "hono";
import { parseRunnerView, type ConversationWithMessages, type Run } from "@godmode/shared";
import { get, run as sql } from "../db";
import { logger } from "../log";
import { conversationExists, deleteConversation, emitConversationUpdated, getConversation, messageWindow, windowConversation } from "../services/conversations";
import { HttpError, badRequest } from "../util";
import { requireLicense } from "../license/license";
import { reconcileConversation } from "./mirror";
import { chatIsMoving, getRunner, link, prepareRemoteMessage, runnerOfConversation } from "./runners";

const log = logger("routing");

const CHAT = /^\/api\/conversations\/([A-Za-z0-9_-]{1,100})(\/.*)?$/;
const RUN = /^\/api\/runs\/([A-Za-z0-9_-]{1,100})(\/cancel|\/log)?$/;
const BROWSER = /^\/api\/browser\/profiles\/[A-Za-z0-9_-]{1,100}\/(input|navigate)$/;
const PROXY = /^\/api\/runners\/([A-Za-z0-9_-]{1,100})\/proxy(\/.*)$/;
/** Chat sub-routes the runner answers. `files` resolves the paths in its messages on its own disk. */
const FORWARDED = /^\/(messages|queue\/send|queue\/[A-Za-z0-9_-]{1,100}|pause|continue|retry|followup|followup\/run|files)$/;
/** Chat sub-routes that start a new run on the runner (continuing a paused one isn't new work). */
const STARTS_RUN = /^\/(messages|retry|followup\/run|queue\/send)$/;
const MAX_BODY = 64 * 1024 * 1024;
/** Reading a chat or run from a runner that answers this slowly falls back to the copy here. */
const READ_TIMEOUT_MS = 30_000;

/** What the slow-request log calls a request this middleware answered (Hono would only say `/api/*`). */
const labels = new WeakMap<Request, string>();

export function forwardedRoute(c: Context): string | undefined {
  return labels.get(c.req.raw);
}

function label(c: Context, route: string) {
  labels.set(c.req.raw, `runner ${route}`);
}

function runnerOfRun(runId: string): string | null {
  return get<{ runner_id: string | null }>("SELECT c.runner_id FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ?", runId)?.runner_id ?? null;
}

/** The body as bytes (once; Hono caches it, so later handlers can still read it). */
async function bodyBytes(c: Context): Promise<Uint8Array | undefined> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return undefined;
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY) throw new HttpError(413, "That is too large to send to the runner.", "too_large");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return bytes.byteLength ? bytes : undefined;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Forward the request as it is (method, path and query, content type, body) and answer with what the runner says. */
async function forward(c: Context, runnerId: string, path: string, body?: Uint8Array | string, timeoutMs = 180_000): Promise<Response> {
  const l = link(runnerId);
  const headers: Record<string, string> = {};
  const type = c.req.header("content-type");
  if (type) headers["content-type"] = type;
  const grant = c.req.header("x-godmode-grant");
  if (grant) headers["x-godmode-grant"] = grant;
  const res = await l.request(c.req.method, path, { body: body ?? (await bodyBytes(c)), headers, timeoutMs });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) out.set(k, v);
  return new Response(res.status === 204 || res.status === 304 ? null : (res.body as Uint8Array<ArrayBuffer>), { status: res.status, headers: out });
}

function pathAndQuery(c: Context): string {
  const url = new URL(c.req.url);
  return url.pathname + url.search;
}

function offlineAnswer(runnerId: string): HttpError {
  let name = "The runner";
  try {
    name = getRunner(runnerId).name;
  } catch {
    /* removed meanwhile */
  }
  return new HttpError(409, `${name} is offline — the chat continues when it's back.`, "runner_offline");
}

function isOffline(err: unknown): boolean {
  return err instanceof HttpError && err.code === "runner_offline";
}

function isUnanswered(err: unknown): boolean {
  return isOffline(err) || (err instanceof HttpError && err.code === "runner_timeout");
}

async function fetchConversation(runnerId: string, id: string): Promise<ConversationWithMessages> {
  const l = link(runnerId);
  const path = encodeURIComponent(id);
  const [remote, runs] = await Promise.all([
    l.json<ConversationWithMessages>("GET", `/api/conversations/${path}`, undefined, { timeoutMs: READ_TIMEOUT_MS }),
    l.json<Run[]>("GET", `/api/runs?conversationId=${path}&limit=50`, undefined, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined),
  ]);
  return reconcileConversation(runnerId, remote, runs);
}

/**
 * The UI asks for a chat again on every message event, and each answer carries the whole chat over the link. Who asks
 * while a fetch runs shares the one that follows it (the running one may predate what the asker saw): at most two per
 * chat at a time, however often it is asked.
 */
const fetches = new Map<string, { running: Promise<ConversationWithMessages>; next: Promise<ConversationWithMessages> | null }>();

function freshConversation(runnerId: string, id: string): Promise<ConversationWithMessages> {
  const key = `${runnerId}:${id}`;
  const start = (): Promise<ConversationWithMessages> => {
    const entry = { running: fetchConversation(runnerId, id), next: null as Promise<ConversationWithMessages> | null };
    fetches.set(key, entry);
    void entry.running
      .catch(() => {})
      .finally(() => {
        if (fetches.get(key) === entry && !entry.next) fetches.delete(key);
      });
    return entry.running;
  };
  const current = fetches.get(key);
  if (!current) return start();
  current.next ??= current.running.catch(() => {}).then(start);
  return current.next;
}

async function conversationRequest(c: Context, runnerId: string, id: string, rest: string): Promise<Response | null> {
  const method = c.req.method;
  if (!rest) {
    if (method === "GET") {
      label(c, "GET /api/conversations/:id");
      try {
        return c.json(windowConversation(await freshConversation(runnerId, id), messageWindow((name) => c.req.query(name))));
      } catch (err) {
        // Offline, too slow, or the runner no longer has it (deleted there, or set up again): the copy here is what there is.
        if (!isUnanswered(err) && !(err instanceof HttpError && err.status === 404)) throw err;
        return c.json(getConversation(id, messageWindow((name) => c.req.query(name))));
      }
    }
    if (method === "PATCH") {
      const patch = await jsonBody(c);
      if (!patch) throw badRequest("Invalid JSON body");
      if (patch.workingDirectory !== undefined || patch.computerTarget !== undefined) {
        throw badRequest("Folders and shared screens of this computer aren't available for chats on a runner");
      }
      const { pinned, archived, ...remote } = patch;
      if (typeof pinned === "boolean" || typeof archived === "boolean") {
        if (typeof pinned === "boolean") sql("UPDATE conversations SET pinned = ? WHERE id = ?", pinned ? 1 : 0, id);
        if (typeof archived === "boolean") sql("UPDATE conversations SET archived = ? WHERE id = ?", archived ? 1 : 0, id);
        emitConversationUpdated(id);
      }
      if (Object.keys(remote).length) {
        const answer = await forward(c, runnerId, pathAndQuery(c), JSON.stringify(remote));
        if (!answer.ok) return answer;
        try {
          const l = link(runnerId);
          reconcileConversation(runnerId, await l.json<ConversationWithMessages>("GET", `/api/conversations/${encodeURIComponent(id)}`));
        } catch (err) {
          log.warn(`could not refresh conversation ${id} after a change`, err instanceof Error ? err.message : err);
        }
      }
      return c.json(getConversation(id));
    }
    if (method === "DELETE") {
      try {
        await link(runnerId).json("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
      } catch (err) {
        log.info(`the runner didn't delete conversation ${id}`, { error: err instanceof Error ? err.message : String(err) });
      }
      // The copy here goes either way. The runner's `conversation.deleted` travels ahead of its answer on the same
      // link, so the mirror may have removed it already.
      if (conversationExists(id)) await deleteConversation(id);
      return c.json({ ok: true as const });
    }
    return null;
  }
  // Pages of older messages and pictures come from the copy here: the runner's chat was just mirrored for its window.
  if (method === "GET" && rest.startsWith("/messages")) return null;
  if (!FORWARDED.test(rest)) return null;
  if (method === "POST" && (STARTS_RUN.test(rest) || rest === "/continue") && chatIsMoving(id)) {
    throw new HttpError(409, "This chat is moving to this computer — send it again in a moment.", "runner_chat_moving");
  }
  if (method === "POST" && STARTS_RUN.test(rest)) requireLicense();
  // Both start a run there: the runner gets what it needs for it first.
  if ((rest === "/messages" || rest === "/retry") && method === "POST") await prepareRemoteMessage(id);
  label(c, `${method} /api/conversations/:id${rest.replace(/\/[A-Za-z0-9_-]{16,}$/, "/:id")}`);
  return forward(c, runnerId, pathAndQuery(c));
}

/**
 * Hono middleware for /api/*: forwards what concerns a runner's chat, its runs, its browser tab, the runner's screen,
 * and the explicit proxy route. Everything else passes through untouched.
 */
export const remoteRouting: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  try {
    const proxy = PROXY.exec(path);
    if (proxy) {
      const [, runnerId, rest] = proxy;
      label(c, `${c.req.method} /api/runners/:id/proxy`);
      const url = new URL(c.req.url);
      return await forward(c, runnerId!, `/api${rest}${url.search}`);
    }

    const chat = CHAT.exec(path);
    if (chat) {
      const runnerId = runnerOfConversation(chat[1]!);
      if (runnerId) {
        const answer = await conversationRequest(c, runnerId, chat[1]!, chat[2] ?? "");
        if (answer) return answer;
      }
      return next();
    }

    const runMatch = RUN.exec(path);
    if (runMatch) {
      const runnerId = runnerOfRun(runMatch[1]!);
      if (!runnerId) return next();
      const reading = c.req.method === "GET";
      label(c, `${c.req.method} /api/runs/:id${runMatch[2] ?? ""}`);
      try {
        return await forward(c, runnerId, pathAndQuery(c), undefined, reading ? READ_TIMEOUT_MS : undefined);
      } catch (err) {
        // Reading a run works from the copy while the runner is away or slow; stopping it doesn't.
        if (reading && isUnanswered(err)) return next();
        throw err;
      }
    }

    if (path === "/api/files/image" && c.req.query("runner")) {
      const url = new URL(c.req.url);
      const runnerId = url.searchParams.get("runner")!;
      url.searchParams.delete("runner");
      return await forward(c, runnerId, `/api/files/image${url.search}`);
    }

    if (BROWSER.test(path) && c.req.method === "POST") {
      const body = await jsonBody(c);
      const conversationId = typeof body?.conversationId === "string" ? body.conversationId : null;
      const runnerId = conversationId ? runnerOfConversation(conversationId) : null;
      if (runnerId) return await forward(c, runnerId, pathAndQuery(c), JSON.stringify(body));
      return next();
    }

    if (path === "/api/computer/input" && c.req.method === "POST") {
      const body = await jsonBody(c);
      const remote = typeof body?.view === "string" ? parseRunnerView(body.view) : null;
      if (remote) return await forward(c, remote.runnerId, path, JSON.stringify({ ...body, view: remote.view }));
      return next();
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === "runner_offline") {
      const runnerId = PROXY.exec(path)?.[1] ?? (CHAT.exec(path) ? runnerOfConversation(CHAT.exec(path)![1]!) : null);
      throw runnerId ? offlineAnswer(runnerId) : err;
    }
    throw err;
  }
  return next();
};
