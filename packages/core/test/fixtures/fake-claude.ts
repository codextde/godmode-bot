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
 *   CALL_COMPUTER  call the `computer` MCP server from --mcp-config (initialize, tools/list, computer_info) and answer
 *              with a JSON summary; "no computer server" when the run has none
 *   CRASH       print to stderr and exit 3 without a result
 *   /<command>  a slash command Claude Code runs locally (`/clear` resets the session, `/model bogus` is rejected)
 *
 * With `--input-format stream-json` it answers the `initialize` control request with a command and model catalog.
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

if (args.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}

/**
 * Catalog probe (`initialize` over stream-json), logged to invocations.jsonl and probes.jsonl.
 * FAKE_CLAUDE_MODELS=error answers with an error, =silent exits without answering, =hang never answers and keeps a
 * child holding stdout (its pid goes to hang.pid).
 */
if (argValue("--input-format") === "stream-json") {
  const logged = JSON.stringify({ args, prompt: "", cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, GODMODE_TOKEN: process.env.GODMODE_TOKEN ?? null } });
  appendFileSync(join(stateDir, "invocations.jsonl"), logged + "\n");
  appendFileSync(join(stateDir, "probes.jsonl"), logged + "\n");
  const mode = process.env.FAKE_CLAUDE_MODELS ?? "";
  if (mode === "silent") {
    process.stderr.write("probe: not today\n");
    process.exit(1);
  }
  if (mode === "hang") {
    const child = Bun.spawn(["sleep", "60"], { stdout: "inherit", stderr: "inherit" });
    writeFileSync(join(stateDir, "hang.pid"), String(child.pid));
    process.stdin.on("end", () => {});
    await new Promise(() => {});
  }
  const effort = (levels: string[]) => ({ supportsEffort: true, supportedEffortLevels: levels });
  const all = ["low", "medium", "high", "xhigh", "max"];
  const models = [
    { value: "default", resolvedModel: "claude-opus-9", displayName: "Default (recommended)", description: "Opus 9", ...effort(all) },
    { value: "opus", resolvedModel: "claude-opus-9", displayName: "Opus 9", description: "Most capable", ...effort(all) },
    { value: "sonnet", resolvedModel: "claude-sonnet-9", displayName: "Sonnet 9", description: "Efficient", ...effort(all) },
    { value: "haiku", resolvedModel: "claude-haiku-9", displayName: "Haiku 9", description: "Fastest" },
    { value: "claude-opus-8", resolvedModel: "claude-opus-8", displayName: "Opus 8", description: "Older", ...effort(["low", "medium", "high", "max"]) },
  ];
  const commands = [
    { name: "goal", description: "Set a goal — keep working until the condition is met", argumentHint: "", builtin: true },
    { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
    { name: "color", description: "Set the prompt bar color", argumentHint: "[color]", builtin: true },
    { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
    { name: "hello", description: "Say hello to someone (project)", argumentHint: "<name>" },
    { name: "clear", description: "A project command shadowed by the built-in (project)", argumentHint: "" },
  ];
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)) as { type: string; request_id: string; request: { subtype: string } };
      buf = buf.slice(nl + 1);
      if (msg.type !== "control_request" || msg.request.subtype !== "initialize") continue;
      process.stdout.write(JSON.stringify({ type: "system", subtype: "hook_started" }) + "\n");
      const response =
        mode === "error"
          ? { subtype: "error", request_id: msg.request_id, error: "initialize failed" }
          : { subtype: "success", request_id: msg.request_id, response: { commands, models } };
      process.stdout.write(JSON.stringify({ type: "control_response", response }) + "\n");
    }
  }
  process.exit(0);
}

const prompt = await new Response(Bun.stdin.stream()).text();
const resume = argValue("--resume");
const sessionId = resume ?? argValue("--session-id") ?? crypto.randomUUID();

appendFileSync(
  join(stateDir, "invocations.jsonl"),
  JSON.stringify({
    args,
    prompt,
    cwd: process.cwd(),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      GODMODE_TOKEN: process.env.GODMODE_TOKEN ?? null,
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD ?? null,
    },
  }) + "\n",
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

const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(prompt.trim());

if (slash?.[1] === "clear") {
  const fresh = crypto.randomUUID();
  out({ type: "conversation_reset", new_conversation_id: fresh, trigger: "clear" });
  out({ ...init, session_id: fresh });
  result("", { session_id: fresh, num_turns: 0, local_command: "clear" });
} else if (slash) {
  const [, name, args] = slash;
  out(init);
  if (name === "compact") out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 900, post_tokens: 100 } });
  const effort = args.toLowerCase();
  const text =
    name === "model"
      ? args === "bogus"
        ? "Model 'bogus' not found"
        : `Set model to \`${args}\` for this session only`
      : name === "effort"
        ? effort === "auto"
          ? "Effort level set to auto (this session only)"
          : ["low", "medium", "high", "xhigh", "max"].includes(effort)
            ? `Set effort level to ${effort} (this session only)`
            : `Invalid argument: ${args}. Valid options are: low, medium, high, xhigh, max, auto`
        : `Ran /${name} ${args}`.trim();
  out({
    type: "assistant",
    message: { id: crypto.randomUUID(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    local_command_run: { command: name, args },
  });
  result(text, { num_turns: 0, local_command: name });
} else if (prompt.includes("CRASH")) {
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
} else if (prompt.includes("CALL_COMPUTER")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const server = cfg.mcpServers.computer;
  if (!server) {
    textTurn("no computer server");
    result("no computer server");
  } else {
    const rpc = async (body: unknown) => {
      const res = await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const raw = await res.text();
      return raw ? JSON.parse(raw) : null;
    };
    const initRes = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer_info", arguments: {} } });
    const summary = {
      server: initRes.result.serverInfo.name,
      url: server.url,
      sameToken: server.headers.Authorization === cfg.mcpServers.godmode!.headers.Authorization,
      tools: (list.result.tools as { name: string }[]).map((t) => t.name),
      info: call.result.content[0].text as string,
    };
    const text = `COMPUTER ${JSON.stringify(summary)}`;
    textTurn(text);
    result(text);
  }
} else if (prompt.includes("USE_TOOL")) {
  await replay("stream-tooluse.jsonl");
} else {
  await replay("stream-partial.jsonl");
}
