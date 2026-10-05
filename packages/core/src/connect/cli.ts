/**
 * `godmode mcp`, `godmode tools` and `godmode call`: the Godmode that runs on this computer, for apps and scripts outside
 * it. They talk to the running core's MCP gateway with a connected app's key (GODMODE_CONNECT_TOKEN) and never open the
 * database themselves.
 *
 * `godmode mcp` is an MCP server over stdio that passes every call on. It finds the core through `<data dir>/core.json`
 * on every call, so it keeps working when Godmode restarts on another port, and says so in plain words when Godmode
 * isn't running.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_TOKEN_ENV, GODMODE_MCP_NAME } from "@godmode/shared";
import { loadConfig, VERSION, type CoreConfig } from "../config";
import { CONNECT_INSTRUCTIONS } from "./instructions";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const WATCH_MS = 3000;
const NOT_RUNNING = "Godmode isn't running on this computer. Open the Godmode app, then try again.";
const KEY_REMOVED = "This key doesn't open Godmode anymore. Connect the app again in Godmode: Settings → Claude Code & MCP.";
const NO_KEY = `No key: create one in Godmode (Settings → Claude Code & MCP), then set ${CONNECT_TOKEN_ENV}.`;

export const USAGE = `  godmode mcp                         MCP server for Claude Code and other AI tools (stdio)
  godmode tools [<tool>]              What a connected app can do, or one tool's arguments
  godmode call <tool> [<json> | -]    Call one tool, e.g. godmode call agent_create '{"name":"Scout","role":"Research analyst"}'
                                      All three need ${CONNECT_TOKEN_ENV} (Settings → Claude Code & MCP) and a running Godmode;
                                      GODMODE_URL reaches one on another computer`;

/** What a serving core writes to `<data dir>/core.json`, and removes when it stops. */
interface CoreProcess {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

function coreFile(dataDir: string): string {
  return join(dataDir, "core.json");
}

export function writeCoreFile(cfg: CoreConfig): void {
  const info: CoreProcess = { pid: process.pid, port: cfg.port, startedAt: new Date().toISOString(), version: VERSION };
  writeFileSync(coreFile(cfg.dataDir), JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
}

/** Only its own: a core.json that names another process belongs to the Godmode that serves now. */
export function removeCoreFile(dataDir: string): void {
  if (runningCore(dataDir)?.pid === process.pid) rmSync(coreFile(dataDir), { force: true });
}

function runningCore(dataDir: string): CoreProcess | null {
  try {
    const info = JSON.parse(readFileSync(coreFile(dataDir), "utf8")) as CoreProcess;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;
/** `failed`: nothing usable came back. `down`: nothing answered at all (as opposed to an answer that refuses). */
type Reply = { kind: "answer"; body: unknown } | { kind: "none" } | { kind: "failed"; why: string; code: number; down: boolean };

const DOWN: Reply = { kind: "failed", why: NOT_RUNNING, code: -32000, down: true };

function gateway(dataDir: string): string | null {
  const remote = process.env.GODMODE_URL?.trim().replace(/\/+$/, "");
  if (remote) return remote.endsWith("/mcp") ? remote : `${remote}/mcp`;
  const core = runningCore(dataDir);
  return core ? `http://127.0.0.1:${core.port}/mcp` : null;
}

async function send(dataDir: string, token: string, message: unknown): Promise<Reply> {
  const url = gateway(dataDir);
  if (!url) return DOWN;
  // Godmode may quit while a long call is under way: a connection that breaks off is "not running", never a crash.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(message),
    });
    if (res.status === 401) return { kind: "failed", why: KEY_REMOVED, code: -32001, down: false };
    if (res.status === 202) return { kind: "none" };
    const text = await res.text();
    const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    const payload = sse ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) : text;
    const body: unknown = payload ? JSON.parse(payload) : null;
    // Only a JSON-RPC message goes back to the app; anything else (a proxy's page, a refusal of the core) is a failure.
    if (res.ok && isObj(body) && body.jsonrpc === "2.0") return { kind: "answer", body };
    const said = isObj(body) && typeof body.error === "string" ? body.error : isObj(body) && isObj(body.error) && typeof body.error.message === "string" ? body.error.message : `HTTP ${res.status}`;
    return { kind: "failed", why: `Godmode refused the request: ${said}`, code: -32000, down: false };
  } catch {
    return DOWN;
  }
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolError = (id: unknown, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

/** `godmode mcp`: answers the handshake itself, passes everything else on to the running core. */
async function mcp(dataDir: string, token: string): Promise<number> {
  const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
  let watching: ReturnType<typeof setInterval> | null = null;
  // The app got an empty tool list because Godmode was closed: tell it to ask again once Godmode answers.
  const watch = () => {
    watching ??= setInterval(async () => {
      if ((await send(dataDir, token, { jsonrpc: "2.0", id: "watch", method: "ping" })).kind !== "answer" || !watching) return;
      clearInterval(watching);
      watching = null;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }, WATCH_MS);
  };

  const handle = async (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return write(rpcError(null, -32700, "Parse error"));
    }
    if (!isObj(msg) || typeof msg.method !== "string") return;
    const id = msg.id ?? null;
    if (id === null) return;
    if (msg.method === "initialize") {
      const asked = isObj(msg.params) && typeof msg.params.protocolVersion === "string" ? msg.params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      return write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: asked,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: GODMODE_MCP_NAME, version: VERSION },
          instructions: CONNECT_INSTRUCTIONS,
        },
      });
    }
    if (msg.method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
    const reply = await send(dataDir, token, msg);
    if (reply.kind === "answer") return write(reply.body);
    if (reply.kind === "none") return;
    if (msg.method === "tools/call") return write(toolError(id, reply.why));
    if (msg.method === "tools/list" && reply.down) {
      watch();
      return write({ jsonrpc: "2.0", id, result: { tools: [] } });
    }
    write(rpcError(id, reply.code, reply.why));
  };

  const pending = new Set<Promise<unknown>>();
  for await (const line of console) {
    if (!line.trim()) continue;
    const work: Promise<unknown> = handle(line)
      .catch(() => undefined)
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
  if (watching) clearInterval(watching);
  return 0;
}

