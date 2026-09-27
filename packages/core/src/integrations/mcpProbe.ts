/**
 * "Test connection" for custom MCP servers: connect with the stored config, run the MCP handshake
 * (initialize → notifications/initialized → tools/list) and report the tool names.
 *
 *  - stdio: spawn the command, newline-delimited JSON-RPC over stdin/stdout
 *  - http:  Streamable HTTP (POST, JSON or SSE responses, Mcp-Session-Id)
 *  - sse:   legacy HTTP+SSE (GET event stream → `endpoint` event → POST messages there)
 */
import type { Subprocess } from "bun";
import type { McpTransport } from "@godmode/shared";
import { VERSION } from "../config";
import { logger } from "../log";
import { childEnv, HttpError } from "../util";
import { getMcpServer, mcpServerSecrets } from "./mcpServers";

const log = logger("mcp-probe");

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const PROBE_TIMEOUT_MS = 25_000;
const MAX_TOOL_PAGES = 20;
const STDERR_TAIL = 4_000;

export interface ProbeResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

export interface ProbeTarget {
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

class ProbeError extends Error {}

const initializeParams = () => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "godmode-bot", version: VERSION },
});

function rpcError(method: string, msg: JsonRpcMessage): ProbeError {
  const e = msg.error ?? {};
  return new ProbeError(`${method} failed: ${e.message ?? "unknown error"}${e.code !== undefined ? ` (code ${e.code})` : ""}`);
}

function toolNames(result: unknown): { names: string[]; nextCursor: string | null } {
  const r = (result ?? {}) as { tools?: { name?: unknown }[]; nextCursor?: unknown };
  const names = Array.isArray(r.tools) ? r.tools.map((t) => (typeof t?.name === "string" ? t.name : "")).filter(Boolean) : [];
  return { names, nextCursor: typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : null };
}

/** Run initialize + tools/list over any request function. */
async function handshake(
  request: (method: string, params?: unknown) => Promise<unknown>,
  notify: (method: string, params?: unknown) => Promise<void>,
): Promise<{ tools: string[]; protocolVersion: string }> {
  const init = (await request("initialize", initializeParams())) as { protocolVersion?: string } | null;
  const protocolVersion = typeof init?.protocolVersion === "string" ? init.protocolVersion : MCP_PROTOCOL_VERSION;
  await notify("notifications/initialized");
  const tools: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const { names, nextCursor } = toolNames(await request("tools/list", cursor ? { cursor } : {}));
    tools.push(...names);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { tools, protocolVersion };
}

