/**
 * Runs Claude Code CLI for an agent turn and streams the results (owner: runner).
 *
 * One run = one `claude -p` process (prompt on stdin, stream-json on stdout) in the agent's repo, resuming
 * the conversation's Claude session. Runs are queued (settings.runner.maxConcurrentRuns, re-read on every
 * dequeue) with strictly one active run per conversation (FIFO). Output is parsed by StreamAccumulator into
 * one assistant message, pushed live as `run.delta` events, persisted (redacted) to SQLite, the agent repo
 * transcript and a raw JSONL run log.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileSink, Subprocess } from "bun";
import type { Agent, Effort, Message, Run, RunStatus, RunTrigger, RunUsage } from "@godmode/shared";
import { BROWSER_MCP_NAME, DEFAULT_MODEL, isModelId } from "@godmode/shared";
import { all, get, insert, run as sql } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, badRequest, conflict, hostnameOf, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { commitAgentRepo, ensureAgentRepo, getAgent, listAgents, peersFor, setAgentStatus, touchAgentRun } from "../agents/service";
import { getSettings } from "../services/settings";
import { reportMissingLogin } from "../services/missingLogins";
import { BROWSER_LLM_TOOLS, browserLlmKey, currentPage, resolveProfileForAgent } from "../browser/manager";
import {
  addMessage,
  appendTranscript,
  conversationExists,
  emitConversationUpdated,
  DEFAULT_CONVERSATION_TITLE,
  getMessage,
  listMessages,
  setConversationState,
  titleFromContent,
  updateMessage,
} from "../services/conversations";
import { issueRunToken, revokeRunToken } from "../mcp/tokens";
import { claudeMemEnv, claudeMemPluginDir, stopClaudeMemWorkers } from "../memory/claudeMem";
import { claudeEnv, killTree, resolveClaudeCommand } from "./claude";
import { buildMcpConfig, removeMcpConfigFile, writeMcpConfigFile } from "./mcpConfig";
import { effortFor } from "./models";
import { buildSystemPrompt, resumeContextPrefix } from "./prompt";
import { StreamAccumulator, detectLoginFailure, redactBlocks } from "./stream";

const log = logger("runner");

export interface StartRunInput {
  agentId: string;
  conversationId: string;
  prompt: string;
  trigger: RunTrigger;
  routineId?: string | null;
  parentRunId?: string | null;
  depth?: number;
  voice?: boolean;
  /** The stored user message this run answers. When omitted the runner stores one from `prompt`. */
  userMessageId?: string | null;
}

export const CLAUDE_NOT_FOUND = "Claude Code CLI not found. Install it from Settings → System.";
export const INTERRUPTED = "Interrupted (Godmode restarted)";
const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
const STDERR_TAIL_BYTES = 8 * 1024;
const DELTA_INTERVAL_MS = 100;
const DELTA_INTERVAL_HEAVY_MS = 1000;
const PERSIST_INTERVAL_MS = 2000;
const KILL_GRACE_MS = 5000;
const SESSION_MISSING = /no conversation found|session(?: id)? [^\n]{0,80}not found|could not find session|no such session/i;
const AUTH_PROBLEM = /not logged in|please run \/login|invalid api key|authentication_error|oauth token (?:has )?expired|credit balance is too low/i;

export { __setClaudeBinaryForTests } from "./claude";

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

interface RunRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  routine_id: string | null;
  parent_run_id: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  prompt: string;
  result: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
  usage: string | null;
  model: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    routineId: r.routine_id,
    parentRunId: r.parent_run_id,
    trigger: r.trigger,
    status: r.status,
    prompt: r.prompt,
    result: r.result,
    error: r.error,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    numTurns: r.num_turns,
    usage: parseJson<RunUsage | null>(r.usage, null),
    model: r.model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

export function getRun(id: string): Run {
  const row = get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
  if (!row) throw notFound("Run");
  return toRun(row);
}

