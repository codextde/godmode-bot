/**
 * Godmode MCP gateway at POST /mcp — Streamable HTTP transport, stateless, JSON-RPC 2.0.
 * Authenticated with per-run bearer tokens (mcp/tokens.ts) or, on `/mcp` only, the key of a connected app
 * (connect/connectors.ts) — never with the user's access token.
 * `tools/call` answers over SSE when the client accepts it, with keepalives, so long calls
 * (agent_delegate waiting for a peer) survive idle timeouts: progress notifications when the call carries a
 * progressToken (Claude Code aborts a tool that sends neither a response nor progress for 5 minutes), comments
 * otherwise. Everything else answers with JSON.
 */
import type { Context, Hono } from "hono";
import { VERSION } from "../config";
import { excerpt, logger } from "../log";
import { getAgent } from "../agents/service";
import type { RunContext } from "../types";
import { resolveRunToken } from "./tokens";
import { connectorContext } from "../connect/connectors";
import { CONNECT_INSTRUCTIONS } from "../connect/instructions";
import { deliverQueued, pauseAtStep } from "../runner/runner";
import { hasQueued } from "../services/messageQueue";
import { denyReason, foreignBrowserCall } from "../browser/cdpGuard";
import { chatLeaseUrl } from "../browser/proxy";
import { UnknownToolError, callTool, listToolsFor, toolErrorMessage } from "./tools";
import { COMPUTER_INSTRUCTIONS, UnknownComputerToolError, callComputerTool, listComputerTools } from "../computer/tools";
import { UnknownVmToolError, VM_INSTRUCTIONS, callVmTool, listVmTools } from "../vm/tools";
import { SSH_INSTRUCTIONS, UnknownSshToolError, callSshTool, listSshTools } from "../ssh/tools";

const log = logger("mcp");

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
let keepaliveMs = 15_000;
const SLOW_TOOL_MS = 10_000;

function toolResultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).join(" ").trim();
  return excerpt(text, 500);
}

const INSTRUCTIONS =
  "Godmode tools for this agent: log in to websites with vault_list_logins → vault_fill_login → vault_fill_totp " +
  "(secrets are typed into the browser by Godmode; you never see them), report missing or broken logins with " +
  "report_missing_login, notify the human with notify_user, and work with other agents when permitted.";

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function idOf(msg: unknown): JsonRpcId {
  if (isObj(msg) && (typeof msg.id === "string" || typeof msg.id === "number")) return msg.id;
  return null;
}

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * One MCP server behind the gateway: `/mcp` (Godmode tools), `/mcp/computer` (computer use), `/mcp/vm` (macOS VM) or
 * `/mcp/ssh` (SSH servers).
 */
