#!/usr/bin/env bun
/**
 * Fake `claude` CLI for runner tests. Speaks the same protocol as `claude -p --output-format stream-json`:
 * prompt on stdin, stream-json events on stdout, honoring --session-id / --resume.
 *
 * Behaviour is chosen by keywords in the prompt:
 *   (default)   replay stream-partial.jsonl       → "Hello, nice to meet you!"
 *   USE_TOOL    replay stream-tooluse.jsonl       → Bash tool + "DONE"
 *   USE_WORKFLOW  replay stream-workflow.jsonl    → a workflow of two agents in the background, two results
 *   SLEEP       emit init, then hang (cancel / timeout tests)
 *   LOGIN_FAIL  answer with a login-failure sentence
 *   CALL_MCP    call the Godmode MCP gateway from --mcp-config (initialize, tools/list, report_missing_login)
 *   CALL_COMPUTER  call the `computer` MCP server from --mcp-config (initialize, tools/list, computer_info) and answer
 *              with a JSON summary; "no computer server" when the run has none
 *   CALL_VM     call the `vm` MCP server from --mcp-config (initialize, tools/list, shell, write_file, edit_file, read_file)
 *              and answer "VM {json}"; "no vm server" when the run has none
 *   CALL_SSH    call the `ssh` MCP server from --mcp-config (initialize, tools/list, list_servers, shell, write_file,
 *              edit_file, read_file, shell with sudo) and answer "SSH {json}"; "no ssh server" when the run has none
 *   CALL_GUEST  start the stdio `browser` and `cua` MCP servers from --mcp-config like Claude Code does, send each an
 *              initialize line and answer "GUEST {json}" with the server names and each server's command and reply
 *   TASK_EDIT   write TASK_CHANGE.md into the cwd (a coding task's checkout) and answer with a summary
 *   TASK_COMMIT_ENV  write and commit .env.production in the cwd
 *   TASK_ENV    write .env and feature.txt into the cwd
 *   TASK_LEAK:<value>  write config.txt containing <value> into the cwd
 *   TASK_HISTORY:<value>  commit .env.production and a config.txt containing <value> (also named in the commit message),
 *              then commit config.txt without it and feature.txt
 *   TASK_LEAK_BYTES:<value>  write legacy.txt containing <value> in Latin-1 (not UTF-8), and feature.txt, into the cwd
 *   TASK_TIDY   in settings.txt, remove the `old_token=` line and add plain settings (a region, a base URL, a database)
 *   TASK_SHOTS:<dir>  answer with a summary naming the files in <dir> in every way an agent does (code, links, paths)
 *   TASK_BLOCKED  call the gateway's task_report_blocked and answer "BLOCKED {json}"
 *   TASK_FOLLOWUP call the gateway's followup_schedule (in 60 minutes, "Check the reply") and answer "Waiting for the reply"
 *   TASK_NOTE   call the gateway's task_note ("Halfway") and answer "NOTE {json}"
 *   SPLIT_TO:<agent id>  split the ticket into two parts for that agent with task_split and answer "SPLIT <reply>"
 *   DELEGATE_TO:<agent id>  hand "Say hello" to that agent with agent_delegate (wait: false) as a tool step and answer
 *              "DELEGATED <tool result>"
 *   CRASH       print to stderr and exit 3 without a result
 *   CRASH_ONCE  like CRASH the first time (per state dir), then answers as usual
 *   WAIT_FOR_QUEUE  run a tool step, then — once the state dir has a `queue-ready` file — call the PostToolBatch hook
 *              from --settings like Claude Code does between steps (first once as a subagent) until it hands over
 *              context, write that context to `queue-context.txt` and answer "QUEUE {json}"
 *   WAIT_TO_FINISH  answer "finished" once the state dir has a `finish` file
 *   LONG_STEP   start a tool step; once the state dir has a `step-done` file end it and call the PostToolBatch hook like
 *              Claude Code does: told to stop (`continue: false`), write `stopped-by-hook` and end the turn without an
 *              answer, else answer "step finished"
 *   LIMIT_HIT   while the state dir has a `limit` file (its content: the reset time in unix seconds, may be empty) end
 *              like Claude Code does when a usage limit is reached; afterwards answer "back after the limit"
 *   OVERAGE_CRASH  report a reached limit like Claude Code does while requests still go through, then crash like CRASH
 *   Dream: …    a dream (memory consolidation): rewrites MEMORY.md from the `REMEMBER: <fact>` lines of the activity
 *               digest (+ memory/dream-notes.md), calls the gateway (tools/list, a forbidden tool, memory_dream_report)
 *               and answers "DREAM {json}". Digest keywords: DREAM_SLEEP hangs and DREAM_CRASH exits 3 (both after
 *               writing the memory), DREAM_NO_REPORT skips the report.
 *   ASK_HUMAN   call the gateway's ask_human (arguments from the state dir's `ask-args.json` when it exists) as a step,
 *              then call the PostToolBatch hook like Claude Code does: told to stop, write `stopped-by-hook` and end the
 *              turn without an answer, else answer "no stop". The tool's result goes to `ask-result.json`.
 *   ASK_APPROVAL  the same with request_approval
 *   ASK_TWICE   ask_human twice in one step (both results in `ask-result.json`), then the hook
 *   ASK_NO_HOOK ask_human, then end the turn with an answer without calling the hook
 *   <godmode-continue> … <your-question>  a run continuing with the human's answer: answers "CONTINUED", or — while the
 *              state dir has an `ask-again` file (removed then) — asks once more like ASK_HUMAN
 *   SESSION_COST  report the cost like Claude Code does: as the total of the whole session ($0.5 more with every
 *              invocation that resumes it), with the tokens and turns of this invocation only
 *   TWO_RESULTS  end twice in one process, like Claude Code does when a background task finishes after its answer:
 *              the second ending counts its own time, turns and tokens, and reports the running total of the cost
 *   SLOW_STREAM  stream "one two three four five six" word by word as partial messages, 120 ms apart
 *   SLOW_TASK   a tool call whose background task reports progress three times, 150 ms apart, then completes
 *   SHOTS:<n>   run <n> tool steps that each answer with a screenshot and a line of text, then answer "shots done".
 *              With THEN_WAIT:<key> it first waits for the state dir's `<key>-next` file, writes "almost there", and
 *              waits for `<key>-done`
 *   /<command>  a slash command Claude Code runs locally (`/clear` resets the session, `/model bogus` is rejected,
 *               `/effort ultracode [on|off]` switches Ultracode, and a new effort level ends an Ultracode that the
 *               --settings file turned on)
 *
 * With `--input-format stream-json` it answers the `initialize` control request with a command and model catalog,
 * `get_settings` with what applies to the session, and `set_model` (every request goes to control-requests.jsonl).
 * Env: FAKE_CLAUDE_STATE — directory for known sessions + an invocation log (invocations.jsonl, with the content of the
 * --settings file). FAKE_CLAUDE_ULTRACODE — =off: no dynamic workflows; a Claude Code from before Ultracode: =error
 * rejects `get_settings`, =silent never answers it, =unknown answers without the Ultracode fields; =exit: it exits
 * on `get_settings` instead of answering.
 * FAKE_CLAUDE_SESSION_MODEL — the model of the probe's session until `set_model` names another (default opus);
 * FAKE_CLAUDE_SET_MODEL — =error rejects `set_model`, =silent never answers it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const ultracodeMode = process.env.FAKE_CLAUDE_ULTRACODE ?? "";

/**
 * Catalog probe (`initialize`, then `get_settings` over stream-json), logged to invocations.jsonl and probes.jsonl.
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
  // Ultracode is available with dynamic workflows and a session model that has the xhigh level.
  let sessionModel = process.env.FAKE_CLAUDE_SESSION_MODEL ?? "opus";
  const setModelMode = process.env.FAKE_CLAUDE_SET_MODEL ?? "";
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)) as { type: string; request_id: string; request: { subtype: string; model?: string } };
      buf = buf.slice(nl + 1);
      if (msg.type === "control_request") appendFileSync(join(stateDir, "control-requests.jsonl"), JSON.stringify(msg.request) + "\n");
      if (msg.type === "control_request" && msg.request.subtype === "set_model" && setModelMode !== "silent") {
        if (setModelMode !== "error") sessionModel = msg.request.model ?? sessionModel;
        const response = setModelMode === "error" ? { subtype: "error", request_id: msg.request_id, error: "Could not switch the model" } : { subtype: "success", request_id: msg.request_id };
        process.stdout.write(JSON.stringify({ type: "control_response", response }) + "\n");
      }
      if (msg.type === "control_request" && msg.request.subtype === "get_settings" && ultracodeMode === "exit") process.exit(0);
      if (msg.type === "control_request" && msg.request.subtype === "get_settings" && ultracodeMode !== "silent") {
        const session = models.find((m) => m.value === sessionModel || m.resolvedModel === sessionModel);
        const available = ultracodeMode !== "off" && !!session && "supportedEffortLevels" in session && session.supportedEffortLevels.includes("xhigh");
        const applied = { model: session?.resolvedModel ?? sessionModel, effort: "high", ...(ultracodeMode === "unknown" ? {} : { ultracode: false, ultracodeRequested: false, ultracodeAvailable: available }) };
        const response =
          ultracodeMode === "error"
            ? { subtype: "error", request_id: msg.request_id, error: "Unsupported control request subtype: get_settings" }
            : { subtype: "success", request_id: msg.request_id, response: { effective: {}, sources: [], applied } };
        process.stdout.write(JSON.stringify({ type: "control_response", response }) + "\n");
      }
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
// The run's settings file is gone once the run has ended: its content is kept for the tests.
const settingsFile = argValue("--settings");
const sessionSettings = settingsFile && existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as { ultracode?: boolean }) : null;

appendFileSync(
  join(stateDir, "invocations.jsonl"),
  JSON.stringify({
    args,
    prompt,
    cwd: process.cwd(),
    settings: sessionSettings,
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

/** Ask the human through the gateway like an agent does, as one step, then stand still at the hook. */
async function ask(mode: "question" | "approval" | "twice" | "nohook") {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown) => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    return raw ? JSON.parse(raw) : null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  const name = mode === "approval" ? "request_approval" : "ask_human";
  const argsFile = join(stateDir, "ask-args.json");
  const args = existsSync(argsFile)
    ? (JSON.parse(readFileSync(argsFile, "utf8")) as Record<string, unknown>)
    : mode === "approval"
      ? { action: "Send the payment reminder to billing@acme.com", reason: "The invoice is 30 days overdue.", affects: "ACME's billing team gets an email from you." }
      : {
          question: "Which color should the header be?",
          context: "The brand guide allows two.",
          options: [{ label: "Yellow", recommended: true }, { label: "Blue", description: "Matches the logo" }],
        };
  out({ type: "assistant", message: { id: "msg_ask", role: "assistant", content: [{ type: "tool_use", id: "toolu_ask", name: `mcp__godmode__${name}`, input: args }] }, parent_tool_use_id: null, session_id: sessionId });
  const first = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const second = mode === "twice" ? await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_human", arguments: { question: "And which font?" } } }) : null;
  const text = first.result.content[0].text as string;
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: text, is_error: first.result.isError === true }] }, parent_tool_use_id: null, session_id: sessionId });
  writeFileSync(join(stateDir, "ask-result.json"), JSON.stringify({ first: first.result, second: second?.result ?? null }));
  if (mode === "nohook") {
    textTurn("I asked and will wait.");
    result("I asked and will wait.");
    return;
  }
  const settings = JSON.parse(readFileSync(argValue("--settings")!, "utf8")) as {
    hooks: { PostToolBatch: { hooks: { url: string; headers: Record<string, string> }[] }[] };
  };
  const hook = settings.hooks.PostToolBatch[0]!.hooks[0]!;
  const res = await fetch(hook.url, {
    method: "POST",
    headers: { ...hook.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PostToolBatch", session_id: sessionId, tool_calls: [] }),
  });
  const raw = await res.text();
  if (raw && (JSON.parse(raw) as { continue?: boolean }).continue === false) {
    writeFileSync(join(stateDir, "stopped-by-hook"), raw);
    result("", { stop_reason: "tool_use", terminal_reason: "hook_stopped" });
  } else {
    textTurn("no stop");
    result("no stop");
  }
}

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
  const valid = "Valid options are: low, medium, high, xhigh, max, auto, ultracode";
  const stays = `Effort stays ${argValue("--effort") ?? "high"}.`;
  // A new effort level ends the session's Ultracode.
  const ends = sessionSettings?.ultracode === true ? " · Ultracode off" : "";
  const text =
    name === "model"
      ? args === "bogus"
        ? "Model 'bogus' not found"
        : `Set model to \`${args}\` for this session only`
      : name === "effort"
        ? effort === "auto"
          ? `Effort level set to auto (this session only)${ends}`
          : ["low", "medium", "high", "xhigh", "max"].includes(effort)
            ? `Set effort level to ${effort} (this session only)${ends}`
            : /^ultracode( on| off)?$/.test(effort)
              ? ultracodeMode
                ? `Ultracode needs dynamic workflows enabled (see /config). ${valid}`
                : argValue("--model") === "haiku"
                  ? `Ultracode isn't available on Haiku 9. ${valid}`
                  : effort.endsWith(" off")
                    ? `Ultracode off. ${stays}`
                    : `Ultracode on (this session only): Claude plans every task as a workflow of several agents. ${stays}`
              : `Invalid argument: ${args}. ${valid}`
        : `Ran /${name} ${args}`.trim();
  out({
    type: "assistant",
    message: { id: crypto.randomUUID(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    local_command_run: { command: name, args },
  });
  result(text, { num_turns: 0, local_command: name });
} else if (prompt.includes("<godmode-continue>") && prompt.includes("<your-question>")) {
  const again = join(stateDir, "ask-again");
  if (existsSync(again)) {
    rmSync(again);
    await ask("question");
  } else {
    out(init);
    textTurn("CONTINUED");
    result("CONTINUED");
  }
} else if (prompt.includes("ASK_TWICE")) {
  await ask("twice");
} else if (prompt.includes("ASK_NO_HOOK")) {
  await ask("nohook");
} else if (prompt.includes("ASK_APPROVAL")) {
  await ask("approval");
} else if (prompt.includes("ASK_HUMAN")) {
  await ask("question");
} else if (prompt.startsWith("Dream: consolidate")) {
  out(init);
  const cwd = process.cwd();
  const digestRel = /`(workspace\/tmp\/dreams\/[^`]+\.md)`/.exec(prompt)?.[1] ?? null;
  const digest = digestRel && existsSync(join(cwd, digestRel)) ? readFileSync(join(cwd, digestRel), "utf8") : "";
  const memoryPath = join(cwd, "MEMORY.md");
  const hadMemory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8").length : 0;
  const facts = [...new Set([...digest.matchAll(/REMEMBER: ([^\n]+)/g)].map((m) => m[1]!.trim()))];
  writeFileSync(memoryPath, `# Memory\n\n## Consolidated\n${facts.map((f) => `- ${f}`).join("\n")}\n`);
  if (facts.length) {
    mkdirSync(join(cwd, "memory"), { recursive: true });
    writeFileSync(join(cwd, "memory", "dream-notes.md"), `# Notes\n\n${facts.length} fact(s)\n`);
  }
  if (digest.includes("DREAM_SLEEP")) {
    textTurn("Dreaming");
    await pause(60_000);
  }
  if (digest.includes("DREAM_CRASH")) {
    process.stderr.write("fatal: the dream exploded\n");
    process.exit(3);
  }
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown) => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    return raw ? JSON.parse(raw) : null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const forbidden = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "notify_user", arguments: { title: "hi", body: "x" } } });
  const report = digest.includes("DREAM_NO_REPORT")
    ? null
    : await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memory_dream_report", arguments: { summary: `Consolidated ${facts.length} fact(s).`, changes: facts.map((f) => ({ kind: "added", text: f })) } },
      });
  const summary = {
    servers: Object.keys(cfg.mcpServers),
    tools: (list.result.tools as { name: string }[]).map((t) => t.name),
    forbidden: { text: forbidden.result.content[0].text as string, isError: forbidden.result.isError === true },
    report: report ? (report.result.content[0].text as string) : null,
    digest: digest.length > 0,
    hadMemory,
  };
  const text = `DREAM ${JSON.stringify(summary)}`;
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_EDIT")) {
  out(init);
  appendFileSync(join(process.cwd(), "TASK_CHANGE.md"), `${prompt.split("\n")[0]}\n`);
  const text = "Added TASK_CHANGE.md with the requested change.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_COMMIT_ENV")) {
  out(init);
  writeFileSync(join(process.cwd(), ".env.production"), "API_TOKEN=abc123\n");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=Agent", "-c", "user.email=agent@example.com", ...a], { cwd: process.cwd() });
  git("add", "-f", ".env.production");
  git("commit", "-qm", "Add production env");
  const text = "Committed the env file.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_ENV")) {
  out(init);
  writeFileSync(join(process.cwd(), ".env"), "API_TOKEN=abc123\n");
  writeFileSync(join(process.cwd(), "feature.txt"), "a feature\n");
  const text = "Added feature.txt.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_LEAK:")) {
  out(init);
  writeFileSync(join(process.cwd(), "config.txt"), `token=${/TASK_LEAK:(\S+)/.exec(prompt)![1]}\n`);
  const text = "Wrote the config.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_HISTORY:")) {
  out(init);
  const value = /TASK_HISTORY:(\S+)/.exec(prompt)![1]!;
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=Agent", "-c", "user.email=agent@example.com", ...a], { cwd: process.cwd() });
  writeFileSync(join(process.cwd(), ".env.production"), "API_TOKEN=abc123\n");
  writeFileSync(join(process.cwd(), "config.txt"), `token=${value}\n`);
  git("add", "-f", ".env.production", "config.txt");
  git("commit", "-qm", `Configure with ${value}`);
  writeFileSync(join(process.cwd(), "config.txt"), "token=$API_TOKEN\n");
  writeFileSync(join(process.cwd(), "feature.txt"), "a feature\n");
  git("add", "config.txt", "feature.txt");
  git("commit", "-qm", "Read the token from the environment");
  const text = "Configured it.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_LEAK_BYTES:")) {
  out(init);
  const line = `token=${/TASK_LEAK_BYTES:(\S+)/.exec(prompt)![1]}\n`;
  writeFileSync(join(process.cwd(), "legacy.txt"), Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), Buffer.from(line)]));
  writeFileSync(join(process.cwd(), "feature.txt"), "a feature\n");
  const text = "Wrote the legacy config.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_TIDY")) {
  out(init);
  const file = join(process.cwd(), "settings.txt");
  writeFileSync(file, `${readFileSync(file, "utf8").replace(/^old_token=.*\n/m, "")}region=eu-central-1\nbase=https://api.example.com/v1\ndb=postgres\n`);
  const text = "Tidied the settings.";
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_SHOTS:")) {
  out(init);
  const dir = /TASK_SHOTS:(\S+)/.exec(prompt)![1]!;
  const text = [
    "Made the header yellow.",
    "",
    "Screenshots:",
    `- \`${dir}/light.png\``,
    `- ![Dark mode](<${dir}/dark mode.png>)`,
    `- Again: ${dir}/light.png.`,
    `- [The same](file://${dir}/light.png)`,
    `- Not shown: \`${dir}/notes.txt\`, \`${dir}/missing.png\`, \`${dir}/fake.png\`, [online](https://example.com/shot.png)`,
    "",
    "```sh",
    `open ${dir}/light.png`,
    "```",
  ].join("\n");
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_FOLLOWUP") || prompt.includes("TASK_NOTE")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown) => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    return raw ? JSON.parse(raw) : null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  if (prompt.includes("TASK_FOLLOWUP")) {
    await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "followup_schedule", arguments: { inMinutes: 60, note: "Check the reply" } } });
    textTurn("Waiting for the reply");
    result("Waiting for the reply");
  } else {
    const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "task_note", arguments: { text: "Halfway" } } });
    const text = `NOTE ${JSON.stringify({ text: call.result.content[0].text, isError: call.result.isError === true })}`;
    textTurn(text);
    result(text);
  }
} else if (/SPLIT_TO:(\S+)/.test(prompt)) {
  out(init);
  const agentId = /SPLIT_TO:(\S+)/.exec(prompt)![1]!;
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown) => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    return raw ? JSON.parse(raw) : null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  const input = { parts: [{ title: "Write the copy", agentId }, { title: "Pick the images", agentId }] };
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_split", arguments: input } });
  const reply = call.result.content[0].text as string;
  const text = `SPLIT ${reply}`;
  textTurn(text);
  result(text);
} else if (/DELEGATE_TO:(\S+)/.test(prompt)) {
  // Hand "Say hello" to that agent without waiting, shown like Claude Code shows the tool step.
  out(init);
  const agentId = /DELEGATE_TO:(\S+)/.exec(prompt)![1]!;
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown) => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    return raw ? JSON.parse(raw) : null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  const input = { agentId, task: "Say hello", wait: false };
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_delegate", arguments: input } });
  const reply = call.result.content[0].text as string;
  out({ type: "assistant", message: { id: "msg_dlg", role: "assistant", content: [{ type: "tool_use", id: "toolu_dlg", name: "mcp__godmode__agent_delegate", input }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_dlg", content: reply, is_error: !!call.result.isError }] }, parent_tool_use_id: null, session_id: sessionId });
  const text = `DELEGATED ${reply}`;
  textTurn(text);
  result(text);
} else if (prompt.includes("TASK_BLOCKED")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const gw = cfg.mcpServers.godmode!;
  const rpc = async (body: unknown) => {
    const res = await fetch(gw.url, { method: "POST", headers: { ...gw.headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    return raw ? JSON.parse(raw) : null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_report_blocked", arguments: { reason: "Need admin access to the billing portal" } } });
  const tools = (list.result.tools as { name: string }[]).map((t) => t.name);
  const text = `BLOCKED ${JSON.stringify({ listed: tools.includes("task_report_blocked"), call: call.result.content[0].text })}`;
  textTurn(text);
  result(text);
} else if (prompt.includes("OVERAGE_CRASH")) {
  out(init);
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 3600, isUsingOverage: true }, session_id: sessionId });
  textTurn("Working on it");
  process.stderr.write("fatal: something exploded\n");
  process.exit(3);
} else if (prompt.includes("CRASH_ONCE") && !existsSync(join(stateDir, "crashed-once"))) {
  // The first run crashes, every later one works (a passing hiccup).
  writeFileSync(join(stateDir, "crashed-once"), "");
  process.stderr.write("fatal: something exploded\n");
  process.exit(3);
} else if (prompt.includes("CRASH") && !prompt.includes("CRASH_ONCE")) {
  process.stderr.write("fatal: something exploded\n");
  process.exit(3);
} else if (prompt.includes("WAIT_FOR_QUEUE")) {
  out(init);
  const settings = JSON.parse(readFileSync(argValue("--settings")!, "utf8")) as {
    hooks: { PostToolBatch: { hooks: { type: string; url: string; headers: Record<string, string> }[] }[] };
  };
  const hook = settings.hooks.PostToolBatch[0]!.hooks[0]!;
  const step = async (extra: Record<string, unknown> = {}) => {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { ...hook.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "PostToolBatch", session_id: sessionId, tool_calls: [], ...extra }),
    });
    const raw = await res.text();
    return { status: res.status, context: raw ? ((JSON.parse(raw) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext) : null };
  };
  out({ type: "assistant", message: { id: "msg_step", role: "assistant", content: [{ type: "tool_use", id: "toolu_step", name: "Bash", input: { command: "sleep 1" } }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_step", content: "ok", is_error: false }] }, parent_tool_use_id: null, session_id: sessionId });
  let context: string | null = null;
  let subagent: number | null = null;
  for (let i = 0; i < 300 && !context; i++) {
    await pause(50);
    if (existsSync(join(stateDir, "queue-ready"))) subagent ??= (await step({ agent_id: "sub_1", agent_type: "general-purpose" })).status;
    if (subagent !== null) context = (await step()).context;
  }
  writeFileSync(join(stateDir, "queue-context.txt"), context ?? "");
  const text = `QUEUE ${JSON.stringify({ hookType: hook.type, subagent, context })}`;
  textTurn(text);
  result(text);
} else if (prompt.includes("LONG_STEP")) {
  out(init);
  const settings = JSON.parse(readFileSync(argValue("--settings")!, "utf8")) as {
    hooks: { PostToolBatch: { hooks: { url: string; headers: Record<string, string> }[] }[] };
  };
  const hook = settings.hooks.PostToolBatch[0]!.hooks[0]!;
  out({ type: "assistant", message: { id: "msg_long", role: "assistant", content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "make build" } }] }, parent_tool_use_id: null, session_id: sessionId });
  for (let i = 0; i < 600 && !existsSync(join(stateDir, "step-done")); i++) await pause(50);
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_long", content: "built", is_error: false }] }, parent_tool_use_id: null, session_id: sessionId });
  const res = await fetch(hook.url, {
    method: "POST",
    headers: { ...hook.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PostToolBatch", session_id: sessionId, tool_calls: [] }),
  });
  const raw = await res.text();
  if (raw && (JSON.parse(raw) as { continue?: boolean }).continue === false) {
    writeFileSync(join(stateDir, "stopped-by-hook"), raw);
    result("", { stop_reason: "tool_use", terminal_reason: "hook_stopped" });
  } else {
    textTurn("step finished");
    result("step finished");
  }
} else if (prompt.includes("LIMIT_HIT")) {
  out(init);
  const limitFile = join(stateDir, "limit");
  if (existsSync(limitFile)) {
    const resetsAt = Number(readFileSync(limitFile, "utf8").trim()) || undefined;
    const text = "You've hit your session limit · resets 3pm (Europe/Berlin)";
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", ...(resetsAt ? { resetsAt } : {}) }, session_id: sessionId });
    out({ type: "assistant", message: { id: crypto.randomUUID(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: text, session_id: sessionId, total_cost_usd: 0, duration_ms: 7, num_turns: 1 });
    process.exit(1);
  }
  textTurn("back after the limit");
  result("back after the limit");
} else if (prompt.includes("WAIT_TO_FINISH")) {
  out(init);
  textTurn("Working on it");
  for (let i = 0; i < 300 && !existsSync(join(stateDir, "finish")); i++) await pause(50);
  result("finished");
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
} else if (prompt.includes("CALL_VM")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const server = cfg.mcpServers.vm;
  if (!server) {
    textTurn("no vm server");
    result("no vm server");
  } else {
    let id = 0;
    const rpc = async (method: string, params?: unknown) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
      });
      const raw = await res.text();
      return raw ? JSON.parse(raw) : null;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc("tools/call", { name, arguments: args });
      return { text: r.result.content[0].text as string, isError: !!r.result.isError };
    };
    const initRes = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
    const list = await rpc("tools/list");
    const shell = await call("shell", { command: "echo hello-from-vm && whoami >/dev/null; echo oops >&2; exit 3" });
    const write = await call("write_file", { path: "project/notes.txt", content: "alpha\nbeta\n" });
    const edit = await call("edit_file", { path: "project/notes.txt", old_string: "beta", new_string: "gamma" });
    const read = await call("read_file", { path: "~/project/notes.txt" });
    const cwd = await call("shell", { command: "pwd", cwd: "project" });
    const summary = {
      server: initRes.result.serverInfo.name,
      sameToken: server.headers.Authorization === cfg.mcpServers.godmode!.headers.Authorization,
      tools: (list.result.tools as { name: string }[]).map((t) => t.name),
      shell,
      write,
      edit,
      read,
      cwd,
    };
    const text = `VM ${JSON.stringify(summary)}`;
    textTurn(text);
    result(text);
  }
} else if (prompt.includes("CALL_SSH")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const server = cfg.mcpServers.ssh;
  if (!server) {
    textTurn("no ssh server");
    result("no ssh server");
  } else {
    let id = 0;
    const rpc = async (method: string, params?: unknown) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
      });
      const raw = await res.text();
      return raw ? JSON.parse(raw) : null;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc("tools/call", { name, arguments: args });
      return { text: r.result.content[0].text as string, isError: !!r.result.isError };
    };
    const initRes = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
    const list = await rpc("tools/list");
    const servers = await call("list_servers", {});
    const shell = await call("shell", { command: "echo hello-from-ssh; echo oops >&2; exit 3" });
    const write = await call("write_file", { path: "project/notes.txt", content: "alpha\nbeta\n" });
    const edit = await call("edit_file", { path: "project/notes.txt", old_string: "beta", new_string: "gamma" });
    const read = await call("read_file", { path: "~/project/notes.txt" });
    const sudo = await call("shell", { command: "echo root=$FAKE_ROOT", sudo: true });
    const summary = {
      server: initRes.result.serverInfo.name,
      sameToken: server.headers.Authorization === cfg.mcpServers.godmode!.headers.Authorization,
      tools: (list.result.tools as { name: string }[]).map((t) => t.name),
      servers,
      shell,
      write,
      edit,
      read,
      sudo,
    };
    const text = `SSH ${JSON.stringify(summary)}`;
    textTurn(text);
    result(text);
  }
} else if (prompt.includes("CALL_GUEST")) {
  out(init);
  const cfg = JSON.parse(readFileSync(argValue("--mcp-config")!, "utf8")) as {
    mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const talk = async (name: string) => {
    const server = cfg.mcpServers[name];
    if (!server?.command) return null;
    const proc = Bun.spawn([server.command, ...(server.args ?? [])], {
      env: { ...process.env, ...server.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 30_000;
    while (!buf.includes("\n") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await proc.stdin.end();
    const exitCode = await Promise.race([proc.exited, pause(10_000).then(() => null)]);
    const stderr = await new Response(proc.stderr).text();
    let reply: unknown = null;
    try {
      reply = JSON.parse(buf.split("\n")[0]!);
    } catch {
      reply = { raw: buf, stderr };
    }
    return { command: server.command, args: server.args ?? [], reply, exitCode };
  };
  const summary = { servers: Object.keys(cfg.mcpServers), browser: await talk("browser"), cua: await talk("cua") };
  const text = `GUEST ${JSON.stringify(summary)}`;
  textTurn(text);
  result(text);
} else if (prompt.includes("USE_WORKFLOW")) {
  await replay("stream-workflow.jsonl");
} else if (prompt.includes("SESSION_COST")) {
  out(init);
  const costFile = join(stateDir, "sessions", `${sessionId}.cost`);
  const total = (existsSync(costFile) ? Number(readFileSync(costFile, "utf8")) : 0) + 0.5;
  writeFileSync(costFile, String(total));
  textTurn("spent");
  result("spent", { total_cost_usd: total });
} else if (prompt.includes("TWO_RESULTS")) {
  out(init);
  textTurn("first answer");
  result("first answer", { total_cost_usd: 0.25, duration_ms: 1000, num_turns: 3, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } });
  await pause(20);
  textTurn("the background task finished");
  result("the background task finished", { total_cost_usd: 0.3, duration_ms: 200, num_turns: 1, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
} else if (prompt.includes("SLOW_TASK")) {
  out(init);
  const toolId = "toolu_slow_task";
  out({ type: "assistant", message: { id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Task", input: { description: "Count" } }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "system", subtype: "task_started", task_id: "task_1", tool_use_id: toolId, task_type: "local_agent", description: "Count words", session_id: sessionId });
  for (let i = 1; i <= 3; i++) {
    await pause(150);
    out({ type: "system", subtype: "task_progress", task_id: "task_1", description: `step ${i}`, usage: { total_tokens: i * 100, tool_uses: i, duration_ms: i * 10 }, session_id: sessionId });
  }
  await pause(150);
  out({ type: "system", subtype: "task_notification", task_id: "task_1", status: "completed", usage: { total_tokens: 400, tool_uses: 4, duration_ms: 40 }, session_id: sessionId });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "counted" }] }, parent_tool_use_id: null, session_id: sessionId });
  textTurn("task done");
  result("task done");
} else if (prompt.includes("SLOW_STREAM")) {
  out(init);
  const id = `msg_${crypto.randomUUID()}`;
  const words = ["one", " two", " three", " four", " five", " six"];
  const event = (ev: unknown) => out({ type: "stream_event", event: ev, parent_tool_use_id: null, session_id: sessionId });
  event({ type: "message_start", message: { id, role: "assistant", model: "fake-model", content: [] } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const w of words) {
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } });
    await pause(120);
  }
  event({ type: "content_block_stop", index: 0 });
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: words.join("") }] }, parent_tool_use_id: null, session_id: sessionId });
  result(words.join(""));
} else if (/SHOTS:(\d+)/.test(prompt)) {
  out(init);
  const count = Number(/SHOTS:(\d+)/.exec(prompt)![1]);
  // A PNG header and filler: what matters is its size.
  const image = `iVBORw0KGgo${"A".repeat(4000)}`;
  for (let i = 0; i < count; i++) {
    const id = `toolu_shot_${i}`;
    out({ type: "assistant", message: { id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "tool_use", id, name: "mcp__browser__browser_screenshot", input: { n: i } }] }, parent_tool_use_id: null, session_id: sessionId });
    await pause(3);
    out({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `shot ${i}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: `${image}${i}` } }] }] },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    await pause(3);
  }
  const key = /THEN_WAIT:([\w-]+)/.exec(prompt)?.[1];
  if (key) {
    for (let i = 0; i < 400 && !existsSync(join(stateDir, `${key}-next`)); i++) await pause(50);
    textTurn("almost there");
    for (let i = 0; i < 400 && !existsSync(join(stateDir, `${key}-done`)); i++) await pause(50);
  }
  textTurn("shots done");
  result("shots done");
} else if (prompt.includes("USE_TOOL")) {
  await replay("stream-tooluse.jsonl");
} else {
  await replay("stream-partial.jsonl");
}