interface ToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** One request whose answer is the whole point: prints why there is none and returns null. */
async function ask(dataDir: string, token: string, method: string, params: Json, print: (line: string) => void): Promise<Json | null> {
  const reply = await send(dataDir, token, { jsonrpc: "2.0", id: 1, method, params });
  if (reply.kind !== "answer") {
    print(reply.kind === "failed" ? reply.why : "Godmode didn't answer.");
    return null;
  }
  const body = reply.body as { result?: Json; error?: { message?: string } };
  if (body.result) return body.result;
  print(body.error?.message ?? "Godmode didn't answer.");
  return null;
}

function firstSentence(text: string, max = 110): string {
  const sentence = /^.*?\.(?=\s|$)/.exec(text)?.[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

async function tools(dataDir: string, token: string, name: string | undefined, print: (line: string) => void): Promise<number> {
  const result = await ask(dataDir, token, "tools/list", {}, print);
  if (!result) return 1;
  const list = (result.tools ?? []) as ToolInfo[];
  if (!name) {
    for (const t of list) print(`${t.name.padEnd(26)} ${firstSentence(t.description)}`);
    return 0;
  }
  const tool = list.find((t) => t.name === name);
  if (!tool) {
    print(`No tool named ${name}. \`godmode tools\` lists them.`);
    return 1;
  }
  print(`${tool.name}\n\n${tool.description}\n\nArguments (JSON schema):\n${JSON.stringify(tool.inputSchema, null, 2)}`);
  return 0;
}

async function call(dataDir: string, token: string, name: string | undefined, input: string | undefined, print: (line: string) => void): Promise<number> {
  if (!name) {
    print("Usage: godmode call <tool> [<json> | -]");
    return 2;
  }
  let args: unknown;
  try {
    args = JSON.parse((input === "-" ? await Bun.stdin.text() : input)?.trim() || "{}");
  } catch {
    print("The arguments aren't valid JSON. Example: godmode call agent_get '{\"agentId\":\"godmode\"}'");
    return 2;
  }
  const result = await ask(dataDir, token, "tools/call", { name, arguments: args }, print);
  if (!result) return 1;
  for (const part of (result.content ?? []) as { text?: string }[]) if (part.text) print(part.text);
  return result.isError ? 1 : 0;
}

/** Runs `godmode <mcp|tools|call> <positionals…>` and resolves with the exit code. `dir`: `--data-dir`, when given. */
export async function runConnectCli(command: string, positionals: string[], dir?: string, print: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const { dataDir } = loadConfig(dir ? { dataDir: dir } : {});
  const token = process.env[CONNECT_TOKEN_ENV]?.trim();
  if (!token) {
    // On stdout an MCP client would read it as a broken message.
    if (command === "mcp") console.error(NO_KEY);
    else print(NO_KEY);
    return 2;
  }
  if (command === "mcp") return mcp(dataDir, token);
  if (command === "tools") return tools(dataDir, token, positionals[0], print);
  return call(dataDir, token, positionals[0], positionals[1], print);
}
