/**
 * A secondary's app shows the primary's Godmode (owner: remote). While the primary is connected, every API request goes
 * there over the link — chats, agents, the board, automations, My tasks, the vault, settings — except what is about this
 * computer itself: its screens, VMs, phones, folders, logs, system checks, phone pairing, cloud link, licence and the
 * device group. The primary answers with everything it knows, chats of this computer included (it mirrors them and
 * forwards what concerns them back here).
 *
 * While the primary is away, this computer answers from what it has: its own chats work; the setup it copied is read
 * only, and the board and automations wait for the primary.
 *
 * Requests that came over a link are never forwarded: the primary asks this computer about its own chats that way.
 */
import type { Context, MiddlewareHandler } from "hono";
import { EXECUTABLE_SETTINGS } from "../backup/backup";
import { get } from "../db";
import { auditSettings } from "../services/agentSettings";
import { getSettings, updateSettings } from "../services/settings";
import { applyRuntimeSettings } from "../services/runtime";
import { checkSettingsPatch } from "../services/settingsPatch";
import { requestVia } from "../server/auth";
import { adoptGrant, requireGrant } from "../server/grants";
import { HttpError, badRequest } from "../util";
import { forwarding, isSecondary, primaryRunnerId } from "./group";
import { link } from "./runners";

/** Routes about this computer itself: answered here also while the primary is shown. */
const LOCAL: RegExp[] = [
  /^\/api\/health$/,
  /^\/api\/auth\//,
  /^\/api\/link\//,
  /^\/api\/devices(\/|$)/,
  /^\/api\/doctor(\/|$)/,
  /^\/api\/cleanup$/,
  /^\/api\/usage$/,
  /^\/api\/models$/,
  /^\/api\/computer\/(status|sources|thumbnail|permissions|cua\/)/,
  /^\/api\/vms(\/|$)/,
  /^\/api\/android(\/|$)/,
  /^\/api\/folders(\/|$)/,
  /^\/api\/files\/reveal$/,
  /^\/api\/logs(\/|$)/,
  /^\/api\/mobile(\/|$)/,
  /^\/api\/cloud(\/|$)/,
  /^\/api\/power(\/|$)/,
  /^\/api\/license(\/|$)/,
  /^\/api\/voice\//,
  /^\/api\/ssh\/local-keys$/,
  /^\/api\/browser\/(chrome-profiles|profile-use)/,
  /^\/api\/browser\/profiles\/[A-Za-z0-9_-]{1,100}\/(launch|stop|import|bot-check)$/,
];

/** Live view input: the chat's tab or a runner's screen goes to the primary, this computer's own screen stays. */
const BROWSER_INPUT = /^\/api\/browser\/profiles\/[A-Za-z0-9_-]{1,100}\/(input|navigate)$/;

/** Settings that describe this computer: kept and changed here, never the primary's. */
const OWN_SECTIONS = new Set(["server", "mobile", "cloud", "diagnostics", "maintenance", "android", "vm", "power"]);

/** While the primary is away: what this computer can still do with its own chats and copy. */
const OFFLINE_WRITES: RegExp[] = [
  /^\/api\/chat$/,
  /^\/api\/conversations(\/|$)/,
  /^\/api\/runs\/[A-Za-z0-9_-]{1,100}\/cancel$/,
  /^\/api\/questions\/[A-Za-z0-9_-]{1,100}\/answer$/,
  /^\/api\/notifications(\/|$)/,
  /^\/api\/vault\/(unlock|lock|grant)$/,
  /^\/api\/browser\/profiles\/[A-Za-z0-9_-]{1,100}\/(input|navigate)$/,
  /^\/api\/computer\/input$/,
];

const MAX_BODY = 64 * 1024 * 1024;

function viaLink(c: Context): boolean {
  return (c.env as { channel?: string } | undefined)?.channel === "runner-link";
}

function isLocal(path: string): boolean {
  return LOCAL.some((re) => re.test(path));
}

function primaryName(): string {
  const id = primaryRunnerId();
  return (id && get<{ name: string }>("SELECT name FROM runners WHERE id = ?", id)?.name) || "Your primary computer";
}

function offline(): HttpError {
  return new HttpError(409, `${primaryName()} (the primary of this device group) is offline. Changes to agents, logins, settings, the board and automations wait until it's back.`, "primary_offline");
}

async function bodyBytes(c: Context): Promise<Uint8Array | undefined> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return undefined;
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY) throw new HttpError(413, "That is too large to send to the primary computer.", "too_large");
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

function pathAndQuery(c: Context): string {
  const url = new URL(c.req.url);
  return url.pathname + url.search;
}

function primary() {
  const id = primaryRunnerId();
  if (!id) throw offline();
  try {
    const l = link(id);
    l.assertOnline();
    return l;
  } catch {
    throw offline();
  }
}

async function forward(c: Context, body?: Uint8Array | string): Promise<Response> {
  const headers: Record<string, string> = {};
  const type = c.req.header("content-type");
  if (type) headers["content-type"] = type;
  const grant = c.req.header("x-godmode-grant");
  if (grant) headers["x-godmode-grant"] = grant;
  const res = await primary().request(c.req.method, pathAndQuery(c), { body: body ?? (await bodyBytes(c)), headers, timeoutMs: 180_000 });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) out.set(k, v);
  return new Response(res.status === 204 || res.status === 304 ? null : (res.body as Uint8Array<ArrayBuffer>), { status: res.status, headers: out });
}

