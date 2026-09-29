/**
 * Runs Claude Code CLI for an agent turn and streams the results (owner: runner).
 *
 * One run = one `claude -p` process (prompt on stdin, stream-json on stdout) in the agent's repo (or the folder
 * attached to the chat, with the repo added via --add-dir), resuming
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
import type { Agent, BrowserProfile, ComputerTarget, Effort, Message, Run, RunStatus, RunTrigger, RunUsage } from "@godmode/shared";
import { BROWSER_MCP_NAME, CUA_MCP_NAME, DEFAULT_MODEL, EFFORT_OPTIONS, isModelId, parseSlashCommand } from "@godmode/shared";
import { all, get, insert, run as sql } from "../db";
import { bus } from "../events/bus";
import { excerpt, logger } from "../log";
import { HttpError, badRequest, conflict, hostnameOf, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { commitAgentRepo, ensureAgentRepo, getAgent, listAgents, peersFor, setAgentStatus, touchAgentRun } from "../agents/service";
import { isDirectory, workingDirectoryProblem } from "../services/folders";
import { prepareSources, type RunSource } from "../services/workspaceSources";
import { getSettings } from "../services/settings";
import { reportMissingLogin } from "../services/missingLogins";
import { BROWSER_LLM_TOOLS, browserLlmKey, chatProfileId, currentPage, getProfile, releaseChatBrowser, resolveProfileForAgent } from "../browser/manager";
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
import { memoryDigest, memoryForPrompt } from "../memory/files";
import { claudeEnv, killTree, resolveClaudeCommand } from "./claude";
import { buildMcpConfig, removeMcpConfigFile, writeMcpConfigFile } from "./mcpConfig";
import { effortFor } from "./models";
import { buildDreamSystemPrompt, buildSystemPrompt, instructionsDigest, instructionsSection, resumeContextPrefix, type PromptApiTool, type PromptVm } from "./prompt";
import { apiToolEnv, apiToolsForAgent } from "../integrations/apiTools";
import { attachComputer, computerLockKey, detachComputer } from "../computer/service";
import { attachVm, detachVm, type RunVm } from "../vm/service";
import { CUA_HIDDEN_TOOLS, currentVmPage, prepareGuest, type GuestTools } from "../vm/guest";
import { resolveVmId } from "../vm/assignments";
import { parseComputerTarget } from "../computer/targets";
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
  /** Id for the run (callers that must know it before the run can start or finish). Default: a new one. */
  runId?: string;
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
/** Built-in Claude Code tools of a dream run: reading and editing the memory files, nothing else. */
const DREAM_TOOLS = "Read,Write,Edit,Glob,Grep";
/**
 * What a dream may change without asking (print mode denies everything else): its memory files and the report tool.
 * Edit rules cover every built-in tool that writes files.
 */
const DREAM_ALLOWED = ["Edit(./MEMORY.md)", "Edit(./memory/**)", "mcp__godmode"];
/** A dream holds the agent's memory while it runs: never for longer than this. */
const DREAM_TIMEOUT_MINUTES = 20;

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
  /**
   * The browser this run drives (undefined = not resolved yet, null = no browser): the browser profile, or `vm:<id>`
   * for a run in a VM (its browser and screen are the VM's — runs in one VM take turns).
   */
  browserLock?: string | null;
  /** The VM the run works in (undefined = not resolved yet, null = none). */
  vmId?: string | null;
  /** The run drove the Chrome in its VM. */
  vmBrowser?: boolean;
  /** The browser profile was picked for the run's chat rather than inherited from its agent. */
  browserFromChat?: boolean;
  /** Screen, window or tab this run may control (undefined = not resolved yet, null = none). */
  computerTarget?: ComputerTarget | null;
  /** The target is the agent's own unattended access, not something shared in the chat. */
  computerFromAgent?: boolean;
  /** `--model` value the run was started with. */
  model?: string;
  /** A slash command ran in a replacement session: keep the lost one so the next message still gets the recap. */
  keepSessionId?: string;
  /** Digest of the standing instructions restated in this run's prompt; recorded once the run succeeds. */
  restatedDigest?: string;
  /** Digest of the MEMORY.md this run's Claude session was shown (or told about) when it started. */
  memorySeen?: string;
}