export function listRuns(opts: { agentId?: string; status?: string; conversationId?: string; limit?: number } = {}): Run[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agentId) {
    where.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.conversationId) {
    where.push("conversation_id = ?");
    params.push(opts.conversationId);
  }
  if (opts.status) {
    const statuses = opts.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
  params.push(limit);
  return all<RunRow>(
    `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ...params,
  ).map(toRun);
}

/** Path of the raw (redacted) stream-json log of a run inside its agent repo. */
export function runLogPath(agent: Agent, r: Pick<Run, "id" | "createdAt">): string {
  return join(agent.repoPath, "runs", r.createdAt.slice(0, 10), `${r.id}.jsonl`);
}

/** Locate an existing run log (falls back to scanning the date folders). */
export function findRunLog(r: Run): string | null {
  let agent: Agent;
  try {
    agent = getAgent(r.agentId);
  } catch {
    return null;
  }
  const expected = runLogPath(agent, r);
  if (existsSync(expected)) return expected;
  const root = join(agent.repoPath, "runs");
  if (!existsSync(root)) return null;
  for (const day of readdirSync(root)) {
    const candidate = join(root, day, `${r.id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* In-memory state                                                     */
/* ------------------------------------------------------------------ */

type Outcome = { status: "succeeded" | "failed" | "cancelled"; error: string | null };

interface Job {
  runId: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  userMessageId: string | null;
  /** Unredacted prompt — memory only. */
  prompt: string;
  trigger: RunTrigger;
  parentRunId: string | null;
  depth: number;
  voice: boolean;
  status: "queued" | "running";
  acc: StreamAccumulator;
  proc: Subprocess | null;
  cancelReason: string | null;
  timedOut: boolean;
  lastLabel: string;
  lastDeltaAt: number;
  lastPersistAt: number;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  done: Promise<void> | null;
  /** Browser profile this run drives (undefined = not resolved yet, null = no browser). */
  browserProfileId?: string | null;
  /** `--model` value the run was started with. */
  model?: string;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
const missingLoginReported = new Set<string>();
let shuttingDown = false;

/** Called by the MCP gateway when the agent reported a missing login itself (disables the heuristic). */
export function markMissingLoginReported(runId: string) {
  missingLoginReported.add(runId);
}

/** Queued-or-running run of a conversation (the one that answers the oldest pending message). */
export function activeRunForConversation(conversationId: string): string | null {
  let queued: string | null = null;
  for (const job of jobs.values()) {
    if (job.conversationId !== conversationId) continue;
    if (job.status === "running") return job.runId;
    queued ??= job.runId;
  }
  return queued;
}

export function listActiveRuns(): { runId: string; agentId: string; conversationId: string; status: "queued" | "running"; parentRunId: string | null }[] {
  return [...jobs.values()].map((j) => ({
    runId: j.runId,
    agentId: j.agentId,
    conversationId: j.conversationId,
    status: j.status,
    parentRunId: j.parentRunId,
  }));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function safely(what: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    log.warn(`${what} failed`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function startRun(input: StartRunInput): Promise<Run> {
  if (shuttingDown) throw new HttpError(503, "Godmode is shutting down", "shutting_down");
  const agent = getAgent(input.agentId);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  const conv = get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", input.conversationId);
  if (!conv) throw notFound("Conversation");
  if (conv.agent_id !== agent.id) throw badRequest("The conversation belongs to another agent");
  if (!input.prompt.trim()) throw badRequest("Prompt is empty");

  const runId = newId("run");
  let userMessageId = input.userMessageId ?? null;
  if (userMessageId) sql("UPDATE messages SET run_id = ? WHERE id = ?", runId, userMessageId);
  else userMessageId = addMessage({ conversationId: input.conversationId, role: "user", content: redact(input.prompt), runId }).id;

  insert("runs", {
    id: runId,
    agent_id: agent.id,
    conversation_id: input.conversationId,
    routine_id: input.routineId ?? null,
    parent_run_id: input.parentRunId ?? null,
    trigger: input.trigger,
    status: "queued",
    prompt: redact(input.prompt),
    created_at: now(),
  });
  const assistant = addMessage({ conversationId: input.conversationId, role: "assistant", content: "", blocks: [], runId });

  jobs.set(runId, {
    runId,
    agentId: agent.id,
    conversationId: input.conversationId,
    messageId: assistant.id,
    userMessageId,
    prompt: input.prompt,
    trigger: input.trigger,
    parentRunId: input.parentRunId ?? null,
    depth: input.depth ?? 0,
    voice: input.voice ?? false,
    status: "queued",
    acc: new StreamAccumulator(),
    proc: null,
    cancelReason: null,
    timedOut: false,
    lastLabel: "",
    lastDeltaAt: 0,
    lastPersistAt: 0,
    deltaTimer: null,
    done: null,
  });
  queue.push(runId);
  bus.emit({ type: "run.started", run: getRun(runId) });
  bus.changed("runs");
  emitConversationUpdated(input.conversationId);
  pump();
  return getRun(runId);
}

export async function cancelRun(runId: string, reason = "Cancelled"): Promise<void> {
  const job = jobs.get(runId);
  if (!job) {
    const row = get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
    if (!row) throw notFound("Run");
    if (!TERMINAL.has(row.status)) {
      // Stale row (no live job): close it.
      sql("UPDATE runs SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?", reason, now(), runId);
      bus.emit({ type: "run.finished", run: getRun(runId) });
      bus.changed("runs");
    }
    return;
  }
  // Cancelling a run also cancels the work it delegated.
  for (const child of [...jobs.values()]) {
    if (child.parentRunId === runId) await cancelRun(child.runId, "Cancelled (parent run was cancelled)");
  }
  job.cancelReason ??= reason;
  if (job.status === "queued") {
    const idx = queue.indexOf(runId);
    if (idx >= 0) queue.splice(idx, 1);
    await finalize(job, { status: "cancelled", error: job.cancelReason }, null, Date.now());
    return;
  }
  if (job.proc) killTree(job.proc);
  // A job still in setup (no process yet) checks cancelReason before spawning.
}

/** Resolve when the run reaches a terminal state, or with its current state after `timeoutMs`. */
export function waitForRun(runId: string, timeoutMs?: number): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      off();
      if (timer) clearTimeout(timer);
      fn();
    };
    const off = bus.on((e) => {
      if (e.type === "run.finished" && e.run.id === runId) finish(() => resolve(e.run));
    });
    let current: Run;
    try {
      current = getRun(runId);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    if (TERMINAL.has(current.status) && !jobs.has(runId)) {
      finish(() => resolve(current));
      return;
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => finish(() => resolve(getRun(runId))), timeoutMs);
    }
  });
}

/** Mark runs left in queued/running state by a previous process as failed. */
export function recoverInterruptedRuns(): void {
  const stale = all<RunRow>("SELECT * FROM runs WHERE status IN ('queued', 'running')").filter((r) => !jobs.has(r.id));
  if (!stale.length) return;
  const ts = now();
  const agentIds = new Set<string>();
  for (const r of stale) {
    sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", INTERRUPTED, ts, r.id);
    agentIds.add(r.agent_id);
    for (const m of all<{ id: string; content: string; blocks: string }>(
      "SELECT id, content, blocks FROM messages WHERE run_id = ? AND role = 'assistant'",
      r.id,
    )) {
      const blocks = parseJson<Message["blocks"]>(m.blocks, []);
      blocks.push({ type: "error", text: INTERRUPTED });
      sql("UPDATE messages SET blocks = ? WHERE id = ?", JSON.stringify(blocks), m.id);
    }
  }
  for (const agentId of agentIds) safely("reset agent status", () => setAgentStatus(agentId, "idle"));
  log.info(`marked ${stale.length} interrupted run(s) as failed`);
  bus.changed("runs");
}

export async function shutdownRunner(): Promise<void> {
  shuttingDown = true;
  for (const runId of [...queue]) {
    const job = jobs.get(runId);
    if (job) await cancelRun(runId, "Cancelled (Godmode shut down)");
  }
  const running = [...jobs.values()].filter((j) => j.status === "running");
  for (const job of running) {
    job.cancelReason ??= "Cancelled (Godmode shut down)";
    if (job.proc) killTree(job.proc);
  }
  await Promise.race([
    Promise.allSettled(running.map((j) => j.done ?? Promise.resolve())),
    new Promise((r) => setTimeout(r, KILL_GRACE_MS + 2000)),
  ]);
  try {
    await stopClaudeMemWorkers(listAgents({ workspaceId: "all" }));
  } catch (err) {
    log.warn("could not stop claude-mem workers", err);
  }
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

function pump() {
  if (shuttingDown) return;
  const max = Math.max(1, Math.floor(getSettings().runner.maxConcurrentRuns || 1));
  let running = [...jobs.values()].filter((j) => j.status === "running").length;
  const blocked = new Set<string>();
  for (const runId of [...queue]) {
    const job = jobs.get(runId);
    if (!job) {
      queue.splice(queue.indexOf(runId), 1);
      continue;
    }
    const convBusy = [...jobs.values()].some((j) => j.status === "running" && j.conversationId === job.conversationId);
    if (convBusy || blocked.has(job.conversationId)) {
      blocked.add(job.conversationId);
      continue;
    }
    // A delegated run whose parent is running (and typically waiting for it) may exceed the limit — otherwise
    // a parent holding the last slot would deadlock on its own child.
    const parentRunning = !!job.parentRunId && jobs.get(job.parentRunId)?.status === "running";
    if (running >= max && !parentRunning) {
      blocked.add(job.conversationId);
      continue;
    }
    // One browser profile = one Chromium: two independent runs driving it at once would fight over tabs and
    // focus. A run waits while another run holds its profile — unless that run is its own ancestor in the
    // delegation chain (the parent is idle, waiting for this child).
    const holder = browserHolder(job);
    if (holder) {
      emitActivity(job, `Waiting for the browser (in use by another run)`);
      blocked.add(job.conversationId);
      continue;
    }
    queue.splice(queue.indexOf(runId), 1);
    job.status = "running";
    running++;
    job.done = execute(job)
      .catch((err) => log.error(`run ${runId} crashed`, err))
      .finally(() => {
        jobs.delete(runId);
        missingLoginReported.delete(runId);
        pump();
      });
  }
}

function browserProfileOf(job: Job): string | null {
  if (job.browserProfileId !== undefined) return job.browserProfileId;
  try {
    const agent = getAgent(job.agentId);
    job.browserProfileId =
      getSettings().browser.enabled && agent.browser.enabled ? resolveProfileForAgent(agent).id : null;
  } catch {
    job.browserProfileId = null;
  }
  return job.browserProfileId;
}

function isAncestor(candidate: Job, job: Job): boolean {
  let parentId = job.parentRunId;
  for (let hops = 0; parentId && hops < 16; hops++) {
    if (parentId === candidate.runId) return true;
    parentId = jobs.get(parentId)?.parentRunId ?? null;
  }
  return false;
}

/** The running job currently holding `job`'s browser profile (excluding its own ancestors), if any. */
function browserHolder(job: Job): Job | null {
  const profileId = browserProfileOf(job);
  if (!profileId) return null;
  for (const other of jobs.values()) {
    if (other === job || other.status !== "running") continue;
    if (browserProfileOf(other) === profileId && !isAncestor(other, job)) return other;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

interface Resources {
  token: string | null;
  files: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

function writeTempFile(res: Resources, name: string, content: string): string {
  const path = join(tmpdir(), name);
  writeFileSync(path, content, { mode: 0o600 });
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
  res.files.push(path);
  return path;
}

function buildEnv(agent: Agent): Record<string, string | undefined> {
  const env = claudeEnv();
  if (getSettings().memory.backend === "claude-mem" && claudeMemPluginDir()) Object.assign(env, claudeMemEnv(agent));
  return env;
}

function emitActivity(job: Job, label: string) {
  if (label === job.lastLabel) return;
  job.lastLabel = label;
  bus.emit({ type: "run.activity", runId: job.runId, agentId: job.agentId, label });
}

function imageBytes(job: Job): number {
  let n = 0;
  for (const b of job.acc.blocks) if (b.type === "tool_use" && b.image) n += b.image.length;
  return n;
}

function emitDelta(job: Job) {
  if (job.deltaTimer) {
    clearTimeout(job.deltaTimer);
    job.deltaTimer = null;
  }
  job.lastDeltaAt = Date.now();
  const blocks = redactBlocks(job.acc.blocks, redact);
  const textDelta = redact(job.acc.takeTextDelta());
  bus.emit({
    type: "run.delta",
    runId: job.runId,
    conversationId: job.conversationId,
    messageId: job.messageId,
    blocks,
    ...(textDelta ? { textDelta } : {}),
  });
  if (Date.now() - job.lastPersistAt >= PERSIST_INTERVAL_MS) {
    job.lastPersistAt = Date.now();
    safely("persist in-flight message", () => updateMessage(job.messageId, { blocks }, { emit: false }));
  }
}

function scheduleDelta(job: Job) {
  if (job.deltaTimer) return;
  // Screenshots make every delta heavy: slow down instead of flooding the WebSocket.
  const interval = imageBytes(job) > 1_000_000 ? DELTA_INTERVAL_HEAVY_MS : DELTA_INTERVAL_MS;
  const wait = Math.max(0, interval - (Date.now() - job.lastDeltaAt));
  job.deltaTimer = setTimeout(() => emitDelta(job), wait);
}

async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readTail(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for await (const chunk of chunksOf(stream)) {
      tail += decoder.decode(chunk, { stream: true });
      if (tail.length > max * 2) tail = tail.slice(-max);
    }
    tail += decoder.decode();
  } catch {
    /* stream closed */
  }
  return tail.slice(-max);
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of chunksOf(stream)) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
  }
  buf += decoder.decode();
  if (buf) onLine(buf);
}

interface Attempt {
  exitCode: number | null;
  stderr: string;
  /** Non-JSON stdout lines (CLI errors printed as text). */
  noise: string[];
}

async function spawnClaude(
  job: Job,
  cmd: string[],
  args: string[],
  prompt: string,
  agent: Agent,
  env: Record<string, string | undefined>,
  logSink: FileSink,
): Promise<Attempt> {
  const noise: string[] = [];
  const proc = Bun.spawn({
    cmd: [...cmd, ...args],
    cwd: agent.repoPath,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group on POSIX so cancel/timeout can kill the whole tree.
    detached: process.platform !== "win32",
  });
  job.proc = proc;
  if (job.cancelReason) killTree(proc);
  try {
    proc.stdin.write(prompt);
    await proc.stdin.end();
  } catch (err) {
    log.warn(`could not write the prompt to claude (run ${job.runId})`, err);
  }
  const stderrP = readTail(proc.stderr, STDERR_TAIL_BYTES);
  await readLines(proc.stdout, (raw) => {
    const line = raw.trim();
    if (!line) return;
    logSink.write(`${redact(line)}\n`);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      noise.push(line.slice(0, 500));
      if (noise.length > 20) noise.shift();
      return;
    }
    if (job.acc.push(event)) scheduleDelta(job);
    emitActivity(job, job.acc.activityLabel());
  });
  const exitCode = await proc.exited;
  const stderr = await stderrP;
  job.proc = null;
  return { exitCode, stderr, noise };
}

function recapPrefix(job: Job): string {
  const msgs = listMessages(job.conversationId)
    .filter((m) => m.id !== job.messageId && m.id !== job.userMessageId && m.role !== "system" && m.content.trim())
    .slice(-10);
  if (!msgs.length) return "";
  const lines = msgs.map((m) => {
    const text = m.content.length > 1500 ? `${m.content.slice(0, 1499)}…` : m.content;
    return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
  });
  return `<godmode-context>\nThe previous Claude session of this conversation could not be restored. Recap of the most recent messages:\n\n${lines.join("\n\n")}\n</godmode-context>\n\n`;
}

function describeFailure(job: Job, attempt: Attempt): string {
  const final = job.acc.final;
  const stderr = attempt.stderr.trim();
  const haystack = [final?.errors.join("\n") ?? "", final?.text ?? "", stderr, attempt.noise.join("\n")].join("\n");
  if (AUTH_PROBLEM.test(haystack)) {
    return "Claude Code is not signed in (or the API key is invalid). Run `claude` in a terminal and log in, or add an Anthropic API key in Settings.";
  }
  if (final) {
    if (final.errors.length) return final.errors.join("; ");
    switch (final.subtype) {
      case "error_max_turns":
        return "Stopped after reaching the maximum number of turns.";
      case "error_max_budget_usd":
        return "Stopped: the run reached its cost budget.";
      case "error_during_execution":
        return final.text || "Claude Code failed during execution.";
      default:
        return final.text || `Claude Code reported an error (${final.subtype ?? "unknown"}).`;
    }
  }
  const lastLines = (stderr || attempt.noise.join("\n"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5)
    .join("\n");
  if (lastLines) return lastLines.length > 1000 ? lastLines.slice(-1000) : lastLines;
  return attempt.exitCode ? `Claude Code exited with code ${attempt.exitCode}` : "Claude Code exited without a result";
}

async function runClaude(job: Job, agent: Agent, res: Resources): Promise<Outcome> {
  const settings = getSettings();
  const cmd = resolveClaudeCommand();
  if (!cmd) return { status: "failed", error: CLAUDE_NOT_FOUND };
  // Claude runs with cwd = the agent repo; rebuild it if it went missing (e.g. restored backup without repos).
  await ensureAgentRepo(agent);

  const conv = get<{ claude_session_id: string | null; model: string | null; effort: Effort | null }>(
    "SELECT claude_session_id, model, effort FROM conversations WHERE id = ?",
    job.conversationId,
  );
  if (!conv) return { status: "cancelled", error: "Conversation was deleted" };

  res.token = issueRunToken({
    runId: job.runId,
    agentId: agent.id,
    conversationId: job.conversationId,
    workspaceId: agent.workspaceId,
    depth: job.depth,
  });
  const mcp = await buildMcpConfig(agent, res.token, { onNotice: (text) => job.acc.addNotice("warning", text) });
  const mcpPath = writeMcpConfigFile(job.runId, mcp);
  res.files.push(mcpPath);
  if (job.acc.blocks.length) scheduleDelta(job);

  const canDelegate = agent.permissions.allowDelegation || agent.permissions.canManageAgents;
  let peers: Agent[] = [];
  if (canDelegate) {
    try {
      peers = peersFor(agent);
    } catch (err) {
      log.warn(`could not list peers of agent ${agent.id}`, err);
    }
  }
  const systemPrompt = buildSystemPrompt({
    agent,
    settings,
    peers,
    browserAvailable: "browser" in mcp.mcpServers,
    voice: job.voice,
  });

  const model = conv.model?.trim() || agent.model?.trim() || settings.runner.model?.trim() || DEFAULT_MODEL;
  const effort = effortFor(model, conv.effort || agent.effort || settings.runner.effort || null);
  job.model = model;
  if (!isModelId(model)) return { status: "failed", error: `Invalid model id "${model}"` };
  const fallback = settings.runner.fallbackModel?.trim();
  const budget = agent.permissions.maxBudgetUsd ?? settings.runner.defaultMaxBudgetUsd;
  // cmd.exe cannot pass multi-line arguments: use the file variants for Windows .cmd shims.
  const viaFiles = cmd[0] === "cmd.exe";

  const baseArgs = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", model];
  if (effort) baseArgs.push("--effort", effort);
  if (fallback && fallback !== model && isModelId(fallback)) baseArgs.push("--fallback-model", fallback);
  if (settings.runner.bypassPermissions) baseArgs.push("--dangerously-skip-permissions");
  else {
    // Non-bypass mode: allow Godmode-provided MCP tools without prompts (print mode cannot ask).
    baseArgs.push("--permission-mode", "acceptEdits", "--allowedTools", Object.keys(mcp.mcpServers).map((n) => `mcp__${n}`).join(","));
  }
  baseArgs.push("--mcp-config", mcpPath, "--strict-mcp-config");
  // Hide browser-use tools that need their own LLM key when none is configured (they would only error).
  if (mcp.mcpServers[BROWSER_MCP_NAME] && !browserLlmKey()) {
    baseArgs.push("--disallowedTools", BROWSER_LLM_TOOLS.map((t) => `mcp__${BROWSER_MCP_NAME}__${t}`).join(","));
  }
  if (viaFiles) baseArgs.push("--append-system-prompt-file", writeTempFile(res, `godmode-prompt-${job.runId}.md`, systemPrompt));
  else baseArgs.push("--append-system-prompt", systemPrompt);
  baseArgs.push("--setting-sources", "project,local");
  if (budget != null && budget > 0) baseArgs.push("--max-budget-usd", String(budget));
  if (agent.subagents.length) {
    const defs: Record<string, { description: string; prompt: string; model?: string }> = {};
    for (const s of agent.subagents) {
      if (!s.name?.trim()) continue;
      defs[s.name.trim()] = { description: s.description, prompt: s.prompt, ...(s.model ? { model: s.model } : {}) };
    }
    if (Object.keys(defs).length) {
      const json = JSON.stringify(defs);
      baseArgs.push("--agents", viaFiles ? writeTempFile(res, `godmode-agents-${job.runId}.json`, json) : json);
    }
  }
  if (settings.memory.backend === "claude-mem") {
    const pluginDir = claudeMemPluginDir();
    if (pluginDir) baseArgs.push("--plugin-dir", pluginDir);
    else {
      job.acc.addNotice(
        "warning",
        "The claude-mem memory backend is selected but not installed — install it in Settings → System. Using file memory (MEMORY.md) for now.",
      );
    }
  }
  const extraArgs = (settings.runner.extraArgs ?? []).filter((a) => typeof a === "string" && a.length > 0);

  const env = buildEnv(agent);
  const logPath = runLogPath(agent, getRun(job.runId));
  mkdirSync(join(logPath, ".."), { recursive: true });
  const logSink = Bun.file(logPath).writer();

  const timeoutMinutes = settings.runner.runTimeoutMinutes;
  if (timeoutMinutes > 0) {
    res.timer = setTimeout(() => {
      job.timedOut = true;
      log.warn(`run ${job.runId} timed out after ${timeoutMinutes} min`);
      if (job.proc) killTree(job.proc);
    }, timeoutMinutes * 60_000);
  }

  try {
    let sessionId = conv.claude_session_id;
    const resuming = !!sessionId;
    if (!sessionId) {
      sessionId = randomUUID();
      setConversationState(job.conversationId, { claudeSessionId: sessionId });
    }
    if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
    const sessionArgs = resuming ? ["--resume", sessionId] : ["--session-id", sessionId];
    const prompt = resuming ? resumeContextPrefix() + job.prompt : job.prompt;
    let attempt = await spawnClaude(job, cmd, [...baseArgs, ...sessionArgs, ...extraArgs], prompt, agent, env, logSink);

    const lostSession =
      resuming &&
      !job.cancelReason &&
      !job.timedOut &&
      (!job.acc.final || job.acc.final.isError) &&
      SESSION_MISSING.test([job.acc.final?.errors.join("\n") ?? "", attempt.stderr, attempt.noise.join("\n")].join("\n"));
    if (lostSession) {
      log.info(`Claude session ${sessionId} of conversation ${job.conversationId} is gone; starting a new one with a recap`);
      const notices = job.acc.blocks.filter((b) => b.type === "notice");
      job.acc = new StreamAccumulator();
      for (const n of notices) if (n.type === "notice") job.acc.addNotice(n.level, n.text);
      sessionId = randomUUID();
      setConversationState(job.conversationId, { claudeSessionId: sessionId });
      attempt = await spawnClaude(
        job,
        cmd,
        [...baseArgs, "--session-id", sessionId, ...extraArgs],
        recapPrefix(job) + job.prompt,
        agent,
        env,
        logSink,
      );
    }

    if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
    if (job.timedOut) return { status: "failed", error: `Timed out after ${timeoutMinutes} minutes` };
    const final = job.acc.final;
    if (final && !final.isError) return { status: "succeeded", error: null };
    return { status: "failed", error: describeFailure(job, attempt) };
  } finally {
    try {
      await logSink.end();
    } catch (err) {
      log.warn(`could not close run log ${logPath}`, err);
    }
  }
}

async function execute(job: Job): Promise<void> {
  const startedMs = Date.now();
  sql("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", now(), job.runId);
  bus.emit({ type: "run.started", run: getRun(job.runId) });
  emitConversationUpdated(job.conversationId);
  emitActivity(job, "Starting…");

  const res: Resources = { token: null, files: [], timer: null };
  let outcome: Outcome;
  let agent: Agent | null = null;
  try {
    agent = getAgent(job.agentId);
    const a = agent;
    safely("set agent status", () => setAgentStatus(a.id, "running"));
    outcome = await runClaude(job, agent, res);
  } catch (err) {
    log.error(`run ${job.runId} failed to start`, err);
    outcome = { status: "failed", error: errorText(err) };
  } finally {
    if (res.timer) clearTimeout(res.timer);
    if (res.token) revokeRunToken(res.token);
    for (const f of res.files) removeMcpConfigFile(f);
  }
  // Always push the final streamed state (a throttled delta may still be pending).
  if (job.status === "running") safely("emit final delta", () => emitDelta(job));
  if (job.cancelReason && outcome.status !== "cancelled") outcome = { status: "cancelled", error: job.cancelReason };
  await finalize(job, outcome, agent, startedMs);
}

/** Persist the outcome, emit events, append the transcript, run post-run hooks. Never throws. */
async function finalize(job: Job, outcome: Outcome, agent: Agent | null, startedMs: number): Promise<void> {
  // No longer active: `running` flags, waiters and the queue must see that before run.finished goes out.
  jobs.delete(job.runId);
  const idx = queue.indexOf(job.runId);
  if (idx >= 0) queue.splice(idx, 1);
  const acc = job.acc;
  const final = acc.final;
  const text = redact(acc.finalText());
  const blocks = redactBlocks(acc.blocks, redact);
  const error = outcome.error ? redact(outcome.error) : null;
  if (outcome.status === "failed" && error) blocks.push({ type: "error", text: error });
  if (outcome.status === "cancelled") blocks.push({ type: "notice", level: "info", text: error ?? "Cancelled" });
  const ts = now();
  const wasRunning = job.status === "running";

  safely("update run row", () =>
    sql(
      `UPDATE runs SET status = ?, result = ?, error = ?, cost_usd = ?, duration_ms = ?, num_turns = ?, usage = ?, model = ?, finished_at = ? WHERE id = ?`,
      outcome.status,
      text || null,
      error,
      final?.costUsd ?? null,
      final?.durationMs ?? (wasRunning ? Date.now() - startedMs : null),
      final?.numTurns ?? null,
      final?.usage ? JSON.stringify(final.usage) : null,
      acc.model ?? job.model ?? (agent ? agent.model || getSettings().runner.model || null : null),
      ts,
      job.runId,
    ),
  );

  const convAlive = conversationExists(job.conversationId);
  let assistant: Message | null = null;
  if (convAlive) {
    safely("finalize assistant message", () => {
      assistant = updateMessage(job.messageId, { content: text, blocks });
    });
    safely("update conversation", () => {
      const row = get<{ title: string }>("SELECT title FROM conversations WHERE id = ?", job.conversationId);
      const title =
        row?.title === DEFAULT_CONVERSATION_TITLE && job.userMessageId ? autoTitle(job.userMessageId) : undefined;
      setConversationState(job.conversationId, {
        ...(acc.sessionId ? { claudeSessionId: acc.sessionId } : {}),
        lastMessageAt: ts,
        ...(title && title !== DEFAULT_CONVERSATION_TITLE ? { title } : {}),
      });
    });
  }

  if (wasRunning) {
    const others = [...jobs.values()].some((j) => j !== job && j.agentId === job.agentId && j.status === "running");
    if (!others) safely("set agent status", () => setAgentStatus(job.agentId, "idle"));
    safely("touch agent", () => touchAgentRun(job.agentId));
  }

  let finished: Run | null = null;
  try {
    finished = getRun(job.runId);
  } catch (err) {
    log.error(`run ${job.runId} vanished`, err);
  }
  emitActivity(job, outcome.status === "succeeded" ? "Done" : outcome.status === "cancelled" ? "Cancelled" : "Failed");
  if (finished) bus.emit({ type: "run.finished", run: finished });
  bus.changed("runs");
  if (convAlive) emitConversationUpdated(job.conversationId);

  if (wasRunning && finished && convAlive) {
    const done = finished;
    safely("append transcript", () => {
      const user = job.userMessageId ? getMessage(job.userMessageId) : null;
      appendTranscript(job.conversationId, done, user, assistant);
    });
  }
  // Start the next queued turn (e.g. a follow-up message in this conversation) right away.
  pump();

  if (!wasRunning || !finished || !agent) return;
  if (outcome.status !== "cancelled") await detectMissingLogin(job, agent, text);

  if (getSettings().memory.autoCommit) {
    const title = get<{ title: string }>("SELECT title FROM conversations WHERE id = ?", job.conversationId)?.title ?? job.trigger;
    const message = `Run ${job.runId.slice(-6)}: ${title}`;
    commitAgentRepo(job.agentId, message).catch((err) => log.warn(`auto-commit for agent ${job.agentId} failed`, err));
  }
}

function autoTitle(userMessageId: string): string | undefined {
  try {
    const m = getMessage(userMessageId);
    if (m.content.trim()) return titleFromContent(m.content);
    if (m.attachments[0]) return titleFromContent(m.attachments[0].name);
  } catch {
    /* message gone */
  }
  return undefined;
}

async function detectMissingLogin(job: Job, agent: Agent, text: string) {
  if (missingLoginReported.has(job.runId)) return;
  for (const name of job.acc.toolsCalled) if (name.endsWith("report_missing_login")) return;
  const reason = detectLoginFailure(text);
  if (!reason) return;
  let service = "Unknown service";
  let url = "";
  if (agent.browser.enabled) {
    try {
      const page = await currentPage(resolveProfileForAgent(agent).id);
      if (page?.url && /^https?:/i.test(page.url)) {
        url = page.url;
        service = hostnameOf(page.url) || service;
      }
    } catch (err) {
      log.debug(`no current page for agent ${agent.id}`, err);
    }
  }
  try {
    reportMissingLogin({ agentId: agent.id, runId: job.runId, workspaceId: agent.workspaceId, kind: "other", service, url, reason });
    log.info(`run ${job.runId}: detected a login problem (${service})`);
  } catch (err) {
    log.warn(`could not record missing login for run ${job.runId}`, err);
  }
}
