#!/usr/bin/env bun
/**
 * Fake `claude` CLI for runner tests. Speaks the same protocol as `claude -p --output-format stream-json`:
 * prompt on stdin, stream-json events on stdout, honoring --session-id / --resume.
 *
 * Behaviour is chosen by keywords in the prompt:
 *   (default)   replay stream-partial.jsonl       → "Hello, nice to meet you!"
 *   USE_TOOL    replay stream-tooluse.jsonl       → Bash tool + "DONE"
 *   SLEEP       emit init, then hang (cancel / timeout tests)
 *   LOGIN_FAIL  answer with a login-failure sentence
 *   CALL_MCP    call the Godmode MCP gateway from --mcp-config (initialize, tools/list, report_missing_login)
 *   CRASH       print to stderr and exit 3 without a result
 *
 * Env: FAKE_CLAUDE_STATE — directory for known sessions + an invocation log (invocations.jsonl).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argValue = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
};

const stateDir = process.env.FAKE_CLAUDE_STATE ?? join(tmpdir(), "godmode-fake-claude");
mkdirSync(join(stateDir, "sessions"), { recursive: true });

const prompt = await new Response(Bun.stdin.stream()).text();
const resume = argValue("--resume");
const sessionId = resume ?? argValue("--session-id") ?? crypto.randomUUID();

appendFileSync(
  join(stateDir, "invocations.jsonl"),
  JSON.stringify({ args, prompt, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, GODMODE_TOKEN: process.env.GODMODE_TOKEN ?? null } }) + "\n",
);

const out = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (resume && !existsSync(join(stateDir, "sessions", resume))) {
  const msg = `No conversation found with session ID: ${resume}`;
  out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, duration_ms: 0, total_cost_usd: 0, session_id: resume, errors: [msg] });
  process.stderr.write(msg + "\n");
  process.exit(1);
}
writeFileSync(join(stateDir, "sessions", sessionId), "");

const init = { type: "system", subtype: "init", session_id: sessionId, model: "fake-model", tools: [], mcp_servers: [] };

async function replay(fixture: string) {
  const lines = readFileSync(join(import.meta.dir, fixture), "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if ("session_id" in event) event.session_id = sessionId;
    out(event);
    await pause(3);
  }
}

function result(text: string, extra: Record<string, unknown> = {}) {
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.001,
    duration_ms: 42,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    ...extra,
  });
}

function textTurn(text: string) {
  out({ type: "assistant", message: { id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: sessionId });
}

if (prompt.includes("CRASH")) {
  process.stderr.write("fatal: something exploded\n");
  process.exit(3);
} else if (prompt.includes("SLEEP")) {
  out(init);
  textTurn("Working on it");
  await pause(60_000);
  result("woke up");
} else if (prompt.includes("LOGIN_FAIL")) {
  out(init);
  const text = "I opened the dashboard. I couldn't log in to example.com because there are no saved credentials for it.";
  textTurn(text);
  result(text);
} else if (prompt.includes("CALL_MCP")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown, accept = "application/json, text/event-stream") => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: accept }, body: JSON.stringify(body) });
    const type = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (type.includes("text/event-stream")) {
      const data = raw.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(data!.slice(6));
    }
    return raw ? JSON.parse(raw) : null;
  };
  const initRes = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const call = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "report_missing_login", arguments: { service: "Example", url: "https://example.com/login", kind: "missing_credential", reason: "No saved login" } },
  });
  const summary = {
    server: initRes.result.serverInfo.name,
    tools: (list.result.tools as { name: string }[]).map((t) => t.name).length,
    call: call.result.content[0].text as string,
  };
  out({ type: "assistant", message: { id: "msg_mcp", role: "assistant", content: [{ type: "tool_use", id: "toolu_mcp", name: "mcp__godmode__report_missing_login", input: {} }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mcp", content: summary.call, is_error: false }] }, parent_tool_use_id: null, session_id: sessionId });
  const text = `MCP ${JSON.stringify(summary)}. I couldn't log in to example.com.`;
  textTurn(text);
  result(text);
} else if (prompt.includes("USE_TOOL")) {
  await replay("stream-tooluse.jsonl");
} else {
  await replay("stream-partial.jsonl");
}