/** The session may no longer hold the instructions it was given: restate them on the next turn. */
const STALE_DIGEST = "stale";

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

  const runId = input.runId ?? newId("run");
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
  // Dreams don't take run slots (there is at most one at a time), so they never hold up anyone's work.
  let running = [...jobs.values()].filter((j) => j.status === "running" && j.trigger !== "dream").length;
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
    if (job.trigger === "dream" ? [...jobs.values()].some((j) => j.trigger === "dream" && j.status === "running") : running >= max && !parentRunning) {
      blocked.add(job.conversationId);
      continue;
    }
    // Runs sharing a browser profile don't wait for each other: every chat works in its own tabs.
    // A dream owns the agent's memory: it waits for the agent's other runs, and they wait while it runs.
    if (memoryHolder(job)) {
      emitActivity(job, job.trigger === "dream" ? "Waiting for other runs to finish before dreaming" : "Waiting — consolidating memory (dreaming)");
      blocked.add(job.conversationId);
      continue;
    }
    // Re-read the VM right before deciding: the chat's VM may have changed while the run was queued.
    job.vmId = undefined;
    job.browserLock = undefined;
    const holder = browserHolder(job);
    if (holder) {
      emitActivity(job, "Waiting for the VM (another run is working in it)");
      blocked.add(job.conversationId);
      continue;
    }
    // The desktop has one mouse and keyboard: runs controlling it take turns (a shared window or tab only locks itself).
    // Re-read what is shared right before deciding, so the lock and the run use the same target.
    job.computerTarget = undefined;
    if (computerHolder(job)) {
      emitActivity(job, `Waiting for the computer (in use by another run)`);
      blocked.add(job.conversationId);
      continue;
    }
    queue.splice(queue.indexOf(runId), 1);
    job.status = "running";
    if (job.trigger !== "dream") running++;
    job.done = execute(job)
      .catch((err) => log.error(`run ${runId} crashed`, err))
      .finally(() => {
        jobs.delete(runId);
        missingLoginReported.delete(runId);
        pump();
      });
  }
}

/** A running job of the same agent that conflicts with `job` over the agent's memory (one of them is a dream). */
function memoryHolder(job: Job): Job | null {
  for (const other of jobs.values()) {
    if (other === job || other.status !== "running" || other.agentId !== job.agentId) continue;
    if (job.trigger === "dream" || other.trigger === "dream") return other;
  }
  return null;
}

/** The VM the run works in: its chat's, else its agent's, else its workspace's. */
function vmOf(job: Job): string | null {
  if (job.vmId !== undefined) return job.vmId;
  if (job.trigger === "dream") return (job.vmId = null);
  try {
    job.vmId = resolveVmId(job.conversationId, getAgent(job.agentId));
  } catch {
    job.vmId = null;
  }
  return job.vmId;
}

function browserLockOf(job: Job): string | null {
  if (job.browserLock !== undefined) return job.browserLock;
  job.browserFromChat = false;
  if (job.trigger === "dream") return (job.browserLock = null);
  // One screen, one mouse and one Chrome per VM: runs working in the same VM take turns.
  const vmId = vmOf(job);
  if (vmId) return (job.browserLock = `vm:${vmId}`);
  try {
    const agent = getAgent(job.agentId);
    job.browserLock = getSettings().browser.enabled && agent.browser.enabled ? resolveProfileForAgent(agent, job.conversationId).id : null;
    job.browserFromChat = !!job.browserLock && job.browserLock === chatProfileId(job.conversationId);
  } catch {
    job.browserLock = null;
  }
  return job.browserLock;
}

/** The browser profile the run drives on this computer (null for none or a run in a VM). */
function runProfileOf(job: Job): string | null {
  const lock = browserLockOf(job);
  return lock && !lock.startsWith("vm:") ? lock : null;
}

