import type { Agent, McpApp, McpAppCsp } from "@godmode/shared";
import { logger } from "../log";
import { badRequest, forbidden, HttpError, notFound } from "../util";
import { getMcpServer, mcpServerForKey, mcpServerSecrets } from "./mcpServers";
import { initializeParams, withMcpConnection, type McpRequest } from "./mcpProbe";

const log = logger("mcp-apps");

export const MCP_APP_MIME = "text/html;profile=mcp-app";
const UI_EXTENSION = "io.modelcontextprotocol/ui";
const IDLE_MS = 10 * 60_000;
const REQUEST_MS = 60_000;
const CONNECT_MS = 30_000;
const MAX_TOOL_PAGES = 20;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; title?: string };
  _meta?: Record<string, unknown>;
}

interface Session {
  serverId: string;
  ready: Promise<McpRequest>;
  close: () => void;
  idle: ReturnType<typeof setTimeout> | null;
  tools: Promise<RawTool[]> | null;
  views: Map<string, Promise<ViewResource>>;
}

interface ViewResource {
  html: string;
  csp: McpAppCsp | null;
  permissions: McpApp["permissions"];
  prefersBorder: boolean | null;
}

const sessions = new Map<string, Session>();

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, `${what}: no answer within ${ms / 1000} seconds`, "mcp_timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function dropSession(serverId: string) {
  const s = sessions.get(serverId);
  if (!s) return;
  sessions.delete(serverId);
  if (s.idle) clearTimeout(s.idle);
  s.close();
}

function touch(s: Session) {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => dropSession(s.serverId), IDLE_MS);
}