async function forwardJson<T>(c: Context, body?: string): Promise<{ status: number; data: T | null; raw: Response }> {
  const raw = await forward(c, body);
  const text = await raw.clone().text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: raw.status, data, raw };
}

/** This computer's own sections (and the fields that name its programs) on top of the primary's settings. */
function withOwnSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const mine = getSettings() as unknown as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = { ...settings };
  for (const section of OWN_SECTIONS) if (section in mine) out[section] = section === "server" ? { ...(settings.server as object), ...mine.server } : mine[section];
  for (const [section, fields] of Object.entries(EXECUTABLE_SETTINGS)) {
    if (OWN_SECTIONS.has(section) || !out[section] || typeof out[section] !== "object") continue;
    const next = { ...(out[section] as Record<string, unknown>) };
    for (const field of fields) if (mine[section] && field in mine[section]) next[field] = mine[section][field];
    out[section] = next;
  }
  return out;
}

/** A settings change: this computer's part is applied here, the rest on the primary. */
async function putSettings(c: Context): Promise<Response> {
  const patch = await jsonBody(c);
  if (!patch) throw badRequest("Invalid JSON body");
  const own: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(patch)) {
    if (OWN_SECTIONS.has(section)) {
      own[section] = value;
      continue;
    }
    const fields = EXECUTABLE_SETTINGS[section];
    if (fields && value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      const mine = Object.fromEntries(Object.entries(v).filter(([k]) => fields.includes(k)));
      const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !fields.includes(k)));
      if (Object.keys(mine).length) own[section] = mine;
      if (Object.keys(rest).length) shared[section] = rest;
    } else shared[section] = value;
  }
  if (Object.keys(own).length) {
    checkSettingsPatch(own, () => requireGrant(c));
    const before = getSettings();
    const next = updateSettings(own as never);
    auditSettings("user", before, next, Object.keys(own), requestVia(c));
    applyRuntimeSettings(next);
  }
  let settings: Record<string, unknown> = getSettings() as unknown as Record<string, unknown>;
  if (Object.keys(shared).length) {
    const res = await forwardJson<Record<string, unknown>>(c, JSON.stringify(shared));
    if (res.status >= 400 || !res.data) return res.raw;
    settings = res.data;
  } else {
    const res = await primary().json<Record<string, unknown>>("GET", "/api/settings");
    settings = res;
  }
  return c.json(withOwnSettings(settings));
}

async function forwarded(c: Context): Promise<Response | null> {
  const path = c.req.path;
  const method = c.req.method;

  if (path === "/api/settings") {
    if (method === "PUT") return putSettings(c);
    const res = await forwardJson<Record<string, unknown>>(c);
    return res.status < 400 && res.data ? c.json(withOwnSettings(res.data)) : res.raw;
  }
  if (path === "/api/bootstrap" && method === "GET") {
    const res = await forwardJson<Record<string, unknown>>(c);
    if (res.status >= 400 || !res.data) return res.raw;
    const local = await localBootstrap(c);
    return c.json({ ...res.data, ...local, settings: withOwnSettings((res.data.settings ?? {}) as Record<string, unknown>) });
  }
  if (BROWSER_INPUT.test(path) && method === "POST") {
    const body = await jsonBody(c);
    const chat = typeof body?.conversationId === "string" ? body.conversationId : null;
    if (!chat || ownChat(chat)) return null;
    return forward(c, JSON.stringify(body));
  }
  if (path === "/api/computer/input" && method === "POST") {
    const body = await jsonBody(c);
    if (typeof body?.view !== "string" || !body.view.startsWith("runner:")) return null;
    return forward(c, JSON.stringify(body));
  }
  if (path === "/api/vault/grant" && method === "POST") {
    const res = await forwardJson<{ grant?: string; expiresAt?: string }>(c, JSON.stringify(await jsonBody(c)));
    if (res.status < 400 && res.data?.grant && res.data.expiresAt) adoptGrant(res.data.grant, res.data.expiresAt);
    return res.raw;
  }
  if (isLocal(path)) return null;
  return forward(c);
}

/** A chat that lives on this computer (the primary only mirrors it). */
function ownChat(conversationId: string): boolean {
  return !!get<{ id: string }>("SELECT id FROM conversations WHERE id = ? AND runner_id IS NULL", conversationId);
}

/** What the bootstrap says about this computer (not the primary): its program, data folder and platform. */
async function localBootstrap(c: Context): Promise<Record<string, unknown>> {
  const { config } = await import("../config");
  const { homedir } = await import("node:os");
  const cfg = config();
  void c;
  return { version: cfg.version, mode: cfg.mode, dataDir: cfg.dataDir, homeDir: homedir(), platform: cfg.platform };
}

/** Hono middleware for /api/*, before the runner routing. */
export const deviceRouting: MiddlewareHandler = async (c, next) => {
  if (viaLink(c) || !isSecondary()) return next();
  if (forwarding()) {
    const answer = await forwarded(c);
    return answer ?? next();
  }
  // The primary is away: reading works from this computer's copy, changing what is shared waits.
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || isLocal(c.req.path) || OFFLINE_WRITES.some((re) => re.test(c.req.path))) return next();
  throw offline();
};