/** Browser profile a live run drives on this computer; null when it has none, works in a VM or is over. */
export function runBrowserProfile(runId: string): string | null {
  const job = jobs.get(runId);
  return job ? runProfileOf(job) : null;
}

/** The profile a live run drives when it was picked for its chat (null when inherited, gone or the run is over). */
export function runChatBrowserProfile(runId: string): BrowserProfile | null {
  const job = jobs.get(runId);
  const id = job ? runProfileOf(job) : null;
  if (!id || !job?.browserFromChat) return null;
  try {
    return getProfile(id);
  } catch {
    return null;
  }
}

/** Something a waiting run depends on changed (e.g. its chat's browser profile): try to start queued runs again. */
export function retryQueued(): void {
  pump();
}

function isAncestor(candidate: Job, job: Job): boolean {
  let parentId = job.parentRunId;
  for (let hops = 0; parentId && hops < 16; hops++) {
    if (parentId === candidate.runId) return true;
    parentId = jobs.get(parentId)?.parentRunId ?? null;
  }
  return false;
}

/**
 * What the run may control: the screen, window or tab shared in its conversation, else — for agents allowed to use
 * the computer on their own (routines, delegated work) — their configured target (default: the whole desktop).
 * Nothing for a run in a VM: it uses the VM's screen and apps, never this computer's.
 */
export function computerTargetOf(job: {
  agentId: string;
  conversationId: string;
  trigger?: RunTrigger;
  computerTarget?: ComputerTarget | null;
  computerFromAgent?: boolean;
}): ComputerTarget | null {
  if (job.computerTarget !== undefined) return job.computerTarget;
  let target: ComputerTarget | null = null;
  let fromAgent = false;
  try {
    // Dreams only read and edit memory files.
    const agent = getAgent(job.agentId);
    if (getSettings().computer.enabled && job.trigger !== "dream" && !resolveVmId(job.conversationId, agent)) {
      const conv = get<{ computer_target: string | null }>("SELECT computer_target FROM conversations WHERE id = ?", job.conversationId);
      target = parseComputerTarget(parseJson<unknown>(conv?.computer_target, null));
      if (!target && agent.computer.enabled) {
        target = agent.computer.target ?? { kind: "desktop" };
        fromAgent = true;
      }
    }
  } catch {
    target = null;
  }
  job.computerTarget = target;
  job.computerFromAgent = fromAgent;
  return target;
}

/** The running job controlling the same screen/window/tab as `job` (excluding its own ancestors), if any. */
function computerHolder(job: Job): Job | null {
  const target = computerTargetOf(job);
  if (!target) return null;
  const key = computerLockKey(target);
  for (const other of jobs.values()) {
    if (other === job || other.status !== "running") continue;
    const t = computerTargetOf(other);
    if (t && computerLockKey(t) === key && !isAncestor(other, job)) return other;
  }
  return null;
}

/**
 * The running job working in the same VM as `job` (excluding its own ancestors), if any. Runs sharing a browser profile
 * on this computer don't wait for each other: every chat works in its own tabs.
 */