function openSession(serverId: string): Session {
  const server = getMcpServer(serverId);
  const secrets = mcpServerSecrets(serverId);
  const controller = new AbortController();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let resolveReady!: (r: McpRequest) => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<McpRequest>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);
  const session: Session = {
    serverId,
    ready,
    close: () => {
      release();
      controller.abort();
    },
    idle: null,
    tools: null,
    views: new Map(),
  };
  withMcpConnection(
    { transport: server.transport, command: server.command, args: server.args, url: server.url, env: secrets.env, headers: secrets.headers },
    controller.signal,
    async (request, notify) => {
      await request("initialize", initializeParams({ extensions: { [UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } }));
      await notify("notifications/initialized");
      resolveReady(request);
      await released;
    },
  )
    .catch((err) => {
      rejectReady(err);
      log.info(`connection to MCP server "${server.name}" ended: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      if (sessions.get(serverId) === session) {
        sessions.delete(serverId);
        if (session.idle) clearTimeout(session.idle);
      }
    });
  return session;
}

function sessionFor(serverId: string): Session {
  let s = sessions.get(serverId);
  if (!s) {
    s = openSession(serverId);
    sessions.set(serverId, s);
  }
  touch(s);
  return s;
}

async function call(serverId: string, method: string, params: unknown): Promise<unknown> {
  const s = sessionFor(serverId);
  try {
    const request = await withTimeout(s.ready, CONNECT_MS, "Connecting to the MCP server");
    return await withTimeout(request(method, params), REQUEST_MS, method);
  } catch (err) {
    if (!(err instanceof Error && / failed: /.test(err.message))) dropSession(serverId);
    throw err instanceof HttpError ? err : new HttpError(502, err instanceof Error ? err.message : String(err), "mcp_error");
  }
}

function toolsOf(serverId: string): Promise<RawTool[]> {
  const s = sessionFor(serverId);
  s.tools ??= (async () => {
    const out: RawTool[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = ((await call(serverId, "tools/list", cursor ? { cursor } : {})) ?? {}) as { tools?: RawTool[]; nextCursor?: string };
      for (const t of r.tools ?? []) if (t && typeof t.name === "string") out.push(t);
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  })();
  s.tools.catch(() => {
    if (sessions.get(serverId) === s) s.tools = null;
  });
  return s.tools;
}

const uiMeta = (t: RawTool): { resourceUri?: unknown; visibility?: unknown } => {
  const meta = t._meta ?? {};
  const ui = (meta.ui ?? {}) as { resourceUri?: unknown; visibility?: unknown };
  return { resourceUri: ui.resourceUri ?? meta["ui/resourceUri"], visibility: ui.visibility };
};

function resourceUriOf(t: RawTool): string | null {
  const uri = uiMeta(t).resourceUri;
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : null;
}

function visibleTo(t: RawTool, who: "model" | "app"): boolean {
  const v = uiMeta(t).visibility;
  return !Array.isArray(v) || v.includes(who);
}

const ORIGIN_RE = /^(https|wss):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

function cleanDomains(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((d): d is string => typeof d === "string" && ORIGIN_RE.test(d.trim())).map((d) => d.trim());
  return out.length ? [...new Set(out)].slice(0, 50) : undefined;
}

export function cleanCsp(raw: unknown): McpAppCsp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const csp: McpAppCsp = {
    connectDomains: cleanDomains(r.connectDomains),
    resourceDomains: cleanDomains(r.resourceDomains),
    frameDomains: cleanDomains(r.frameDomains),
    baseUriDomains: cleanDomains(r.baseUriDomains),
  };
  return Object.values(csp).some(Boolean) ? csp : null;
}

function cleanPermissions(raw: unknown): McpApp["permissions"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<McpApp["permissions"]> = {};
  for (const k of ["camera", "microphone", "geolocation", "clipboardWrite"] as const) if (r[k] && typeof r[k] === "object") out[k] = {};
  return Object.keys(out).length ? out : null;
}

function viewOf(serverId: string, uri: string): Promise<ViewResource> {
  const s = sessionFor(serverId);
  let view = s.views.get(uri);
  if (!view) {
    view = (async () => {
      const r = ((await call(serverId, "resources/read", { uri })) ?? {}) as { contents?: { uri?: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }[] };
      const content = (r.contents ?? []).find((c) => !c.uri || c.uri === uri) ?? r.contents?.[0];
      if (!content) throw notFound("The view's resource");
      if (content.mimeType && !content.mimeType.replace(/\s/g, "").toLowerCase().startsWith("text/html")) throw badRequest(`Unsupported view type ${content.mimeType}`);
      const html = typeof content.text === "string" ? content.text : typeof content.blob === "string" ? Buffer.from(content.blob, "base64").toString("utf8") : "";
      if (!html) throw notFound("The view's HTML");
      if (html.length > MAX_HTML_BYTES) throw badRequest("The view is too large");
      const ui = ((content._meta ?? {}).ui ?? {}) as { csp?: unknown; permissions?: unknown; prefersBorder?: unknown };
      return { html, csp: cleanCsp(ui.csp), permissions: cleanPermissions(ui.permissions), prefersBorder: typeof ui.prefersBorder === "boolean" ? ui.prefersBorder : null };
    })();
    s.views.set(uri, view);
    view.catch(() => s.views.delete(uri));
  }
  return view;
}

export function splitToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

function serverIdFor(agent: Agent, key: string): string {
  const server = mcpServerForKey(agent, key);
  if (!server) throw notFound("MCP server");
  return server.id;
}

export async function appForTool(agent: Agent, toolName: string): Promise<McpApp | null> {
  const parts = splitToolName(toolName);
  if (!parts) return null;
  const server = mcpServerForKey(agent, parts.server);
  if (!server) return null;
  const tools = await toolsOf(server.id);
  const tool = tools.find((t) => t.name === parts.tool);
  const uri = tool && resourceUriOf(tool);
  if (!tool || !uri) return null;
  const view = await viewOf(server.id, uri);
  return {
    server: parts.server,
    tool: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations, _meta: tool._meta },
    uri,
    ...view,
    appTools: tools.filter((t) => visibleTo(t, "app")).map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true })),
  };
}

export async function callAppTool(agent: Agent, serverKey: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const serverId = serverIdFor(agent, serverKey);
  const tool = (await toolsOf(serverId)).find((t) => t.name === name);
  if (!tool) throw notFound(`Tool ${name}`);
  if (!visibleTo(tool, "app")) throw forbidden(`${name} isn't available to views`);
  return call(serverId, "tools/call", { name, arguments: args });
}

export async function readAppResource(agent: Agent, serverKey: string, uri: string): Promise<unknown> {
  return call(serverIdFor(agent, serverKey), "resources/read", { uri });
}

export function closeMcpAppSessions(): void {
  for (const id of [...sessions.keys()]) dropSession(id);
}