/* ------------------------------------------------------------------ */
/* SSE parsing                                                          */
/* ------------------------------------------------------------------ */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse a text/event-stream body into events (WHATWG rules: event/data/id fields, blank line dispatches). */
export async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  let done = false;
  const takeLine = (): string | null => {
    const idx = buf.search(/[\r\n]/);
    if (idx < 0) return null;
    // A trailing CR may be the first half of CRLF — wait for more input unless the stream ended.
    if (buf[idx] === "\r" && idx === buf.length - 1 && !done) return null;
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + (buf[idx] === "\r" && buf[idx + 1] === "\n" ? 2 : 1));
    return line;
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        buf += decoder.decode();
        // Lenient EOF: treat an unterminated last line as complete.
        if (buf && !/[\r\n]$/.test(buf)) buf += "\n";
      } else {
        buf += decoder.decode(chunk.value, { stream: true });
      }
      for (let line = takeLine(); line !== null; line = takeLine()) {
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n"), id };
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
    }
    // Servers that close the stream right after the last `data:` line still get their event delivered.
    if (data.length) yield { event: event || "message", data: data.join("\n"), id };
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Iterate a byte stream (DOM lib typings lack ReadableStream async iteration). */
async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseMessages(text: string): JsonRpcMessage[] {
  try {
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* stdio                                                                */
/* ------------------------------------------------------------------ */

function resolveCommand(command: string, env: Record<string, string | undefined>): string {
  if (/[\\/]/.test(command)) return command;
  const found = Bun.which(command, { PATH: env.PATH ?? env.Path ?? process.env.PATH ?? "" });
  if (!found) throw new ProbeError(`Command not found: ${command}. Make sure it is installed and on the PATH of the Godmode core.`);
  return found;
}

async function probeStdio(target: ProbeTarget, signal: AbortSignal): Promise<string[]> {
  // Never hand Godmode's own variables (e.g. GODMODE_TOKEN) to user-configured MCP servers.
  const env = childEnv(target.env ?? {});
  const cmd = resolveCommand(target.command ?? "", env);
  let proc: Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([cmd, ...(target.args ?? [])], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (err) {
    throw new ProbeError(`Could not start ${target.command}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of chunks(proc.stderr)) {
      stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
    }
  })().catch(() => undefined);

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  let closedError: Error | null = null;
  const failAll = (err: Error) => {
    closedError ??= err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const write = (msg: JsonRpcMessage) => {
    if (closedError) throw closedError;
    proc.stdin.write(JSON.stringify(msg) + "\n");
    const flushed = proc.stdin.flush();
    if (flushed instanceof Promise) flushed.catch(() => undefined);
  };

  const readerDone = (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of chunks(proc.stdout)) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{") && !line.startsWith("[")) continue; // servers sometimes log to stdout
        for (const msg of parseMessages(line)) {
          if (msg.method && msg.id !== undefined && msg.id !== null) {
            // Server → client request: answer ping, decline everything else.
            try {
              write(
                msg.method === "ping"
                  ? { jsonrpc: "2.0", id: msg.id, result: {} }
                  : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by probe" } },
              );
            } catch {
              /* process is gone */
            }
            continue;
          }
          if (typeof msg.id !== "number") continue;
          const p = pending.get(msg.id);
          if (!p) continue;
          pending.delete(msg.id);
          if (msg.error) p.reject(rpcError(p.method, msg));
          else p.resolve(msg.result);
        }
      }
    }
  })()
    .catch(() => undefined)
    .finally(async () => {
      const code = await Promise.race([proc.exited, Bun.sleep(500).then(() => null)]);
      await Promise.race([stderrDone, Bun.sleep(200)]);
      const tail = stderr.trim().split("\n").slice(-8).join("\n");
      failAll(new ProbeError(`MCP server exited${code !== null ? ` with code ${code}` : ""} before answering${tail ? `: ${tail}` : ""}`));
    });

  let nextId = 1;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new ProbeError(`No response within ${PROBE_TIMEOUT_MS / 1000} seconds`));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  abortPromise.catch(() => undefined);

  const request = (method: string, params?: unknown) => {
    const id = nextId++;
    const p = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject, method }));
    write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return Promise.race([p, abortPromise]);
  };
  const notify = async (method: string, params?: unknown) => {
    write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  };

  try {
    const { tools } = await handshake(request, notify);
    return tools;
  } finally {
    // Graceful shutdown per spec: close stdin, then SIGTERM, then SIGKILL.
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    if ((await Promise.race([proc.exited, Bun.sleep(1_000).then(() => null)])) === null) {
      proc.kill();
      if ((await Promise.race([proc.exited, Bun.sleep(2_000).then(() => null)])) === null) proc.kill(9);
    }
    await Promise.race([readerDone, Bun.sleep(500)]);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

/** fetch that follows same-origin redirects only (headers may carry secrets). */
async function fetchSameOrigin(url: string, init: RequestInit): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
    const next = new URL(res.headers.get("location")!, current);
    await res.body?.cancel().catch(() => undefined);
    if (next.origin !== new URL(current).origin) {
      throw new ProbeError(`The server redirected to another origin (${next.origin}). Update the URL to the final endpoint.`);
    }
    current = next.toString();
  }
  throw new ProbeError("Too many redirects");
}

async function httpFailure(res: Response, transport: McpTransport): Promise<ProbeError> {
  const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
  if (res.status === 401) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (/resource_metadata|bearer/i.test(challenge)) {
      return new ProbeError(
        "Unauthorized (HTTP 401): this server expects a Bearer token. Add an Authorization header (e.g. an API key or personal access token); interactive OAuth sign-in is not supported.",
      );
    }
    return new ProbeError("Unauthorized (HTTP 401): check the server's headers / API key.");
  }
  if (res.status === 403) return new ProbeError(`Forbidden (HTTP 403)${body ? `: ${body}` : ""}`);
  if (transport === "http" && (res.status === 404 || res.status === 405)) {
    return new ProbeError(
      `HTTP ${res.status}: the URL does not accept MCP POST requests. Check the path, or switch the transport to SSE for legacy servers.`,
    );
  }
  return new ProbeError(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* Streamable HTTP                                                      */
/* ------------------------------------------------------------------ */

async function probeHttp(target: ProbeTarget, signal: AbortSignal): Promise<string[]> {
  const url = target.url ?? "";
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 1;

  const headersFor = () => {
    const h = new Headers(target.headers ?? {});
    h.set("content-type", "application/json");
    h.set("accept", "application/json, text/event-stream");
    if (sessionId) h.set("mcp-session-id", sessionId);
    if (protocolVersion) h.set("mcp-protocol-version", protocolVersion);
    return h;
  };

  const post = async (msg: JsonRpcMessage): Promise<Response> => {
    const res = await fetchSameOrigin(url, { method: "POST", headers: headersFor(), body: JSON.stringify(msg), signal });
    if (!res.ok) throw await httpFailure(res, "http");
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    return res;
  };

  const request = async (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const res = await post({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    const type = res.headers.get("content-type") ?? "";
    let reply: JsonRpcMessage | undefined;
    if (type.includes("text/event-stream")) {
      if (!res.body) throw new ProbeError(`${method}: empty event stream`);
      for await (const ev of sseEvents(res.body)) {
        if (ev.event !== "message") continue;
        reply = parseMessages(ev.data).find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
        if (reply) break;
      }
    } else {
      const text = await res.text();
      reply = parseMessages(text).find((m) => m.id === id);
      if (!reply && text.trim()) throw new ProbeError(`${method}: the server did not return JSON-RPC (${text.slice(0, 120)})`);
    }
    if (!reply) throw new ProbeError(`${method}: the server closed the response without answering`);
    if (reply.error) throw rpcError(method, reply);
    return reply.result;
  };

  const notify = async (method: string, params?: unknown) => {
    const res = await post({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    await res.body?.cancel().catch(() => undefined);
  };

  try {
    const init = (await request("initialize", initializeParams())) as { protocolVersion?: string } | null;
    protocolVersion = typeof init?.protocolVersion === "string" ? init.protocolVersion : MCP_PROTOCOL_VERSION;
    await notify("notifications/initialized");
    const tools: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const { names, nextCursor } = toolNames(await request("tools/list", cursor ? { cursor } : {}));
      tools.push(...names);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return tools;
  } finally {
    if (sessionId) {
      // Terminate the session (best effort, don't wait long).
      const h = headersFor();
      h.delete("content-type");
      void fetch(url, { method: "DELETE", headers: h, redirect: "manual", signal: AbortSignal.timeout(3_000) })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Legacy HTTP+SSE                                                      */
/* ------------------------------------------------------------------ */

async function probeSse(target: ProbeTarget, signal: AbortSignal): Promise<string[]> {
  const url = target.url ?? "";
  const streamHeaders = new Headers(target.headers ?? {});
  streamHeaders.set("accept", "text/event-stream");
  // The event stream gets its own abort switch: a generator blocked in read() can only be released by aborting.
  const stream = new AbortController();
  const onAbort = () => stream.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let events: AsyncGenerator<SseEvent> | null = null;
  try {
    const res = await fetchSameOrigin(url, { method: "GET", headers: streamHeaders, signal: stream.signal });
    if (!res.ok) throw await httpFailure(res, "sse");
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      throw new ProbeError("The server did not open an event stream. Check the URL, or switch the transport to HTTP.");
    }
    events = sseEvents(res.body);
    const ev = events;
    let endpoint: string | null = null;
    while (!endpoint) {
      const next = await ev.next();
      if (next.done) throw new ProbeError("The event stream closed before the server announced its message endpoint");
      if (next.value.event === "endpoint") endpoint = new URL(next.value.data.trim(), url).toString();
    }
    if (new URL(endpoint).origin !== new URL(url).origin) {
      throw new ProbeError(`The server announced a message endpoint on another origin (${new URL(endpoint).origin})`);
    }
    const messageUrl = endpoint;

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
    void (async () => {
      for (;;) {
        const next = await ev.next();
        if (next.done) break;
        if (next.value.event !== "message") continue;
        for (const msg of parseMessages(next.value.data)) {
          if (typeof msg.id !== "number") continue;
          const p = pending.get(msg.id);
          if (!p) continue;
          pending.delete(msg.id);
          if (msg.error) p.reject(rpcError(p.method, msg));
          else p.resolve(msg.result);
        }
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        for (const p of pending.values()) p.reject(new ProbeError("The event stream closed before the server answered"));
        pending.clear();
      });

    const send = async (msg: JsonRpcMessage) => {
      const h = new Headers(target.headers ?? {});
      h.set("content-type", "application/json");
      const r = await fetchSameOrigin(messageUrl, { method: "POST", headers: h, body: JSON.stringify(msg), signal });
      if (!r.ok) throw await httpFailure(r, "sse");
      await r.body?.cancel().catch(() => undefined);
    };
    let nextId = 1;
    const request = async (method: string, params?: unknown) => {
      const id = nextId++;
      const p = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject, method }));
      p.catch(() => undefined);
      await send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      return p;
    };
    const notify = (method: string, params?: unknown) => send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });

    const { tools } = await handshake(request, notify);
    return tools;
  } finally {
    signal.removeEventListener("abort", onAbort);
    stream.abort();
    events?.return(undefined).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Entry points                                                         */
/* ------------------------------------------------------------------ */

/** Mask env/header values in error text (same minimum length as the vault's redaction). */
function redactValues(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("••••••••");
  return out;
}

/** Probe an MCP server config (not necessarily saved). Never throws. */
export async function probeMcpTarget(target: ProbeTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProbeError(`No response within ${timeoutMs / 1000} seconds`)), timeoutMs);
  const secrets = [...Object.values(target.env ?? {}), ...Object.values(target.headers ?? {})];
  try {
    const run =
      target.transport === "stdio"
        ? probeStdio(target, controller.signal)
        : target.transport === "http"
          ? probeHttp(target, controller.signal)
          : probeSse(target, controller.signal);
    const timeout = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new ProbeError(`No response within ${timeoutMs / 1000} seconds`)), { once: true }),
    );
    const tools = await Promise.race([run, timeout]);
    run.catch(() => undefined);
    return { ok: true, tools: [...new Set(tools)].sort() };
  } catch (err) {
    let message: string;
    if (err instanceof ProbeError) message = err.message;
    else if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) message = `No response within ${timeoutMs / 1000} seconds`;
    else if (err instanceof Error) message = `Connection failed: ${err.message}`;
    else message = String(err);
    return { ok: false, error: redactValues(message, secrets) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Probe a saved MCP server by id. Throws 404 for unknown ids and 423 when its secrets need the locked vault. */
export async function probeMcpServer(id: string): Promise<ProbeResult> {
  const server = getMcpServer(id);
  let secrets: { env: Record<string, string>; headers: Record<string, string> };
  try {
    secrets = mcpServerSecrets(id);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return { ok: false, error: "Could not decrypt the server's secrets" };
  }
  const result = await probeMcpTarget({
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env: secrets.env,
    headers: secrets.headers,
  });
  if (!result.ok) log.info(`probe of MCP server "${server.name}" failed: ${result.error}`);
  return result;
}