function browserHolder(job: Job): Job | null {
  const lock = browserLockOf(job);
  if (!lock?.startsWith("vm:")) return null;
  for (const other of jobs.values()) {
    if (other === job || other.status !== "running") continue;
    if (browserLockOf(other) === lock && !isAncestor(other, job)) return other;
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

export function buildEnv(agent: Agent, inFolder = false, apiKeys = true): Record<string, string | undefined> {
  const env = claudeEnv();
  // Load CLAUDE.md files from --add-dir folders: the agent's repo when the cwd is an attached folder, and the workspace's folders.
  if (inFolder) env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
  if (getSettings().memory.backend === "claude-mem" && claudeMemPluginDir()) Object.assign(env, claudeMemEnv(agent));
  // API tools that hand their key to runs (Integrations → Tools).
  if (apiKeys) Object.assign(env, apiToolEnv(agent));
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
  cwd: string,
  env: Record<string, string | undefined>,
  logSink: FileSink,
): Promise<Attempt> {
  const noise: string[] = [];
  const proc = Bun.spawn({
    cmd: [...cmd, ...args],
    cwd,
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
  // Every run needs the agent repo (cwd or --add-dir); rebuild it if it went missing (e.g. restored backup without repos).
  await ensureAgentRepo(agent);

  const conv = get<{
    claude_session_id: string | null;
    working_directory: string | null;
    model: string | null;
    effort: Effort | null;
    instructions: string | null;
    instructions_digest: string | null;
    memory_digest: string | null;
  }>(
    "SELECT claude_session_id, working_directory, model, effort, instructions, instructions_digest, memory_digest FROM conversations WHERE id = ?",
    job.conversationId,
  );
  if (!conv) return { status: "cancelled", error: "Conversation was deleted" };
  const dreaming = job.trigger === "dream";
  // A dream always works in the agent's repository, on its memory files.
  const folder = dreaming ? null : (conv.working_directory ?? agent.workingDirectory);
  const problem = folder && (isDirectory(folder) ? workingDirectoryProblem(folder) : `The folder ${folder} doesn't exist anymore.`);
  if (problem) {
    const fix = conv.working_directory ? "Pick another folder for this chat." : `Change the default folder in ${agent.name}'s settings.`;
    return { status: "failed", error: `${problem} ${fix}` };
  }
  const cwd = folder ?? agent.repoPath;

  res.token = issueRunToken({
    runId: job.runId,
    agentId: agent.id,
    conversationId: job.conversationId,
    workspaceId: agent.workspaceId,
    depth: job.depth,
  });
  // What the lock was decided on — unless the human stopped (or changed) sharing while the run was starting.
  const decided = computerTargetOf(job);
  job.computerTarget = undefined;
  const fresh = computerTargetOf(job);
  const computer = fresh && decided && computerLockKey(fresh) === computerLockKey(decided) ? fresh : null;
  if (decided && !computer && fresh) job.acc.addNotice("info", "What you share changed while this message started — it applies from your next message.");
  if (computer) attachComputer(job.runId, agent.id, job.conversationId, computer, job.computerFromAgent ? "agent" : "share");
  // The macOS VM this run works in (the chat's, the agent's or the workspace's), booted when needed. Work meant for a
  // VM never falls back to this computer: a VM that can't be used fails the run, and its browser and computer use run
  // inside the VM (tools that can't be set up there are left out, not replaced by this computer's).
  let vm: RunVm | null = null;
  let guest: GuestTools | null = null;
  // The VM the queue decided on (its lock is what keeps other runs out of it).
  const vmId = dreaming ? null : vmOf(job);
  if (vmId) {
    if (!settings.vm.enabled) {
      return { status: "failed", error: "This work is set to run in a virtual machine, but virtual machines are turned off (Settings → Virtual machines). Turn them on, or remove the VM from the chat, agent or workspace." };
    }
    const cancelled = new AbortController();
    const watch = setInterval(() => job.cancelReason && cancelled.abort(), 250);
    const onActivity = (label: string) => emitActivity(job, label);
    try {
      try {
        vm = await attachVm(job.runId, vmId, onActivity, cancelled.signal);
      } catch (err) {
        if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
        return { status: "failed", error: `The virtual machine can't be used: ${errorText(err)}` };
      }
      if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
      const browser = settings.browser.enabled && agent.browser.enabled;
      guest = await prepareGuest(vm.id, { browser, onActivity, signal: cancelled.signal }).catch((err: unknown) => ({
        browser: null,
        cua: null,
        problems: [`The VM's browser and computer-use tools are unavailable in this run: ${errorText(err)}`],
      }));
      if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
      job.vmBrowser = !!guest.browser;
      for (const problem of guest.problems) job.acc.addNotice("warning", problem);
    } finally {
      clearInterval(watch);
    }
  }
  const promptVm: PromptVm | null = vm
    ? {
        name: vm.name,
        guestUser: vm.guestUser,
        guestSharedDir: vm.guestSharedDir,
        hostSharedDir: vm.hostSharedDir,
        hostShellOff: settings.vm.isolateHostShell,
        browser: !!guest?.browser,
        cua: !!guest?.cua,
        vaultFill: settings.vm.vaultFill,
      }
    : null;
  // The workspace's folders and repositories; a missing clone is cloned first. A dream only works on its memory.
  let sources: RunSource[] = [];
  if (!dreaming && agent.workspaceId) {
    const cancelled = new AbortController();
    const watch = setInterval(() => job.cancelReason && cancelled.abort(), 250);
    try {
      const prepared = await prepareSources(agent.workspaceId, { onActivity: (label) => emitActivity(job, label), signal: cancelled.signal });
      sources = prepared.sources.filter((s) => s.path !== cwd && s.path !== agent.repoPath);
      for (const text of prepared.notices) job.acc.addNotice("warning", text);
    } finally {
      clearInterval(watch);
    }
    if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
  }
  const mcp = await buildMcpConfig(agent, res.token, {
    onNotice: (text) => job.acc.addNotice("warning", text),
    computer: !!computer,
    vm: vm ? { id: vm.id, browser: guest?.browser ?? null, cua: guest?.cua ?? null } : null,
    gatewayOnly: dreaming,
    run: { runId: job.runId, conversationId: job.conversationId },
    browserProfileId: runProfileOf(job),
  });
  const mcpPath = writeMcpConfigFile(job.runId, mcp);
  res.files.push(mcpPath);
  if (job.acc.blocks.length) scheduleDelta(job);

  const canDelegate = !dreaming && (agent.permissions.allowDelegation || agent.permissions.canManageAgents);
  let peers: Agent[] = [];
  if (canDelegate) {
    try {
      peers = peersFor(agent);
    } catch (err) {
      log.warn(`could not list peers of agent ${agent.id}`, err);
    }
  }
  const workspace = agent.workspaceId
    ? get<{ name: string; instructions: string }>("SELECT name, instructions FROM workspaces WHERE id = ?", agent.workspaceId)
    : null;
  const promptSources = workspace && sources.length ? { workspace: workspace.name, items: sources } : null;
  const apiTools: PromptApiTool[] = dreaming
    ? []
    : apiToolsForAgent(agent).map((t) => ({ id: t.id, name: t.name, description: t.description, baseUrl: t.baseUrl, envVar: t.hasKey && !(vm && settings.vm.isolateHostShell) ? t.envVar : null }));
  const standing = instructionsSection(settings, {
    workspace: workspace ? { name: workspace.name, text: workspace.instructions } : null,
    chat: conv.instructions ?? "",
  });
  const digest = instructionsDigest(standing);
  const systemPrompt = dreaming
    ? buildDreamSystemPrompt(agent, settings)
    : buildSystemPrompt({
        agent,
        settings,
        peers,
        browserAvailable: "browser" in mcp.mcpServers,
        computer,
        vm: promptVm,
        voice: job.voice,
        workingDirectory: folder,
        sources: promptSources,
        apiTools,
        standingInstructions: standing,
        // Condition checks run every few minutes and only look at the world: no memory needed.
        memory: settings.memory.injectMemory && job.trigger !== "check" ? memoryForPrompt(agent.repoPath) : null,
      });
  const memoryNow = memoryDigest(agent.repoPath);

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
  // A run in a VM stays off the host: no bypass, so Claude Code's file tools only reach its folders (cwd + --add-dir).
  const hostLocked = !!vm && settings.vm.isolateHostShell;
  if (dreaming) {
    // Never bypass permissions for a dream: it may only write its memory files (print mode denies the rest).
    baseArgs.push("--permission-mode", "default", "--allowedTools", ...DREAM_ALLOWED);
  } else if (settings.runner.bypassPermissions && !hostLocked) baseArgs.push("--dangerously-skip-permissions");
  else {
    // Non-bypass mode: allow Godmode-provided MCP tools without prompts (print mode cannot ask).
    baseArgs.push("--permission-mode", "acceptEdits", "--allowedTools", Object.keys(mcp.mcpServers).map((n) => `mcp__${n}`).join(","));
  }
  baseArgs.push("--mcp-config", mcpPath, "--strict-mcp-config");
  if (dreaming) baseArgs.push("--tools", DREAM_TOOLS);
  const disallowed: string[] = [];
  // Hide browser-use tools that need their own LLM key when none is configured (they would only error). The key never
  // goes into a VM, so a VM's browser has none.
  if (mcp.mcpServers[BROWSER_MCP_NAME] && (vm || !browserLlmKey())) disallowed.push(...BROWSER_LLM_TOOLS.map((t) => `mcp__${BROWSER_MCP_NAME}__${t}`));
  if (mcp.mcpServers[CUA_MCP_NAME]) disallowed.push(...CUA_HIDDEN_TOOLS.map((t) => `mcp__${CUA_MCP_NAME}__${t}`));
  // Shell work belongs in the VM: Claude Code's own Bash tool would run on the host. Settings files (hooks run shell
  // commands on this computer) can't be planted for later runs in the folders this run may write to.
  if (hostLocked) disallowed.push("Bash", "Edit(**/.claude/**)"); // Edit rules cover every file-editing tool
  // Godmode runs git in the workspace's clones: a run that may edit files but not run commands must not plant git
  // settings or hooks there that would run on this computer.
  const bypass = settings.runner.bypassPermissions && !hostLocked;
  if (!bypass && sources.some((s) => s.kind === "git")) {
    disallowed.push("Edit(**/.git/**)", ...sources.filter((s) => s.kind === "git").map((s) => `Edit(/${s.path.replace(/\\/g, "/")}/.git/**)`));
  }
  if (disallowed.length) baseArgs.push("--disallowedTools", disallowed.join(","));
  if (viaFiles) baseArgs.push("--append-system-prompt-file", writeTempFile(res, `godmode-prompt-${job.runId}.md`, systemPrompt));
  else baseArgs.push("--append-system-prompt", systemPrompt);
  // Dreams and runs kept off the host load no settings files: .claude/settings*.json in a folder the run can write to
  // could add hooks (shell commands on this computer) or widen its permissions.
  baseArgs.push("--setting-sources", dreaming || hostLocked ? "" : "project,local");
  if (folder) baseArgs.push("--add-dir", agent.repoPath);
  // The VM's shared folder: how files move between the VM and the host.
  if (vm) baseArgs.push("--add-dir", vm.hostSharedDir);
  for (const source of sources) baseArgs.push("--add-dir", source.path);
  if (budget != null && budget > 0) baseArgs.push("--max-budget-usd", String(budget));
  if (agent.subagents.length && !dreaming) {
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
  if (settings.memory.backend === "claude-mem" && !dreaming) {
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

  const env = buildEnv(agent, !!folder || sources.length > 0, !dreaming);
  const logPath = runLogPath(agent, getRun(job.runId));
  mkdirSync(join(logPath, ".."), { recursive: true });
  const logSink = Bun.file(logPath).writer();

  const timeoutMinutes = dreaming
    ? Math.min(settings.runner.runTimeoutMinutes || DREAM_TIMEOUT_MINUTES, DREAM_TIMEOUT_MINUTES)
    : settings.runner.runTimeoutMinutes;
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
      setConversationState(job.conversationId, { claudeSessionId: sessionId, instructionsDigest: digest, memoryDigest: memoryNow });
    }
    job.memorySeen = memoryNow;
    if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
    const sessionArgs = resuming ? ["--resume", sessionId] : ["--session-id", sessionId];
    // Claude Code only recognizes a slash command at the very start of the prompt.
    const command = parseSlashCommand(job.prompt) !== null;
    // A resumed session keeps the system prompt of its first turn: restate standing instructions that changed since.
    const restate = resuming && !command && (conv.instructions_digest ?? "") !== digest;
    if (restate) job.restatedDigest = digest;
    // Another chat, a dream or the human changed the memory since this session last saw it.
    const memoryChanged = resuming && !dreaming && conv.memory_digest != null && conv.memory_digest !== memoryNow;
    const prompt =
      resuming && !command
        ? resumeContextPrefix(folder, agent.repoPath, { instructions: restate ? standing : undefined, memoryChanged, vm: promptVm, sources: promptSources, apiTools }) + job.prompt
        : job.prompt;
    let attempt = await spawnClaude(job, cmd, [...baseArgs, ...sessionArgs, ...extraArgs], prompt, cwd, env, logSink);

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
      if (command) job.keepSessionId = sessionId;
      sessionId = randomUUID();
      setConversationState(job.conversationId, { claudeSessionId: sessionId, instructionsDigest: digest, memoryDigest: memoryNow });
      attempt = await spawnClaude(
        job,
        cmd,
        [...baseArgs, "--session-id", sessionId, ...extraArgs],
        command ? job.prompt : recapPrefix(job) + job.prompt,
        cwd,
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
    releaseChatBrowser(job.runId);
    for (const f of res.files) removeMcpConfigFile(f);
    await detachComputer(job.runId).catch(() => {});
    detachVm(job.runId);
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
      const row = get<{ title: string; instructions_digest: string | null }>(
        "SELECT title, instructions_digest FROM conversations WHERE id = ?",
        job.conversationId,
      );
      const title =
        row?.title === DEFAULT_CONVERSATION_TITLE && job.userMessageId ? autoTitle(job.userMessageId) : undefined;
      let digest = outcome.status === "succeeded" && job.restatedDigest !== undefined ? job.restatedDigest : (row?.instructions_digest ?? null);
      // A restatement lives in the transcript, which compaction summarizes.
      if (acc.compacted && digest) digest = STALE_DIGEST;
      setConversationState(job.conversationId, {
        // After /clear the next turn starts a brand-new session instead of resuming the old one.
        ...(acc.contextCleared
          ? { claudeSessionId: null }
          : job.keepSessionId
            ? { claudeSessionId: job.keepSessionId }
            : acc.sessionId
              ? { claudeSessionId: acc.sessionId }
              : {}),
        lastMessageAt: ts,
        ...(digest !== null && digest !== row?.instructions_digest ? { instructionsDigest: digest } : {}),
        // The session knows the memory as of its start plus its own edits; changes from elsewhere during the run are
        // pointed out on the next turn (when unsure, a harmless extra hint beats a missed one).
        ...(agent && job.memorySeen !== undefined && job.trigger !== "dream"
          ? { memoryDigest: editedMemory(acc.blocks) ? memoryDigest(agent.repoPath) : job.memorySeen }
          : {}),
        ...(title && title !== DEFAULT_CONVERSATION_TITLE ? { title } : {}),
        ...(outcome.status === "succeeded" ? commandOverrides(acc.localCommand) : {}),
      });
    });
  }

  if (wasRunning) {
    const others = [...jobs.values()].some((j) => j !== job && j.agentId === job.agentId && j.status === "running");
    if (!others) safely("set agent status", () => setAgentStatus(job.agentId, "idle"));
    // A dream is not activity of the agent ("last active" stays the last real run).
    if (job.trigger !== "dream") safely("touch agent", () => touchAgentRun(job.agentId));
  }

  let finished: Run | null = null;
  try {
    finished = getRun(job.runId);
  } catch (err) {
    log.error(`run ${job.runId} vanished`, err);
  }
  if (finished) {
    const run = finished;
    safely("log run", () => logRunFinished(job, run, agent, outcome.status, error));
  }
  emitActivity(job, outcome.status === "succeeded" ? "Done" : outcome.status === "cancelled" ? "Cancelled" : "Failed");
  if (finished) bus.emit({ type: "run.finished", run: finished });
  bus.changed("runs");
  if (convAlive) emitConversationUpdated(job.conversationId);

  // Condition checks and dreams keep no transcript: checks only report a result, a dream's record is the dream itself.
  if (wasRunning && finished && convAlive && job.trigger !== "check" && job.trigger !== "dream") {
    const done = finished;
    safely("append transcript", () => {
      const user = job.userMessageId ? getMessage(job.userMessageId) : null;
      appendTranscript(job.conversationId, done, user, assistant);
    });
  }
  // Start the next queued turn (e.g. a follow-up message in this conversation) right away.
  pump();

  if (!wasRunning || !finished || !agent) return;
  // A dream's summary may talk about past login trouble — that is no new missing login.
  if (outcome.status !== "cancelled" && job.trigger !== "dream") await detectMissingLogin(job, agent, text);

  // Condition checks change nothing worth a commit; the task run that follows commits as usual. Dreams commit their
  // memory changes themselves (memory/dreaming.ts).
  if (getSettings().memory.autoCommit && job.trigger !== "check" && job.trigger !== "dream") {
    const title = get<{ title: string }>("SELECT title FROM conversations WHERE id = ?", job.conversationId)?.title ?? job.trigger;
    const message = `Run ${job.runId.slice(-6)}: ${title}`;
    commitAgentRepo(job.agentId, message).catch((err) => log.warn(`auto-commit for agent ${job.agentId} failed`, err));
  }
}

/** One line per run in the diagnostic log: what it cost, how long it took and waited, which tools failed. */
function logRunFinished(job: Job, run: Run, agent: Agent | null, status: Outcome["status"], error: string | null) {
  const tools = job.acc.blocks.flatMap((b) => (b.type === "tool_use" ? [b] : []));
  const byName = new Map<string, number>();
  for (const t of tools) byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
  const details = {
    runId: run.id,
    agent: agent?.name ?? job.agentId,
    trigger: job.trigger,
    status,
    model: run.model,
    ms: run.durationMs,
    queuedMs: run.startedAt ? Date.parse(run.startedAt) - Date.parse(run.createdAt) : null,
    costUsd: run.costUsd,
    turns: run.numTurns,
    tokens: run.usage,
    toolCalls: tools.length,
    topTools: [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => `${name}×${n}`),
    failedTools: tools.filter((t) => t.isError).slice(0, 8).map((t) => ({ name: t.name, error: excerpt(t.result ?? "", 300) })),
    ...(job.depth ? { depth: job.depth } : {}),
    ...(job.timedOut ? { timedOut: true } : {}),
    ...(error ? { error: excerpt(error, 1000) } : {}),
  };
  if (status === "failed") log.warn(`run failed: ${excerpt((error ?? "unknown error").split("\n")[0], 160)}`, details);
  else log.info("run finished", details);
}

/** The run wrote MEMORY.md itself (Edit/Write/MultiEdit on a path ending in MEMORY.md). */
function editedMemory(blocks: StreamAccumulator["blocks"]): boolean {
  return blocks.some((b) => {
    if (b.type !== "tool_use" || !["Edit", "Write", "MultiEdit"].includes(b.name) || b.isError) return false;
    const path = (b.input as { file_path?: unknown } | null)?.file_path;
    return typeof path === "string" && /(^|[\\/])MEMORY\.md$/.test(path);
  });
}

/**
 * Session settings from local slash commands. Claude Code keeps `/model` and `/effort` for its process only,
 * but every Godmode turn is a new process — so they are stored on the conversation. `/rename` renames the chat.
 * Only what Claude Code confirmed is stored: a rejected model would break every later turn of the chat.
 */
function commandOverrides(cmd: StreamAccumulator["localCommand"]): { model?: string | null; effort?: Effort | null; title?: string } {
  const arg = cmd?.args.trim();
  if (!cmd || !arg) return {};
  switch (cmd.name) {
    case "model":
      if (!/^Set model to /.test(cmd.output)) return {};
      return { model: arg.toLowerCase() === "default" ? null : arg };
    case "effort": {
      const level = /effort level (?:set )?to (\w+)/i.exec(cmd.output)?.[1]?.toLowerCase();
      if (level === "auto") return { effort: null };
      return level && (EFFORT_OPTIONS as readonly string[]).includes(level) ? { effort: level as Effort } : {};
    }
    case "rename":
      return { title: redact(arg).slice(0, 200) };
    default:
      return {};
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
  if (agent.browser.enabled && (!job.vmId || job.vmBrowser)) {
    try {
      const page = job.vmId ? await currentVmPage(job.vmId) : await currentPage(runProfileOf(job) ?? resolveProfileForAgent(agent, job.conversationId).id, job.conversationId);
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