export interface McpServerDef {
  name: string;
  instructions: string;
  list: (ctx: RunContext) => { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call: (ctx: RunContext, name: string, args: unknown) => Promise<unknown>;
  isUnknownTool: (err: unknown) => boolean;
}

export const GODMODE_SERVER: McpServerDef = {
  name: "godmode",
  instructions: INSTRUCTIONS,
  list: (ctx) => listToolsFor(getAgent(ctx.agentId), ctx),
  call: callTool,
  isUnknownTool: (err) => err instanceof UnknownToolError,
};

/** The same gateway as an app outside Godmode sees it: the management tools, introduced for a reader that isn't an agent. */
const CONNECT_SERVER: McpServerDef = { ...GODMODE_SERVER, instructions: CONNECT_INSTRUCTIONS };

export const COMPUTER_SERVER: McpServerDef = {
  name: "computer",
  instructions: COMPUTER_INSTRUCTIONS,
  list: listComputerTools,
  call: callComputerTool,
  isUnknownTool: (err) => err instanceof UnknownComputerToolError,
};

export const VM_SERVER: McpServerDef = {
  name: "vm",
  instructions: VM_INSTRUCTIONS,
  list: listVmTools,
  call: callVmTool,
  isUnknownTool: (err) => err instanceof UnknownVmToolError,
};

export const SSH_SERVER: McpServerDef = {
  name: "ssh",
  instructions: SSH_INSTRUCTIONS,
  list: listSshTools,
  call: callSshTool,
  isUnknownTool: (err) => err instanceof UnknownSshToolError,
};

/** Handle one JSON-RPC message. Returns null for notifications and client responses (nothing to send). */
export async function handleRpc(ctx: RunContext, msg: unknown, server: McpServerDef = GODMODE_SERVER): Promise<JsonRpcResponse | null> {
  if (!isObj(msg)) return rpcError(null, -32600, "Invalid Request");
  if (typeof msg.method !== "string") {
    // A response to a server→client request (we never send any) — ignore.
    if ("result" in msg || "error" in msg) return null;
    return rpcError(idOf(msg), -32600, "Invalid Request");
  }
  if (msg.jsonrpc !== "2.0") return rpcError(idOf(msg), -32600, "Invalid Request: jsonrpc must be \"2.0\"");
  const isNotification = !("id" in msg) || msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  const id = idOf(msg);
  const params = isObj(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: VERSION },
        instructions: server.instructions,
      });
    case "ping":
      return ok(id, {});
    case "tools/list": {
      try {
        return ok(id, { tools: server.list(ctx) });
      } catch (err) {
        return rpcError(id, -32603, toolErrorMessage(err));
      }
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return rpcError(id, -32602, "Invalid params: missing tool name");
      const started = performance.now();
      const tool = `${server.name}.${name}`;
      try {
        const result = await server.call(ctx, name, params.arguments ?? {});
        const ms = Math.round(performance.now() - started);
        if (isObj(result) && result.isError === true) log.info("tool call returned an error", { tool, ms, runId: ctx.runId, error: toolResultText(result) });
        else if (ms >= SLOW_TOOL_MS) log.info("slow tool call", { tool, ms, runId: ctx.runId });
        else log.debug("tool call", { tool, ms, runId: ctx.runId });
        return ok(id, result);
      } catch (err) {
        if (server.isUnknownTool(err)) {
          log.warn("unknown tool called", { tool, runId: ctx.runId });
          return rpcError(id, -32602, err instanceof Error ? err.message : String(err));
        }
        log.error(`tools/call ${name} crashed`, { err, tool, ms: Math.round(performance.now() - started), runId: ctx.runId });
        return rpcError(id, -32603, toolErrorMessage(err));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function bearer(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

const waiting = new WeakSet<Request>();

/** The request waits for something that takes its time (a VM, a download, git): slow by design, the log says so. */
export function expectSlow(c: Context) {
  waiting.add(c.req.raw);
}

export function isExpectedSlow(c: Context): boolean {
  return waiting.has(c.req.raw);
}

/** Long requests (tool calls, VM boots, downloads) must not be cut off by Bun's idle timeout. */
export function disableIdleTimeout(c: Context) {
  expectSlow(c);
  try {
    const server = (c.env as { server?: { timeout?: (req: Request, seconds: number) => void } } | undefined)?.server;
    server?.timeout?.(c.req.raw, 0);
  } catch {
    /* not running under Bun.serve (tests) */
  }
}

export function __setKeepaliveForTests(ms: number | null) {
  keepaliveMs = ms ?? 15_000;
}

function progressTokenOf(msg: unknown): string | number | null {
  const meta = isObj(msg) && isObj(msg.params) && isObj(msg.params._meta) ? msg.params._meta : null;
  const token = meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : null;
}

/** Answer one tools/call over SSE: headers go out immediately, keepalives until the result is ready. */
function sseCall(ctx: RunContext, msg: unknown, server: McpServerDef): Response {
  const encoder = new TextEncoder();
  const progressToken = progressTokenOf(msg);
  const started = Date.now();
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      send(": godmode\n\n");
      let beats = 0;
      keepalive = setInterval(() => {
        if (progressToken === null) return send(": keepalive\n\n");
        const seconds = Math.round((Date.now() - started) / 1000);
        const params = { progressToken, progress: ++beats, message: `Still working (${seconds}s)` };
        send(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params })}\n\n`);
      }, keepaliveMs);
      try {
        const response = await handleRpc(ctx, msg, server);
        if (response) send(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      } finally {
        if (keepalive) clearInterval(keepalive);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

async function serve(c: Context, server: McpServerDef): Promise<Response> {
  const token = bearer(c);
  const ctx = resolveRunToken(token) ?? (server === GODMODE_SERVER ? connectorContext(token) : null);
  if (!ctx) return c.json(rpcError(null, -32001, "Unauthorized: invalid or expired run token"), 401);
  if (ctx.connector) server = CONNECT_SERVER;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    if (!body.length) return c.json(rpcError(null, -32600, "Invalid Request: empty batch"), 400);
    disableIdleTimeout(c);
    const responses = (await Promise.all(body.map((m) => handleRpc(ctx, m, server)))).filter((r): r is JsonRpcResponse => r !== null);
    return responses.length ? c.json(responses) : c.body(null, 202);
  }

  const accept = c.req.header("accept") ?? "";
  if (isObj(body) && body.method === "tools/call" && body.id !== undefined && body.id !== null && accept.includes("text/event-stream")) {
    disableIdleTimeout(c);
    return sseCall(ctx, body, server);
  }
  const response = await handleRpc(ctx, body, server);
  return response ? c.json(response) : c.body(null, 202);
}

export function registerMcpRoutes(app: Hono): void {
  app.post("/mcp", (c) => serve(c, GODMODE_SERVER));
  app.post("/mcp/computer", (c) => serve(c, COMPUTER_SERVER));
  app.post("/mcp/vm", (c) => serve(c, VM_SERVER));
  app.post("/mcp/ssh", (c) => serve(c, SSH_SERVER));

  // Claude Code's PostToolBatch hook: between two steps of a run, stop it when it is being paused, else hand over the
  // messages waiting in the chat's queue.
  app.post("/mcp/hooks/post-tool-batch", async (c) => {
    const ctx = resolveRunToken(bearer(c));
    if (!ctx) return c.body(null, 401);
    const input: unknown = await c.req.json().catch(() => null);
    // A subagent's steps: the pause and the message are for the agent itself, at its own next step.
    if (isObj(input) && input.agent_id) return c.body(null, 204);
    const stop = pauseAtStep(ctx.runId);
    if (stop) return c.json({ continue: false, stopReason: stop === "question" ? "Waiting for the human's answer" : "Paused" });
    if (!hasQueued(ctx.conversationId)) return c.body(null, 204);
    const additionalContext = deliverQueued(ctx.runId);
    if (!additionalContext) return c.body(null, 204);
    return c.json({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext } });
  });

  // Claude Code's PreToolUse hook: a run stays in the browser profile resolved for it — no scripts driving another
  // Godmode browser through its raw DevTools port.
  app.post("/mcp/hooks/pre-tool-use", async (c) => {
    const ctx = resolveRunToken(bearer(c));
    if (!ctx) return c.body(null, 401);
    const input: unknown = await c.req.json().catch(() => null);
    if (!isObj(input) || typeof input.tool_name !== "string" || !isObj(input.tool_input)) return c.body(null, 204);
    const why = foreignBrowserCall(input.tool_name, input.tool_input, typeof input.cwd === "string" ? input.cwd : undefined);
    if (!why) return c.body(null, 204);
    log.warn(`run ${ctx.runId}: refused ${input.tool_name} reaching another browser (${why})`);
    return c.json({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(why, !!chatLeaseUrl(ctx.runId)) },
    });
  });

  // Stateless servers: no server-initiated SSE stream and no sessions to terminate.
  for (const path of ["/mcp", "/mcp/computer", "/mcp/vm", "/mcp/ssh"]) {
    app.get(path, (c) => c.body(null, 405, { Allow: "POST, DELETE" }));
    app.delete(path, (c) => c.body(null, 200));
  }
}
