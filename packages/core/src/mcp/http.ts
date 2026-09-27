/**
 * Godmode MCP gateway at POST /mcp — Streamable HTTP transport, stateless, JSON-RPC 2.0.
 * Authenticated with per-run bearer tokens (mcp/tokens.ts), never with the user's access token.
 * `tools/call` answers over SSE when the client accepts it, with keepalives, so long calls
 * (agent_delegate waiting for a peer) survive idle timeouts; everything else answers with JSON.
 */
import type { Context, Hono } from "hono";
import { VERSION } from "../config";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import type { RunContext } from "../types";
import { resolveRunToken } from "./tokens";
import { UnknownToolError, callTool, listToolsFor, toolErrorMessage } from "./tools";

const log = logger("mcp");

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const KEEPALIVE_MS = 15_000;

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

/** Handle one JSON-RPC message. Returns null for notifications and client responses (nothing to send). */
export async function handleRpc(ctx: RunContext, msg: unknown): Promise<JsonRpcResponse | null> {
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
        serverInfo: { name: "godmode", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok(id, {});
    case "tools/list": {
      try {
        return ok(id, { tools: listToolsFor(getAgent(ctx.agentId)) });
      } catch (err) {
        return rpcError(id, -32603, toolErrorMessage(err));
      }
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return rpcError(id, -32602, "Invalid params: missing tool name");
      try {
        return ok(id, await callTool(ctx, name, params.arguments ?? {}));
      } catch (err) {
        if (err instanceof UnknownToolError) return rpcError(id, -32602, err.message);
        log.error(`tools/call ${name} crashed`, err);
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

function disableIdleTimeout(c: Context) {
  try {
    const server = (c.env as { server?: { timeout?: (req: Request, seconds: number) => void } } | undefined)?.server;
    server?.timeout?.(c.req.raw, 0);
  } catch {
    /* not running under Bun.serve (tests) */
  }
}

/** Answer one tools/call over SSE: headers go out immediately, keepalive comments until the result is ready. */
function sseCall(ctx: RunContext, msg: unknown): Response {
  const encoder = new TextEncoder();
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
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      try {
        const response = await handleRpc(ctx, msg);
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

export function registerMcpRoutes(app: Hono): void {
  app.post("/mcp", async (c) => {
    const ctx = resolveRunToken(bearer(c));
    if (!ctx) return c.json(rpcError(null, -32001, "Unauthorized: invalid or expired run token"), 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      if (!body.length) return c.json(rpcError(null, -32600, "Invalid Request: empty batch"), 400);
      disableIdleTimeout(c);
      const responses = (await Promise.all(body.map((m) => handleRpc(ctx, m)))).filter((r): r is JsonRpcResponse => r !== null);
      return responses.length ? c.json(responses) : c.body(null, 202);
    }

    const accept = c.req.header("accept") ?? "";
    if (isObj(body) && body.method === "tools/call" && body.id !== undefined && body.id !== null && accept.includes("text/event-stream")) {
      disableIdleTimeout(c);
      return sseCall(ctx, body);
    }
    const response = await handleRpc(ctx, body);
    return response ? c.json(response) : c.body(null, 202);
  });

  // Stateless server: no server-initiated SSE stream and no sessions to terminate.
  app.get("/mcp", (c) => c.body(null, 405, { Allow: "POST, DELETE" }));
  app.delete("/mcp", (c) => c.body(null, 200));
}
