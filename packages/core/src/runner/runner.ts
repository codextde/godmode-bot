/**
 * Runs Claude Code CLI for an agent turn and streams the results (owner: runner).
 *
 * One run = one `claude -p` process (prompt on stdin, stream-json on stdout) in the agent's repo (or the folder
 * attached to the chat, with the repo added via --add-dir), resuming
 * the conversation's Claude session. Runs are queued (settings.runner.maxConcurrentRuns, re-read on every
 * dequeue) with strictly one active run per conversation (FIFO). Output is parsed by StreamAccumulator into
 * one assistant message, pushed live as `run.delta` events, persisted (redacted) to SQLite, the agent repo
 * transcript and a raw JSONL run log.
 *
 * Messages the human sends meanwhile wait in the chat's queue (services/messageQueue.ts): Claude Code asks for them
 * between two steps of the run (`deliverQueued`), and what is left when the run ends by itself starts the next one.
 *
 * A run can stand still and continue later (services/pauses.ts): the human pauses it (`pauseRun`), or Claude's usage
 * limit is reached. It keeps its row, its assistant message and its Claude session; `resumeRun` queues it again and the
 * next `claude -p` process resumes the session with a note to pick the work up where it stopped.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  Agent,
  BrowserProfile,
  ComputerTarget,
  Effort,
  Message,
  MessageBlock,
  PauseBudget,
  PauseReason,
  QuestionAnswer,
  QuestionStatus,
  Run,
  RunDelta,
  RunStatus,
  RunTrigger,
  RunUsage,
  ServerEvent,
  TaskPriority,
} from "@godmode/shared";
import {
  BROWSER_MCP_NAME,
  CUA_MCP_NAME,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  RUN_CLI_MISSING,
  RUN_COST_LIMIT,
  RUN_INTERRUPTED,
  RUN_MAX_TURNS,
  RUN_SHUT_DOWN,
  RUN_STOPPED_BY_USER,
  TASK_PRIORITY_RANK,
  WORKFLOW_TOOL,
  isModelId,
  parseSlashCommand,
  type ActivityNames,
} from "@godmode/shared";
import { config } from "../config";
import { all, get, insert, run as sql, tx } from "../db";
import { bus } from "../events/bus";
import { setRunSnapshots, setWelcomeEvents } from "../server/ws";
import { excerpt, logger } from "../log";
import { HttpError, badRequest, conflict, hostnameOf, newId, notFound, now, parseJson } from "../util";
import { isUnlocked, redact, redactionEpoch } from "../vault/vault";
import { commitAgentRepo, ensureAgentRepo, getAgent, listAgents, peersFor, setAgentFailedRun, setAgentStatus, teamOf, touchAgentRun } from "../agents/service";
import { isDirectory, workingDirectoryProblem } from "../services/folders";
import { prepareSources, type RunSource } from "../services/workspaceSources";
import { projectOfChat } from "../services/projects";
import { getSettings } from "../services/settings";
import { reportMissingLogin } from "../services/missingLogins";
import { BROWSER_LLM_TOOLS, browserLlmKey, chatProfileId, currentPage, getProfile, onLaunchProblem, releaseChatBrowser, resolveProfileForAgent } from "../browser/manager";
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
import { startQueued, takeQueued } from "../services/messageQueue";
import {
  announceQuestion,
  owedAnswer,
  saveQuestion,
  settleBlock,
  dropOwedAnswers,
  settleOwed,
  withdrawOpenBlocks,
  withdrawQuestion,
  type PendingQuestion,
  type ResumedAnswer,
} from "../services/questions";
import { bookSpend } from "../services/spend";
import { audit } from "../services/audit";
import { exhaustedBudget, exemptNotice, nextMonthStart, type BudgetStop } from "../services/budgets";
import { MAX_RETRIES, dropPause, limitReached, pauseOf, pausedConversations, pausedRun, savePause, stopContinuing, toPause, type LimitPause, type PausedRow } from "../services/pauses";
import { issueRunToken, revokeRunToken } from "../mcp/tokens";
import { claudeMemEnv, claudeMemPluginDir, stopClaudeMemWorkers } from "../memory/claudeMem";
import { modsForRun, removeRunMods } from "../mods/service";
import { memoryDigest, memoryForPrompt } from "../memory/files";
import { claudeEnv, killTree, resolveClaudeCommand } from "./claude";
import { buildMcpConfig, gatewayUrl, removeMcpConfigFile, writeMcpConfigFile } from "./mcpConfig";
import { effortFor, ultracodeFor } from "./models";
import {
  buildDreamSystemPrompt,
  buildSystemPrompt,
  continueContext,
  instructionsDigest,
  instructionsSection,
  lateAnswerContext,
  queuedMessagesContext,
  resumeContextPrefix,
  type PromptApiTool,
  type PromptVm,
} from "./prompt";
import { apiToolEnv, apiToolEnvOwners, apiToolsForAgent } from "../integrations/apiTools";
import { attachComputer, computerLockKey, detachComputer } from "../computer/service";
import { attachVm, detachVm, type RunVm } from "../vm/service";
import { CUA_HIDDEN_TOOLS, currentVmPage, prepareGuest, type GuestTools } from "../vm/guest";
import { resolveVmId } from "../vm/assignments";
import { runSshServerIds } from "../ssh/assignments";
import { attachSsh, detachSsh, promptServers } from "../ssh/service";
import { parseComputerTarget } from "../computer/targets";
import { timedSync } from "../diagnostics/slow";
import { StreamAccumulator, addUsage, detectLoginFailure, redactBlock } from "./stream";
import { requireLicense } from "../license/license";

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
  /** Further stored user messages answered in the same turn (the chat's queue). */
  alsoAnswers?: string[];
  /** Id for the run (callers that must know it before the run can start or finish). Default: a new one. */
  runId?: string;
  /** The human started this by hand (Run now, Continue now): a used-up monthly budget doesn't hold it. */
  byHuman?: boolean;
}

export const CLAUDE_NOT_FOUND = RUN_CLI_MISSING;
export const INTERRUPTED = RUN_INTERRUPTED;
const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
const STDERR_TAIL_BYTES = 8 * 1024;
const DELTA_INTERVAL_MS = 100;
let persistIntervalMs = 2000;
/** Saving the in-flight message takes longer the longer a run gets: it never takes more than 1/50 of the time. */
let persistBackoff = 50;

/** Tests: save the in-flight message on every delta (0, 0), or as usual (2000, 50). */
export function __setPersistForTests(intervalMs: number, backoff: number) {
  persistIntervalMs = intervalMs;
  persistBackoff = backoff;
}
const KILL_GRACE_MS = 5000;
/** A pause lets the step in progress finish for this long before it cuts it off. */
const PAUSE_GRACE_MS = 8000;
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

export function listRuns(opts: { agentId?: string; status?: string; conversationId?: string; parentRunId?: string; limit?: number } = {}): Run[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.parentRunId) {
    where.push("parent_run_id = ?");
    params.push(opts.parentRunId);
  }
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
  const runs = all<RunRow>(
    `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ...params,
  ).map(toRun);
  // Why a paused run stands still: paused by the human, waiting for Claude's limit, or for the human's answer.
  const paused = runs.filter((r) => r.status === "paused");
  if (paused.length) {
    const rows = new Map(
      all<PausedRow>(`SELECT * FROM paused_runs WHERE run_id IN (${paused.map(() => "?").join(", ")})`, ...paused.map((r) => r.id)).map((p) => [p.run_id, p]),
    );
    for (const r of paused) {
      const p = rows.get(r.id);
      r.pause = p ? toPause(p) : null;
    }
  }
  return runs;
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

type Outcome = { status: "succeeded" | "failed" | "cancelled" | "paused"; error: string | null };

/** What the stretches of a run before a pause cost. */
interface Spent {
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: RunUsage | null;
}

const NOTHING_SPENT: Spent = { costUsd: null, durationMs: null, numTurns: null, usage: null };

interface Job {
  runId: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  userMessageId: string | null;
  alsoAnswers: string[];
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
  /** Stopped to make way for the chat's queue: it starts when this run is gone (other stops leave it waiting). */
  thenQueue?: boolean;
  /**
   * The run is to stand still. `applied` once Godmode stopped it for that: a run that ends by itself before simply ends.
   */
  pause?: {
    reason: PauseReason;
    applied: boolean;
    /** Claude Code was told to stop between two steps. */
    atStep?: boolean;
    /** Godmode stopped the process while a step was still running (the grace time ran out). */
    killed?: boolean;
    /** What the run asked the human (`question` pauses): stored once the run stands still for it. */
    question?: PendingQuestion;
    /** `budget` pauses: which monthly budget holds it. */
    budget?: PauseBudget;
  } & Partial<LimitPause>;
  pauseTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * The run continues after a pause. `redo`: what Claude never got and is sent again; null = it has everything.
   * `byTimer`: the limit had reset and Godmode continued it. `choice`: what the human set for this run with the Auto
   * switch (null = the setting decides).
   */
  resumed?: {
    reason: PauseReason;
    pausedAt: string;
    redo: string | null;
    byTimer: boolean;
    choice: boolean | null;
    retries: number;
    /** The run stood still for a question and continues with the human's answer. */
    answer?: ResumedAnswer | null;
  };
  /** An answer the chat's agent hadn't read yet (an earlier run broke off): this run's prompt starts with it. */
  lateAnswer?: string;
  /** The answers this run carries were settled as soon as Claude started replying. */
  answersSettled?: boolean;
  /** The human stopped it (from a chat, the board or a chat platform), not Godmode. */
  stoppedByHuman?: boolean;
  /** Resolves ids in tool input for the activity label (memoized per run). */
  names?: ActivityNames;
  /** The human started or let it run: a used-up monthly budget doesn't hold it. */
  exempt?: boolean;
  /** What this stretch of the run sends to Claude. */
  body?: string;
  /** Claude Code asks Godmode between two steps of this run (PostToolBatch hook). */
  hooked?: boolean;
  spent: Spent;
  /**
   * What Claude Code had counted for the Claude session before this stretch (null = a new session, or unknown): it
   * reports the total of the whole session, earlier runs of the chat included.
   */
  sessionCostBefore?: number | null;
  timedOut: boolean;
  /** The watchdog stopped it: its report (the run's error). */
  stalled?: string;
  /** Last line Claude Code wrote, and when the process started (ms) — what the watchdog looks at. */
  lastOutputAt?: number;
  spawnedAt?: number;
  lastLabel: string;
  lastDeltaAt: number;
  lastPersistAt: number;
  /** Wait between two saves of the in-flight message (see persistBackoff). */
  persistEveryMs?: number;
  /** The slowest save of the in-flight message, for the diagnostic log. */
  slowestPersistMs?: number;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  /** The blocks as clients and the database get them (see LiveView). */
  live?: LiveView;
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
/** What paused runs sent last without an answer from Claude, before redaction — memory only. */
const unanswered = new Map<string, string>();
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

/** A running run as the watchdog sees it. `waiting`: it stands still on purpose (a pause, the usage limit, compacting). */
export interface WatchedRun {
  runId: string;
  agentId: string;
  conversationId: string;
  trigger: RunTrigger;
  startedAt: number;
  lastOutputAt: number;
  blocks: readonly MessageBlock[];
  waiting: boolean;
}

export function watchedRuns(): WatchedRun[] {
  const out: WatchedRun[] = [];
  for (const j of jobs.values()) {
    if (j.status !== "running" || !j.proc || j.cancelReason || j.timedOut || j.stalled || !j.lastOutputAt) continue;
    out.push({
      runId: j.runId,
      agentId: j.agentId,
      conversationId: j.conversationId,
      trigger: j.trigger,
      startedAt: j.spawnedAt ?? j.lastOutputAt,
      lastOutputAt: j.lastOutputAt,
      blocks: j.acc.blocks,
      waiting: !!j.pause || !!j.acc.limit || j.acc.isCompacting,
    });
  }
  return out;
}

/** The watchdog stops a run that stalled or goes in circles: it fails with `report` as its error. */
export function stopStalledRun(runId: string, report: string): boolean {
  const job = jobs.get(runId);
  if (!job || job.status !== "running" || !job.proc || job.cancelReason || job.timedOut || job.stalled) return false;
  job.stalled = report;
  log.warn(`watchdog stopped run ${runId}: ${report}`);
  killTree(job.proc);
  return true;
}

export function listActiveRuns(): {
  runId: string;
  agentId: string;
  conversationId: string;
  status: "queued" | "running";
  parentRunId: string | null;
  trigger: RunTrigger;
}[] {
  return [...jobs.values()].map((j) => ({
    runId: j.runId,
    agentId: j.agentId,
    conversationId: j.conversationId,
    status: j.status,
    parentRunId: j.parentRunId,
    trigger: j.trigger,
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
  requireLicense();
  const agent = getAgent(input.agentId);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  const conv = get<{ agent_id: string; runner_id: string | null }>("SELECT agent_id, runner_id FROM conversations WHERE id = ?", input.conversationId);
  if (!conv) throw notFound("Conversation");
  // Its runs happen on the runner; the request should have been forwarded there.
  if (conv.runner_id) throw conflict("This chat works on a runner");
  if (conv.agent_id !== agent.id) throw badRequest("The conversation belongs to another agent");
  if (!input.prompt.trim()) throw badRequest("Prompt is empty");

  const runId = input.runId ?? newId("run");
  let userMessageId = input.userMessageId ?? null;
  if (userMessageId) sql("UPDATE messages SET run_id = ? WHERE id = ?", runId, userMessageId);
  else userMessageId = addMessage({ conversationId: input.conversationId, role: "user", content: redact(input.prompt), runId }).id;
  const alsoAnswers = input.alsoAnswers ?? [];
  for (const id of alsoAnswers) sql("UPDATE messages SET run_id = ? WHERE id = ?", runId, id);

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
    alsoAnswers,
    prompt: input.prompt,
    trigger: input.trigger,
    parentRunId: input.parentRunId ?? null,
    depth: input.depth ?? 0,
    voice: input.voice ?? false,
    exempt: input.byHuman === true || (!!input.parentRunId && runExempt(input.parentRunId)),
    status: "queued",
    acc: new StreamAccumulator(),
    proc: null,
    cancelReason: null,
    spent: NOTHING_SPENT,
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

export async function cancelRun(runId: string, reason = "Cancelled", opts: { thenQueue?: boolean; byHuman?: boolean } = {}): Promise<void> {
  const job = jobs.get(runId);
  if (!job) {
    const row = get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
    if (!row) throw notFound("Run");
    // A run of a chat on a runner is the runner's to end: closing the copy here would only make it look stopped.
    if (!TERMINAL.has(row.status) && get<{ id: string }>("SELECT id FROM conversations WHERE id = ? AND runner_id IS NOT NULL", row.conversation_id)) {
      throw new HttpError(409, "The runner this chat works on is offline", "runner_offline");
    }
    if (row.status === "paused") return closePaused(row, reason, opts.byHuman);
    if (!TERMINAL.has(row.status)) {
      // Stale row (no live job): close it.
      sql("UPDATE runs SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?", reason, now(), runId);
      bus.emit({ type: "run.finished", run: getRun(runId) });
      bus.changed("runs");
    }
    return;
  }
  // Cancelling a run also cancels the work it delegated.
  for (const child of delegatedBy(runId)) await cancelRun(child, "Cancelled (parent run was cancelled)");
  job.cancelReason ??= reason;
  job.thenQueue = opts.thenQueue ?? false;
  if (opts.byHuman) job.stoppedByHuman = true;
  if (job.status === "queued") {
    const idx = queue.indexOf(runId);
    if (idx >= 0) queue.splice(idx, 1);
    await finalize(job, { status: "cancelled", error: job.cancelReason }, null, Date.now());
    return;
  }
  if (job.proc) killTree(job.proc);
  // A job still in setup (no process yet) checks cancelReason before spawning.
}

/* ------------------------------------------------------------------ */
/* Pause and continue                                                   */
/* ------------------------------------------------------------------ */

/** Runs a run delegated that are working or stand still. */
function delegatedBy(runId: string): string[] {
  const working = [...jobs.values()].filter((j) => j.parentRunId === runId).map((j) => j.runId);
  const paused = all<{ id: string }>("SELECT id FROM runs WHERE parent_run_id = ? AND status = 'paused'", runId).map((r) => r.id);
  return [...working, ...paused];
}

/** A top-level step is running right now (cut-off steps of an earlier stretch don't count). */
function stepRunning(job: Job): boolean {
  for (let i = job.acc.blocks.length - 1; i >= 0; i--) {
    const b = job.acc.blocks[i]!;
    if (b.type === "pause") return false;
    if (b.type === "tool_use" && !b.parentToolUseId && b.result === undefined) return true;
  }
  return false;
}

/**
 * Make a run stand still so it can continue later. A step in progress gets a moment to finish — Claude Code then stops
 * between two steps (`pauseAtStep`) and nothing is cut off; otherwise the run is stopped right away.
 */
export async function pauseRun(runId: string): Promise<void> {
  const job = jobs.get(runId);
  if (!job) throw conflict("That run isn't working right now");
  if (job.trigger === "dream" || job.trigger === "check") throw badRequest("This kind of run can't be paused — stop it instead");
  if (job.cancelReason || job.pause) return;
  // A chat has one paused run; what waits behind it is frozen already.
  if (pausedConversations().has(job.conversationId)) throw conflict("This chat is paused already");
  job.pause = { reason: "user", applied: false };
  // What it delegated would report back to a process that is gone: that work stops, and is handed over again later.
  for (const child of delegatedBy(runId)) await cancelRun(child, "Stopped (the run that delegated this was paused)");
  if (job.status === "queued") {
    job.pause.applied = true;
    await suspend(job, null, Date.now());
    return;
  }
  emitActivity(job, "Pausing…");
  if (job.proc && job.hooked && stepRunning(job)) job.pauseTimer = setTimeout(() => applyPause(job), PAUSE_GRACE_MS);
  else applyPause(job);
}

function applyPause(job: Job) {
  if (job.pauseTimer) clearTimeout(job.pauseTimer);
  job.pauseTimer = null;
  if (!job.pause || job.pause.applied) return;
  job.pause.applied = true;
  // A job still in setup (no process yet) checks `halted` before spawning.
  if (job.proc) {
    job.pause.killed = stepRunning(job);
    killTree(job.proc);
  }
}

/**
 * Claude Code asks between two steps of a run (PostToolBatch hook): the reason the run is being stopped here (it is
 * being paused, or it waits for the human's answer), or null to go on.
 */
export function pauseAtStep(runId: string): PauseReason | null {
  const job = jobs.get(runId);
  if (!job?.pause || job.cancelReason) return null;
  // Already being stopped for the pause: it gets nothing more to do.
  if (job.pause.applied) return job.pause.reason;
  if (job.pauseTimer) clearTimeout(job.pauseTimer);
  job.pause.applied = true;
  job.pause.atStep = true;
  // Claude Code ends by itself now; a process that doesn't is stopped.
  job.pauseTimer = setTimeout(() => job.proc && killTree(job.proc), KILL_GRACE_MS);
  return job.pause.reason;
}

/** Why the run can't ask the human right now (`ask_human`, `request_approval`), or null when it can. */
export function questionRefusal(runId: string, human: string): string | null {
  const job = jobs.get(runId);
  if (!job || job.status !== "running" || job.cancelReason || job.timedOut || job.stalled) return "This run is being stopped — nothing was asked.";
  if (job.pause?.question) {
    return `You already asked “${job.pause.question.block.title}” in this step and it hasn't been answered. One at a time: stop now, and ask the next one after the answer.`;
  }
  if (job.pause) return `${human} is pausing this run right now — ask again when it continues.`;
  return null;
}

/**
 * The run asked the human: it stands still at its next step (the PostToolBatch hook stops it there, or Godmode does
 * after a moment) and the question is stored and announced then (`suspend`). Returns a refusal, or null.
 */
export function askPause(runId: string, question: PendingQuestion, human: string): string | null {
  const refused = questionRefusal(runId, human);
  if (refused) return refused;
  const job = jobs.get(runId)!;
  job.pause = { reason: "question", applied: false, question };
  job.acc.blocks.push(question.block);
  job.lastPersistAt = 0;
  emitDelta(job);
  emitActivity(job, "Asking you…");
  // The ask is a step of its own: Claude Code asks the hook as soon as it is answered. Without a hook (or when a step of
  // a subagent asked), the run is stopped after the same grace a pause gets.
  if (job.proc) job.pauseTimer = setTimeout(() => applyPause(job), PAUSE_GRACE_MS);
  else applyPause(job);
  return null;
}

/** Why the run must not go on: it was stopped, or it is to stand still. */
function halted(job: Job): Outcome | null {
  if (job.cancelReason) return { status: "cancelled", error: job.cancelReason };
  if (job.pause?.applied) return { status: "paused", error: null };
  return null;
}

/**
 * Continue a paused run where it stopped: it goes back into the queue, ahead of what waited behind it, with what it
 * did so far. `by`: the human, or Godmode once the limit has reset.
 */
export function resumeRun(
  p: PausedRow,
  by: "user" | "auto" = "user",
  answer: ResumedAnswer | null = null,
  settled: (QuestionAnswer & { status: QuestionStatus }) | null = null,
): Run {
  if (shuttingDown) throw new HttpError(503, "Godmode is shutting down", "shutting_down");
  const row = get<RunRow>("SELECT * FROM runs WHERE id = ?", p.run_id);
  if (!row || row.status !== "paused") throw conflict("That run isn't paused anymore");
  const agent = getAgent(row.agent_id);
  if (p.reason === "question" && !answer) {
    throw new HttpError(409, `${agent.name} is waiting for your answer — answer the question to continue.`, "needs_answer");
  }
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  const ts = now();
  let blocks = getMessage(p.message_id).blocks.map((b) => (b.type === "pause" && !b.resumedAt ? { ...b, resumedAt: ts } : b));
  if (answer && settled) {
    const { status, ...given } = settled;
    blocks = settleBlock(blocks, answer.questionId, { status, answer: given });
    // The card shows the answer at once, also where nobody follows the run's stream.
    updateMessage(p.message_id, { blocks });
  }
  const kept = unanswered.get(row.id);
  unanswered.delete(row.id);
  const job: Job = {
    runId: row.id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    messageId: p.message_id,
    userMessageId: p.user_message_id,
    alsoAnswers: parseJson<string[]>(p.also_answers, []),
    prompt: row.prompt,
    trigger: row.trigger,
    parentRunId: row.parent_run_id,
    depth: p.depth,
    voice: p.voice === 1,
    status: "queued",
    acc: new StreamAccumulator(blocks),
    proc: null,
    cancelReason: null,
    // What the human typed is gone after a restart: the stored text has saved secrets masked.
    resumed: {
      reason: p.reason,
      pausedAt: p.created_at,
      redo: p.delivered ? null : (kept ?? p.redo ?? row.prompt),
      byTimer: by === "auto",
      choice: p.choice === null ? null : p.choice === 1,
      retries: p.reason === "limit" ? p.retries : 0,
      answer,
    },
    spent: { costUsd: row.cost_usd, durationMs: row.duration_ms, numTurns: row.num_turns, usage: parseJson<RunUsage | null>(row.usage, null) },
    timedOut: false,
    lastLabel: "",
    lastDeltaAt: 0,
    lastPersistAt: 0,
    deltaTimer: null,
    done: null,
  };
  // The human continuing a run lets it run past a used-up budget; so does an earlier "Let it run" or "Run now".
  if (by === "user" || p.exempt === 1) job.exempt = true;
  if (p.reason === "budget" && by === "user") audit("user", "budget.continue", row.id, { scope: p.budget_scope ?? null });
  if (!p.delivered && kept === undefined && /•{4,}/.test(job.resumed!.redo ?? "")) {
    job.acc.addNotice("warning", "Godmode restarted while this was paused, so the message is sent again with its saved secrets masked.");
  }
  sql("UPDATE runs SET status = 'queued' WHERE id = ?", row.id);
  jobs.set(row.id, job);
  queue.unshift(row.id);
  dropPause(p);
  bus.emit({ type: "run.started", run: getRun(row.id) });
  // Right away: clients show the run with what it did before the pause.
  emitDelta(job);
  bus.changed("runs");
  emitConversationUpdated(row.conversation_id);
  log.info("run continues", { runId: row.id, by, reason: p.reason });
  pump();
  return getRun(row.id);
}

/** A paused run is stopped for good: it ends like a run that was stopped while it worked. */
function closePaused(row: RunRow, reason: string, byHuman = false): void {
  const p = pausedRun(row.id);
  const ts = now();
  unanswered.delete(row.id);
  // The human stopped the agent's latest real run: what failed before is behind it.
  if (byHuman && row.trigger !== "dream" && row.trigger !== "check") safely("forget the failure", () => setAgentFailedRun(row.agent_id, null));
  // Stopped for good: an answer it never got to read must not reach a later turn as an order.
  if (!shuttingDown) safely("drop the owed answer", () => dropOwedAnswers(row.conversation_id));
  sql("UPDATE runs SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?", reason, ts, row.id);
  const convAlive = conversationExists(row.conversation_id);
  let assistant: Message | null = null;
  if (p && convAlive) {
    safely("close the paused message", () => {
      const message = getMessage(p.message_id);
      const blocks = p.reason === "question" ? withdrawOpenBlocks(message.blocks, reason === "Cancelled" || reason === RUN_STOPPED_BY_USER ? null : reason) : message.blocks;
      assistant = updateMessage(p.message_id, { blocks: [...blocks, { type: "notice", level: "info", text: reason }] });
    });
  }
  if (p?.reason === "question") safely("withdraw the question", () => withdrawQuestion(row.id, reason));
  const run = getRun(row.id);
  if (p && convAlive && row.started_at) {
    safely("append transcript", () => {
      const users = [p.user_message_id, ...parseJson<string[]>(p.also_answers, [])].flatMap((id) => (id ? [getMessage(id)] : []));
      appendTranscript(row.conversation_id, run, users, assistant);
    });
  }
  if (p) dropPause(p);
  bus.emit({ type: "run.finished", run });
  bus.changed("runs");
  for (const child of delegatedBy(row.id)) void cancelRun(child, "Cancelled (parent run was cancelled)").catch((err) => log.warn(`could not cancel run ${child}`, err));
  // Runs that waited behind the pause go on.
  pump();
}

/**
 * Claude Code asks between two steps of a run (PostToolBatch hook) whether the human wrote in the meantime: the messages
 * waiting in the chat's queue join the run here. Returns what Claude gets to read, or null when nothing waits.
 */
export function deliverQueued(runId: string): string | null {
  const job = jobs.get(runId);
  // A run that is ending (stopped, timed out, being paused) takes nothing: the message would go down with it.
  if (!job || job.status !== "running" || job.cancelReason || job.timedOut || job.stalled || job.pause) return null;
  const taken = takeQueued(job.conversationId, getAgent(job.agentId));
  if (!taken.length) return null;
  for (const { message } of taken) job.acc.addUserMessage(message);
  // Stored right away: the messages are out of the queue and live in this turn from now on.
  job.lastPersistAt = 0;
  emitDelta(job);
  log.info("queued messages picked up", { runId, count: taken.length });
  return queuedMessagesContext(getSettings().general.userName, taken.map((t) => t.prompt));
}

/**
 * A run of the chat is asking the human right now — between its question and standing still for it (a few seconds).
 * Resolves once it stands still (or ends), so a reply sent meanwhile counts as the answer.
 */
export async function untilAsked(conversationId: string, ms = 15_000): Promise<void> {
  const job = [...jobs.values()].find((j) => j.conversationId === conversationId && j.pause?.reason === "question" && !j.cancelReason);
  if (job) await waitForRun(job.runId, ms, { orPaused: true }).catch(() => undefined);
}

/**
 * Resolve when the run reaches a terminal state, or with its current state after `timeoutMs`. `orPaused`: also when
 * it stands still — it may stay that way for hours.
 */
export function waitForRun(runId: string, timeoutMs?: number, opts: { orPaused?: boolean } = {}): Promise<Run> {
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
      if ((e.type === "run.finished" || (opts.orPaused && e.type === "run.paused")) && e.run.id === runId) finish(() => resolve(e.run));
    });
    let current: Run;
    try {
      current = getRun(runId);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    if ((TERMINAL.has(current.status) || (opts.orPaused && current.status === "paused")) && !jobs.has(runId)) {
      finish(() => resolve(current));
      return;
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => finish(() => resolve(getRun(runId))), timeoutMs);
    }
  });
}

/**
 * Mark runs left in queued/running state by a previous process as failed. Runs of chats on a runner are copies of the
 * runner's: a restart of this computer did not interrupt them.
 */
export function recoverInterruptedRuns(): void {
  const stale = all<RunRow>(
    `SELECT r.* FROM runs r WHERE r.status IN ('queued', 'running')
     AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.conversation_id AND c.runner_id IS NOT NULL)`,
  ).filter((r) => !jobs.has(r.id));
  if (!stale.length) return;
  const ts = now();
  const agentIds = new Set<string>();
  // An agent that was working when Godmode stopped says "Last run failed" until it runs again (latest run wins).
  const broke = new Map<string, string>();
  for (const r of stale) {
    sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", INTERRUPTED, ts, r.id);
    agentIds.add(r.agent_id);
    if (r.status === "running" && r.trigger !== "dream" && r.trigger !== "check") broke.set(r.agent_id, r.id);
    for (const m of all<{ id: string; content: string; blocks: string }>(
      "SELECT id, content, blocks FROM messages WHERE run_id = ? AND role = 'assistant'",
      r.id,
    )) {
      const blocks = withdrawOpenBlocks(parseJson<Message["blocks"]>(m.blocks, []), "Godmode restarted before this was asked.");
      blocks.push({ type: "error", text: INTERRUPTED });
      sql("UPDATE messages SET blocks = ? WHERE id = ?", JSON.stringify(blocks), m.id);
    }
  }
  for (const agentId of agentIds) safely("reset agent status", () => setAgentStatus(agentId, "idle"));
  for (const [agentId, runId] of broke) safely("remember the failure", () => setAgentFailedRun(agentId, runId));
  log.info(`marked ${stale.length} interrupted run(s) as failed`);
  bus.changed("runs");
}

export async function shutdownRunner(): Promise<void> {
  shuttingDown = true;
  for (const runId of [...queue]) {
    const job = jobs.get(runId);
    if (job) await cancelRun(runId, RUN_SHUT_DOWN);
  }
  const running = [...jobs.values()].filter((j) => j.status === "running");
  for (const job of running) {
    job.cancelReason ??= RUN_SHUT_DOWN;
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
  const frozen = queue.length ? pausedConversations() : null;
  const held: { job: Job; stop: BudgetStop }[] = [];
  for (const runId of ticketOrder()) {
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
    // A paused run keeps its place: what came after it waits until it continues or is stopped.
    if (frozen?.has(job.conversationId)) {
      emitActivity(job, pauseOf(job.conversationId)?.reason === "question" ? "Waiting — this chat waits for your answer" : "Waiting — this chat is paused");
      blocked.add(job.conversationId);
      continue;
    }
    // Unattended work waits while a monthly budget is used up (what the human starts or lets run still goes). Only a
    // run that would start now is held: its chat has nothing working or standing still, so the hold is the chat's pause.
    if (!job.exempt && !job.pause && !job.cancelReason && (HELD_TRIGGERS.has(job.trigger) || platformChat(job))) {
      const stop = budgetStopFor(job.agentId);
      if (stop) {
        held.push({ job, stop });
        blocked.add(job.conversationId);
        continue;
      }
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
  // After the loop: suspending takes the run out of the queue and pumps again.
  const stillFree = held.length ? pausedConversations() : null;
  for (const { job, stop } of held) {
    if (jobs.get(job.runId) !== job || job.pause || job.status !== "queued" || stillFree?.has(job.conversationId)) continue;
    job.pause = { reason: "budget", applied: true, budget: { scope: stop.scope, limitUsd: stop.budgetUsd }, resumeAt: nextMonthStart().toISOString() };
    void suspend(job, null, Date.now());
  }
}

/** Automations, follow-ups, heartbeats and board tickets: work nobody waits for at the screen, held while a budget is used up. */
const HELD_TRIGGERS: ReadonlySet<RunTrigger> = new Set(["routine", "followup", "task", "heartbeat"]);

/** A message from Slack, Telegram or Teams: anyone in that channel could spend past the owner's budget. */
function platformChat(job: Job): boolean {
  if (job.trigger !== "chat") return false;
  const origin = get<{ origin: string }>("SELECT origin FROM conversations WHERE id = ?", job.conversationId)?.origin;
  return origin === "slack" || origin === "telegram" || origin === "teams";
}

/** The human started this run or let it run (or it is a chat they lead): a used-up budget doesn't stop it or its handoffs. */
export function runExempt(runId: string): boolean {
  const job = jobs.get(runId);
  if (job?.exempt) return true;
  const trigger = job?.trigger ?? get<{ trigger: string }>("SELECT trigger FROM runs WHERE id = ?", runId)?.trigger;
  return trigger === "chat" || trigger === "manual" || trigger === "api";
}

function budgetStopFor(agentId: string): BudgetStop | null {
  try {
    return exhaustedBudget(getAgent(agentId));
  } catch {
    return null;
  }
}

/** The agent's name for the spend ledger (it keeps the name when the agent is deleted later). */
function agentNameOf(agentId: string): string {
  return get<{ name: string }>("SELECT name FROM agents WHERE id = ?", agentId)?.name ?? "";
}

/**
 * The queue with board tickets' runs in priority order (then the earliest due day, then first come). Only the places
 * ticket runs hold are shared out among them: the human's chat, an automation or a run that continues after a pause
 * keeps its turn, and the runs of one ticket keep their order.
 */
function ticketOrder(): string[] {
  const order = [...queue];
  const candidates = order
    .map((runId, index) => ({ runId, index, job: jobs.get(runId) }))
    .filter((c) => c.job && !c.job.resumed && (c.job.trigger === "task" || c.job.trigger === "followup"));
  if (candidates.length < 2) return order;
  const convs = [...new Set(candidates.map((c) => c.job!.conversationId))];
  const tickets = new Map(
    all<{ conversation_id: string; priority: TaskPriority; due_date: string | null }>(
      `SELECT conversation_id, priority, due_date FROM tasks WHERE conversation_id IN (${convs.map(() => "?").join(",")})`,
      ...convs,
    ).map((t) => [t.conversation_id, t]),
  );
  const slots = candidates.filter((c) => tickets.has(c.job!.conversationId));
  if (slots.length < 2) return order;
  const key = (c: (typeof slots)[number]) => tickets.get(c.job!.conversationId)!;
  const sorted = [...slots].sort((a, b) => {
    const ta = key(a);
    const tb = key(b);
    return (
      (TASK_PRIORITY_RANK[ta.priority] ?? 2) - (TASK_PRIORITY_RANK[tb.priority] ?? 2) ||
      (ta.due_date ?? "9999").localeCompare(tb.due_date ?? "9999") ||
      a.index - b.index
    );
  });
  slots.forEach((slot, i) => (order[slot.index] = sorted[i]!.runId));
  return order;
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

onLaunchProblem((runId, text) => {
  const job = jobs.get(runId);
  if (job?.status !== "running") return;
  job.acc.addNotice("warning", text);
  scheduleDelta(job);
});

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

/** The agent's place on the team for its prompt; a lookup that fails leaves the block without a reporting line. */
function teamFor(agent: Agent): ReturnType<typeof teamOf> | undefined {
  try {
    return teamOf(agent);
  } catch (err) {
    log.warn(`could not read the team of agent ${agent.id}`, err);
    return undefined;
  }
}

// A new socket learns every active run (so a reloaded app shows the truth, queued apart from running) and its label.
setWelcomeEvents(() =>
  [...jobs.values()].flatMap((j): ServerEvent[] => {
    let started: Run | null = null;
    try {
      started = getRun(j.runId);
    } catch {
      return [];
    }
    return [{ type: "run.started", run: started }, ...(j.lastLabel ? [{ type: "run.activity" as const, runId: j.runId, agentId: j.agentId, label: j.lastLabel }] : [])];
  }),
);

/** Names for the plain-words activity: agents by name, logins by site (never a username or secret); secrets masked. */
function activityNames(job: Job): ActivityNames {
  if (job.names) return job.names;
  const agents = new Map<string, string | undefined>();
  const logins = new Map<string, string | undefined>();
  job.names = {
    agent: (id) => {
      if (!agents.has(id)) agents.set(id, get<{ name: string }>("SELECT name FROM agents WHERE id = ?", id)?.name);
      return agents.get(id);
    },
    login: (id) => {
      if (!logins.has(id)) {
        const row = get<{ name: string; domains: string }>("SELECT name, domains FROM credentials WHERE id = ?", id);
        logins.set(id, row ? (parseJson<string[]>(row.domains, [])[0] ?? row.name) : undefined);
      }
      return logins.get(id);
    },
    redact,
  };
  return job.names;
}

function emitActivity(job: Job, text: string) {
  // A workflow's label quotes what the model wrote, like the blocks do. Masked first, then cut.
  const label = redact(text).slice(0, 120);
  if (label === job.lastLabel) return;
  job.lastLabel = label;
  bus.emit({ type: "run.activity", runId: job.runId, agentId: job.agentId, label });
}

/* ------------------------------------------------------------------ */
/* The in-flight message                                               */
/* ------------------------------------------------------------------ */

/**
 * A block as clients and the database get it: saved secrets masked. A long run has hundreds of blocks and megabytes of
 * tool output and screenshots, and all but the last few never change again — so each is masked and serialized once,
 * and made again only when it changed.
 */
interface LiveBlock {
  /**
   * The block's fields when this was made, objects among them copied one level down: blocks are changed in place, and
   * so is a tool call's `task` (its progress). Any difference means it changed.
   */
  seen: Record<string, unknown>;
  redacted: MessageBlock;
  /** `redacted` as JSON, for the row saved while the run works; made when first saved. */
  json: string | null;
}

interface LiveView {
  /** Tells this job's deltas from those of another stretch of the run (a paused run continues in a new job). */
  stream: string;
  /** `redactionEpoch` the blocks were masked under. */
  epoch: string;
  blocks: WeakMap<MessageBlock, LiveBlock>;
  /** What the clients have after the last delta, by index. */
  sent: MessageBlock[];
  /** Deltas sent so far. */
  seq: number;
}

function liveOf(job: Job): LiveView {
  return (job.live ??= { stream: newId("str"), epoch: redactionEpoch(), blocks: new WeakMap(), sent: [], seq: 0 });
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shallowEqual(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

function snapshotOf(block: MessageBlock): Record<string, unknown> {
  const out: Record<string, unknown> = { ...block };
  for (const [k, v] of Object.entries(out)) if (isPlain(v)) out[k] = { ...v };
  return out;
}

function unchanged(seen: Record<string, unknown>, block: MessageBlock): boolean {
  const now = block as Record<string, unknown>;
  const keys = Object.keys(seen);
  if (keys.length !== Object.keys(now).length) return false;
  for (const k of keys) {
    const a = seen[k];
    const b = now[k];
    if (a === b) continue;
    if (!isPlain(a) || !isPlain(b) || !shallowEqual(a, b)) return false;
  }
  return true;
}

/** The run's blocks with saved secrets masked; only the ones that changed since the last call are masked again. */
function liveBlocks(job: Job): LiveBlock[] {
  const live = liveOf(job);
  const epoch = redactionEpoch();
  // A secret was saved or the vault locked meanwhile: what was masked before may read differently now.
  if (live.epoch !== epoch) {
    live.epoch = epoch;
    live.blocks = new WeakMap();
  }
  return job.acc.blocks.map((block) => {
    const known = live.blocks.get(block);
    if (known && unchanged(known.seen, block)) return known;
    const redacted = redactBlock(block, redact);
    // Never the block itself: a later change in place must show as a different object.
    const made: LiveBlock = { seen: snapshotOf(block), redacted: redacted === block ? { ...block } : redacted, json: null };
    live.blocks.set(block, made);
    return made;
  });
}

/** For the row that is saved while the run works: each block is serialized once (screenshots are megabytes). */
function storedJson(b: LiveBlock): string {
  return (b.json ??= JSON.stringify(b.redacted));
}

/** The run's blocks as they are stored and shown, secrets masked. */
function redactedBlocks(job: Job): MessageBlock[] {
  return liveBlocks(job).map((b) => b.redacted);
}

/** Tell the clients what changed in the in-flight message since the last delta, and save it every few seconds. */
function emitDelta(job: Job) {
  if (job.deltaTimer) {
    clearTimeout(job.deltaTimer);
    job.deltaTimer = null;
  }
  job.lastDeltaAt = Date.now();
  timedSync("run delta", () => {
    const live = liveOf(job);
    const view = liveBlocks(job);
    const patch: [number, MessageBlock][] = [];
    for (let i = 0; i < view.length; i++) if (live.sent[i] !== view[i]!.redacted) patch.push([i, view[i]!.redacted]);
    const textDelta = redact(job.acc.takeTextDelta());
    if (patch.length || live.sent.length !== view.length || textDelta) {
      live.sent = view.map((b) => b.redacted);
      live.seq++;
      bus.emit({
        type: "run.delta",
        runId: job.runId,
        conversationId: job.conversationId,
        messageId: job.messageId,
        stream: live.stream,
        seq: live.seq,
        patch,
        length: view.length,
        ...(textDelta ? { textDelta } : {}),
      });
    }
    if (Date.now() - job.lastPersistAt < (job.persistEveryMs ?? persistIntervalMs)) return;
    job.lastPersistAt = Date.now();
    const started = performance.now();
    safely("persist in-flight message", () => sql("UPDATE messages SET blocks = ? WHERE id = ?", `[${view.map(storedJson).join(",")}]`, job.messageId));
    const ms = performance.now() - started;
    job.slowestPersistMs = Math.max(job.slowestPersistMs ?? 0, ms);
    job.persistEveryMs = Math.max(persistIntervalMs, Math.round(ms * persistBackoff));
  });
}

function scheduleDelta(job: Job) {
  if (job.deltaTimer) return;
  const wait = Math.max(0, DELTA_INTERVAL_MS - (Date.now() - job.lastDeltaAt));
  job.deltaTimer = setTimeout(() => emitDelta(job), wait);
}

/** The whole in-flight message of running jobs, for a client that joins while they run or missed a delta. */
setRunSnapshots((want) => {
  const out: RunDelta[] = [];
  for (const job of jobs.values()) {
    const live = job.live;
    // A paused run that continues has sent its blocks while it waits for its turn.
    if (!live?.seq) continue;
    if ((want.runId && want.runId !== job.runId) || (want.conversationId && want.conversationId !== job.conversationId)) continue;
    out.push({ type: "run.delta", runId: job.runId, conversationId: job.conversationId, messageId: job.messageId, stream: live.stream, seq: live.seq, blocks: live.sent });
  }
  return out;
});

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

/** The raw run log: a new file, or the same one again when the run continues after a pause. */
interface RunLog {
  write(line: string): unknown;
  end(): unknown;
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
  logSink: RunLog,
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
  job.spawnedAt ??= Date.now();
  job.lastOutputAt = Date.now();
  if (halted(job)) killTree(proc);
  try {
    proc.stdin.write(prompt);
    await proc.stdin.end();
  } catch (err) {
    log.warn(`could not write the prompt to claude (run ${job.runId})`, err);
  }
  const stderrP = readTail(proc.stderr, STDERR_TAIL_BYTES);
  await readLines(proc.stdout, (raw) => {
    const line = raw.trim();
    job.lastOutputAt = Date.now();
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
    // Claude has read the human's answer the moment it starts replying: settle it now, so a crash later in the run
    // can't hand the same answer (an approval: "Do it now") to the next turn again.
    if (job.acc.answered && !job.answersSettled) {
      job.answersSettled = true;
      settleAnswers(job);
    }
    emitActivity(job, job.pause && !job.cancelReason ? (job.pause.reason === "question" ? "Asking you…" : "Pausing…") : job.acc.activityLabel(activityNames(job)));
  });
  const exitCode = await proc.exited;
  const stderr = await stderrP;
  job.proc = null;
  return { exitCode, stderr, noise };
}

/** Who wrote a user message, as a recap names them. */
const SOURCE_SPEAKER: Record<NonNullable<Message["source"]> | "human", string> = { human: "User", automation: "Automation", delegation: "Delegated task", task: "Task" };

function recapPrefix(job: Job): string {
  // A run that continues after a pause sends a note instead of its prompt: its own task and answer so far belong to the recap.
  const own = (id: string) => !job.resumed && (id === job.messageId || id === job.userMessageId || job.alsoAnswers.includes(id));
  const msgs = listMessages(job.conversationId)
    .filter((m) => !own(m.id) && m.role !== "system" && m.content.trim())
    .slice(-10);
  if (!msgs.length) return "";
  // A handed-over task is stored bare; the run's prompt still says who handed it over and where the answer goes.
  const ownPrompt = job.resumed ? (get<{ prompt: string }>("SELECT prompt FROM runs WHERE id = ?", job.runId)?.prompt ?? null) : null;
  const lines = msgs.map((m) => {
    // The task a continued run works on must arrive whole.
    const max = job.resumed && (m.id === job.userMessageId || job.alsoAnswers.includes(m.id)) ? 20_000 : 1500;
    const content = m.id === job.userMessageId && m.source && ownPrompt ? ownPrompt : m.content;
    const text = content.length > max ? `${content.slice(0, max - 1)}…` : content;
    return `${m.role === "user" ? SOURCE_SPEAKER[m.source ?? "human"] : "Assistant"}: ${text}`;
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
        return RUN_MAX_TURNS;
      case "error_max_budget_usd":
        return RUN_COST_LIMIT;
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

/**
 * What this stretch of the run sends to Claude: the prompt, or — when the run continues after a pause — a note to pick
 * the work up, with the messages that waited in the chat's queue meanwhile.
 */
function bodyOf(job: Job, agent: Agent): string {
  const resumed = job.resumed;
  if (!resumed) return job.prompt;
  const taken = takeQueued(job.conversationId, agent);
  for (const { message } of taken) job.acc.addUserMessage(message);
  if (taken.length) scheduleDelta(job);
  const messages = taken.map((t) => t.prompt);
  if (resumed.redo !== null) return [resumed.redo, ...messages].join("\n\n");
  return continueContext({ reason: resumed.reason, userName: getSettings().general.userName, pausedAt: resumed.pausedAt, messages, answer: resumed.answer });
}

/** The usage limit that ended the run, when that is why it failed and the run can wait for the reset. */
function limitOf(job: Job, attempt: Attempt): LimitPause | null {
  // Checks and dreams come round again by themselves; delegated work reports its failure to the run that waits for it.
  if (job.trigger === "check" || job.trigger === "dream" || job.parentRunId) return null;
  const { final, limit, limitLine } = job.acc;
  if (final?.subtype === "error_max_turns" || final?.subtype === "error_max_budget_usd") return null;
  // The answer itself only counts while Claude reports a limit as reached: the model may write about limits too.
  const said = [limitLine ?? "", limit ? (final?.text ?? "") : "", final?.errors.join("\n") ?? "", attempt.stderr, attempt.noise.join("\n")].join("\n");
  // Refused requests (429) while Claude reports a limit as reached are that limit, whatever the wording.
  return limitReached(limit, final?.apiErrorStatus === 429 && limit ? `${said}\nusage limit reached` : said);
}

async function runClaude(job: Job, agent: Agent, res: Resources): Promise<Outcome> {
  const settings = getSettings();
  const cmd = resolveClaudeCommand();
  if (!cmd) return { status: "failed", error: CLAUDE_NOT_FOUND };
  // Every run needs the agent repo (cwd or --add-dir); rebuild it if it went missing (e.g. restored backup without repos).
  await ensureAgentRepo(agent);

  const conv = get<{
    claude_session_id: string | null;
    claude_session_cost_usd: number | null;
    working_directory: string | null;
    model: string | null;
    effort: Effort | null;
    ultracode: number | null;
    instructions: string | null;
    instructions_digest: string | null;
    memory_digest: string | null;
    secret_access: string | null;
  }>(
    "SELECT claude_session_id, claude_session_cost_usd, working_directory, model, effort, ultracode, instructions, instructions_digest, memory_digest, secret_access FROM conversations WHERE id = ?",
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
    const watch = setInterval(() => halted(job) && cancelled.abort(), 250);
    const onActivity = (label: string) => emitActivity(job, label);
    try {
      try {
        vm = await attachVm(job.runId, vmId, onActivity, cancelled.signal);
      } catch (err) {
        return halted(job) ?? { status: "failed", error: `The virtual machine can't be used: ${errorText(err)}` };
      }
      const stop = halted(job);
      if (stop) return stop;
      const browser = settings.browser.enabled && agent.browser.enabled;
      guest = await prepareGuest(vm.id, { browser, onActivity, signal: cancelled.signal }).catch((err: unknown) => ({
        browser: null,
        cua: null,
        shellAutomation: false,
        problems: [`The VM's browser and computer-use tools are unavailable in this run: ${errorText(err)}`],
      }));
      const stopped = halted(job);
      if (stopped) return stopped;
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
        shellAutomation: !!guest?.shellAutomation,
        vaultFill: settings.vm.vaultFill,
      }
    : null;
  // A task's own git worktree (tasks/service.ts), when this chat is one and works there.
  const task = dreaming
    ? null
    : get<{ repo_url: string; repo_path: string; branch: string }>(
        "SELECT repo_url, repo_path, branch FROM tasks WHERE conversation_id = ? AND branch IS NOT NULL",
        job.conversationId,
      );
  // The project the chat works on (its own, else the agent's).
  const project = dreaming ? null : projectOfChat(job.conversationId, agent);
  // The workspace's and the project's folders and repositories; a missing clone is cloned first. A dream only works on its memory.
  let sources: RunSource[] = [];
  const owners = [
    ...(agent.workspaceId ? [{ workspaceId: agent.workspaceId, projectId: null }] : []),
    ...(project ? [{ workspaceId: project.workspaceId, projectId: project.id }] : []),
  ];
  if (!dreaming && owners.length) {
    const cancelled = new AbortController();
    const watch = setInterval(() => halted(job) && cancelled.abort(), 250);
    try {
      const prepared = await prepareSources(owners, { onActivity: (label) => emitActivity(job, label), signal: cancelled.signal });
      // A task works in its own worktree: the workspace's shared copy of that repository (the human's folder or the
      // clone) stays out of reach, so tasks never edit each other's files.
      const taskRepo = (s: RunSource) => !!task && ((!!task.repo_path && s.path === task.repo_path) || (!!task.repo_url && s.url === task.repo_url));
      const seen = new Set<string>();
      sources = prepared.sources.filter((s) => s.path !== cwd && s.path !== agent.repoPath && !taskRepo(s) && !seen.has(s.path) && !!seen.add(s.path));
      for (const text of prepared.notices) job.acc.addNotice("warning", text);
    } finally {
      clearInterval(watch);
    }
    const stop = halted(job);
    if (stop) return stop;
  }
  // SSH servers of the chat and the agent. Uploads and downloads stay within the folders this run works with.
  const ssh = dreaming ? [] : promptServers(runSshServerIds(job.conversationId, agent.id));
  if (ssh.length) {
    const folders = [cwd, agent.repoPath, vm?.hostSharedDir, ...sources.map((s) => s.path)].filter((f): f is string => !!f);
    attachSsh(job.runId, [...new Set(folders)]);
  }
  const mcp = await buildMcpConfig(agent, res.token, {
    onNotice: (text) => job.acc.addNotice("warning", text),
    computer: !!computer,
    vm: vm ? { id: vm.id, browser: guest?.browser ?? null, cua: guest?.cua ?? null } : null,
    gatewayOnly: dreaming,
    run: { runId: job.runId, conversationId: job.conversationId },
    browserProfileId: runProfileOf(job),
    ssh: ssh.length > 0,
  });
  const mcpPath = writeMcpConfigFile(job.runId, mcp);
  res.files.push(mcpPath);
  const model = conv.model?.trim() || agent.model?.trim() || settings.runner.model?.trim() || DEFAULT_MODEL;
  // Ultracode: the chat's choice, else the agent's, else the setting — with a model this Claude Code has it for. Dreams
  // and condition checks are small jobs with a fixed shape: never.
  const wantsUltracode = (conv.ultracode === null ? null : conv.ultracode === 1) ?? agent.ultracode ?? settings.runner.ultracode;
  const ultracode = !dreaming && job.trigger !== "check" && ultracodeFor(model, wantsUltracode === true);
  // The human's mods (Mods page). Dreams and condition checks are small jobs with a fixed shape: they load none.
  const mods = dreaming || job.trigger === "check" ? null : await modsForRun(agent, job.runId, (text) => job.acc.addNotice("warning", text));
  // Between two steps Claude Code asks for the messages waiting in the chat's queue. Dreams and condition checks run in
  // chats nobody writes to.
  const hooksPath =
    dreaming || job.trigger === "check"
      ? null
      : writeTempFile(
          res,
          `godmode-settings-${job.runId}.json`,
          JSON.stringify({
            hooks: {
              PostToolBatch: [
                { hooks: [{ type: "http", url: `${gatewayUrl()}/hooks/post-tool-batch`, timeout: 10, headers: { Authorization: `Bearer ${res.token}` } }] },
              ],
            },
            // Claude Code honours one --settings value: the session's Ultracode and the mods' options go with the hooks.
            ...(ultracode ? { ultracode: true } : {}),
            ...(mods && Object.keys(mods.configs).length ? { pluginConfigs: mods.configs } : {}),
          }),
        );
  job.hooked = !!hooksPath;
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
  const projectWorkspace = project
    ? project.workspaceId === agent.workspaceId
      ? workspace
      : get<{ name: string; instructions: string }>("SELECT name, instructions FROM workspaces WHERE id = ?", project.workspaceId)
    : null;
  const promptSources = (workspace || project) && sources.length ? { workspace: workspace?.name ?? null, project: project?.name ?? null, items: sources } : null;
  // Keys in the environment are only for Bash on this computer (and need an open vault).
  const toolKeysInEnv = !dreaming && !(vm && settings.vm.isolateHostShell);
  const toolList = dreaming ? [] : apiToolsForAgent(agent);
  const envOwners = toolKeysInEnv && isUnlocked() ? apiToolEnvOwners(toolList) : new Map<string, string>();
  const apiTools: PromptApiTool[] = toolList.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    baseUrl: t.baseUrl,
    envVar: t.envVar && envOwners.get(t.envVar) === t.id ? t.envVar : null,
  }));
  const standing = instructionsSection(settings, {
    workspace: workspace ? { name: workspace.name, text: workspace.instructions } : null,
    project: project
      ? { name: project.name, workspace: projectWorkspace?.name ?? "", description: project.description, text: project.instructions }
      : null,
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
        ssh,
        voice: job.voice,
        workingDirectory: folder,
        taskWorktree: task ? { repo: task.repo_path || task.repo_url, branch: task.branch } : null,
        sources: promptSources,
        apiTools,
        standingInstructions: standing,
        // Condition checks run every few minutes and only look at the world: no memory needed.
        memory: settings.memory.injectMemory && job.trigger !== "check" ? memoryForPrompt(agent.repoPath) : null,
        followups: job.trigger !== "check" && job.trigger !== "delegation",
        fillOnly: conv.secret_access === "fill",
        // Delegated work reports to the run that handed it over; checks only observe.
        asking: job.trigger !== "check" && !job.parentRunId,
        delegated: !!job.parentRunId,
        mods: config().role !== "runner",
        team: teamFor(agent),
      });
  const memoryNow = memoryDigest(agent.repoPath);

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
    // Non-bypass mode: allow Godmode-provided MCP tools without prompts (print mode cannot ask). Ultracode runs on
    // workflows, which Claude Code wants reviewed before each one runs: allowed too, or it would refuse them all.
    const allowed = Object.keys(mcp.mcpServers).map((n) => `mcp__${n}`);
    if (ultracode) allowed.push(WORKFLOW_TOOL);
    baseArgs.push("--permission-mode", "acceptEdits", "--allowedTools", allowed.join(","));
  }
  baseArgs.push("--mcp-config", mcpPath, "--strict-mcp-config");
  if (hooksPath) baseArgs.push("--settings", hooksPath);
  if (dreaming) baseArgs.push("--tools", DREAM_TOOLS);
  const disallowed: string[] = [];
  // Godmode's ask_human / request_approval are how an agent asks: Claude Code's own question tool would go nowhere.
  if (!dreaming) disallowed.push("AskUserQuestion");
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
  // A task's checkout too: its `.git` (a worktree's pointer file, or a clone's folder) decides what Godmode's git runs on.
  if (!bypass && task && folder) {
    const checkout = folder.replace(/\\/g, "/");
    disallowed.push(`Edit(/${checkout}/.git)`, `Edit(/${checkout}/.git/**)`);
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
  // A run that continues after a pause has what is left of its budget.
  if (budget != null && budget > 0) baseArgs.push("--max-budget-usd", String(Math.max(0.01, budget - (job.spent.costUsd ?? 0))));
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
  for (const dir of mods?.dirs ?? []) baseArgs.push("--plugin-dir", dir);
  const extraArgs = (settings.runner.extraArgs ?? []).filter((a) => typeof a === "string" && a.length > 0);

  const env = buildEnv(agent, !!folder || sources.length > 0, toolKeysInEnv);
  // Without it a headless Claude Code keeps a mod's failures to its debug log: a hook that throws, a module that
  // doesn't load. With it they reach the chat as notes from the mod. It also watches the folders — the run's own copies.
  if (mods?.dirs.length) env.CLAUDE_CODE_PLUGIN_DIR_WATCH = "1";
  const logPath = runLogPath(agent, getRun(job.runId));
  mkdirSync(join(logPath, ".."), { recursive: true });
  const logSink: RunLog = job.resumed ? createWriteStream(logPath, { flags: "a" }) : Bun.file(logPath).writer();

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
    job.sessionCostBefore = resuming ? conv.claude_session_cost_usd : null;
    const stop = halted(job);
    if (stop) return stop;
    const sessionArgs = resuming ? ["--resume", sessionId] : ["--session-id", sessionId];
    const body = (job.body = bodyOf(job, agent));
    // Claude Code only recognizes a slash command at the very start of the prompt.
    const command = parseSlashCommand(body) !== null;
    // A resumed session keeps the system prompt of its first turn: restate standing instructions that changed since.
    const restate = resuming && !command && (conv.instructions_digest ?? "") !== digest;
    if (restate) job.restatedDigest = digest;
    // Another chat, a dream or the human changed the memory since this session last saw it.
    const memoryChanged = resuming && !dreaming && conv.memory_digest != null && conv.memory_digest !== memoryNow;
    const followup = get<{ dueAt: string; note: string }>("SELECT due_at AS dueAt, note FROM followups WHERE conversation_id = ?", job.conversationId);
    // The human answered a question, but the run that took the answer broke off before Claude read it.
    const late = !command && !dreaming && !job.resumed?.answer ? owedAnswer(job.conversationId) : null;
    if (late) job.lateAnswer = late.questionId;
    // A run that stood still again before Claude read the answer already carries it in its own note: no second copy.
    const carried = !!late && !!job.resumed?.redo?.includes("<your-question>");
    const lateNote = late && !carried ? lateAnswerContext(settings.general.userName, late) : "";
    const prompt =
      resuming && !command
        ? resumeContextPrefix(folder, agent.repoPath, { instructions: restate ? standing : undefined, memoryChanged, vm: promptVm, sources: promptSources, followup, apiTools, ssh }) +
          lateNote +
          body
        : lateNote + body;
    // What the run did before a pause, and what the chat's queue added to this stretch.
    const kept = job.acc.blocks.length;
    // A chat the human started runs although a monthly budget is used up — once a month the chat says so.
    if (!job.resumed && !dreaming && (job.trigger === "chat" || job.trigger === "manual" || job.trigger === "api")) {
      let notice: string | null = null;
      safely("check the budget", () => {
        notice = exemptNotice(agent, job.conversationId);
      });
      if (notice) {
        job.acc.addNotice("warning", notice);
        scheduleDelta(job);
      }
    }
    let attempt = await spawnClaude(job, cmd, [...baseArgs, ...sessionArgs, ...extraArgs], prompt, cwd, env, logSink);

    const lostSession =
      resuming &&
      !halted(job) &&
      !job.timedOut &&
      !job.stalled &&
      (!job.acc.final || job.acc.final.isError) &&
      SESSION_MISSING.test([job.acc.final?.errors.join("\n") ?? "", attempt.stderr, attempt.noise.join("\n")].join("\n"));
    if (lostSession) {
      log.info(`Claude session ${sessionId} of conversation ${job.conversationId} is gone; starting a new one with a recap`);
      job.acc = new StreamAccumulator(job.acc.blocks.filter((b, i) => i < kept || b.type === "notice"));
      if (command) job.keepSessionId = sessionId;
      sessionId = randomUUID();
      job.sessionCostBefore = null;
      setConversationState(job.conversationId, { claudeSessionId: sessionId, instructionsDigest: digest, memoryDigest: memoryNow });
      attempt = await spawnClaude(
        job,
        cmd,
        [...baseArgs, "--session-id", sessionId, ...extraArgs],
        command ? body : recapPrefix(job) + lateNote + body,
        cwd,
        env,
        logSink,
      );
    }

    const final = job.acc.final;
    const answer = !!final && !final.isError;
    // Whatever Claude Code reports as the outcome, its own line about the limit as the answer is no answer.
    const limited = !!job.acc.limitLine && (final?.text ?? "").includes(job.acc.limitLine);
    // A run that asked the human stands still for the answer however its process ended — stopped at the next step, after
    // the grace, by itself, or at the usage limit (the answer then goes along) — unless it was stopped, timed out or
    // broke off before it could ask properly.
    if (job.pause?.reason === "question" && !job.cancelReason && !job.timedOut && !job.stalled && (job.pause.applied || answer || limitOf(job, attempt))) {
      job.pause.applied = true;
      return { status: "paused", error: null };
    }
    const ended = halted(job);
    // A run that finished while it was being stopped for a pause is finished (stopped between two steps, it never is).
    if (ended && !(ended.status === "paused" && !job.pause?.atStep && answer && !limited)) return ended;
    if (job.stalled) return { status: "failed", error: job.stalled };
    if (job.timedOut) return { status: "failed", error: `Timed out after ${timeoutMinutes} minutes` };
    if (answer && !limited) return { status: "succeeded", error: null };
    // Claude's usage limit ended the run: it stands still until the limit has reset.
    const limit = limitOf(job, attempt);
    if (limit) {
      job.pause = { reason: "limit", applied: true, ...limit };
      // As with a pause by hand: what it delegated would report back to a process that is gone.
      for (const child of delegatedBy(job.runId)) await cancelRun(child, "Stopped (the run that delegated this waits for Claude's usage limit)").catch(() => {});
      return { status: "paused", error: null };
    }
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
  sql("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", now(), job.runId);
  log.info("run started", { runId: job.runId, agentId: job.agentId, conversationId: job.conversationId, trigger: job.trigger, ...(job.resumed ? { continues: job.resumed.reason } : {}), ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}) });
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
    safely("remove the run's mods", () => removeRunMods(job.runId));
    await detachComputer(job.runId).catch(() => {});
    detachVm(job.runId);
    detachSsh(job.runId);
  }
  if (job.pauseTimer) clearTimeout(job.pauseTimer);
  job.pauseTimer = null;
  if (job.cancelReason && outcome.status !== "cancelled") outcome = { status: "cancelled", error: job.cancelReason };
  if (outcome.status === "paused") return suspend(job, agent, startedMs);
  // Always push the final streamed state (a throttled delta may still be pending).
  if (job.status === "running") safely("emit final delta", () => emitDelta(job));
  await finalize(job, outcome, agent, startedMs);
}

function sum(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

/**
 * What this stretch of the run cost. Claude Code reports the total of the whole Claude session: on a resumed one the
 * chat's earlier runs are in it, so what the session had counted before comes off. (A total below that is no running
 * total — an older Claude Code, or a session that started over — and is taken as it is.)
 */
function stretchCost(job: Job): number | null {
  const total = job.acc.final?.costUsd ?? null;
  const before = job.sessionCostBefore ?? null;
  if (total === null || before === null || total < before) return total;
  return Math.round((total - before) * 1e6) / 1e6;
}

/** Book what the stretch that just ended cost (the run's total so far minus what earlier stretches booked). */
function bookStretch(job: Job, spent: Spent, failed: boolean): void {
  bookSpend({
    runId: job.runId,
    agentId: job.agentId,
    agentName: agentNameOf(job.agentId),
    trigger: job.trigger,
    costUsd: (spent.costUsd ?? 0) - (job.spent.costUsd ?? 0),
    durationMs: (spent.durationMs ?? 0) - (job.spent.durationMs ?? 0),
    failed,
  });
}

/** Cost, time and turns of the run so far: the stretches before a pause plus the one that just ended. */
function spentBy(job: Job, startedMs: number): Spent {
  const { final } = job.acc;
  const before = job.spent;
  // Claude Code times each result's own turn. With several (a workflow outlived its turn) the wait for the workflow
  // between them is in none: the clock counts then.
  const ownMs = job.acc.results > 1 ? null : final?.durationMs;
  return {
    costUsd: sum(before.costUsd, stretchCost(job)),
    durationMs: sum(before.durationMs, ownMs ?? (job.status === "running" ? Date.now() - startedMs : null)),
    numTurns: sum(before.numTurns, final?.numTurns),
    usage: addUsage(before.usage, final?.usage ?? null),
  };
}

/** What the runner knows about the chat after a stretch of a run: its Claude session, title, instructions and memory. */
function saveConversation(job: Job, agent: Agent | null, succeeded: boolean, ts: string) {
  const acc = job.acc;
  const row = get<{ title: string; instructions_digest: string | null }>("SELECT title, instructions_digest FROM conversations WHERE id = ?", job.conversationId);
  const title = row?.title === DEFAULT_CONVERSATION_TITLE && job.userMessageId ? autoTitle(job.userMessageId) : undefined;
  let digest = succeeded && job.restatedDigest !== undefined ? job.restatedDigest : (row?.instructions_digest ?? null);
  // A restatement lives in the transcript, which compaction summarizes.
  if (acc.compacted && digest) digest = STALE_DIGEST;
  setConversationState(job.conversationId, {
    // After /clear the next turn starts a brand-new session instead of resuming the old one.
    ...(acc.contextCleared
      ? { claudeSessionId: null }
      : job.keepSessionId
        ? { claudeSessionId: job.keepSessionId }
        : acc.sessionId
          ? // With what the session has cost so far (a stretch that ended without saying keeps the count from before).
            { claudeSessionId: acc.sessionId, claudeSessionCostUsd: acc.final?.costUsd ?? job.sessionCostBefore ?? null }
          : {}),
    lastMessageAt: ts,
    ...(digest !== null && digest !== row?.instructions_digest ? { instructionsDigest: digest } : {}),
    // The session knows the memory as of its start plus its own edits; changes from elsewhere during the run are
    // pointed out on the next turn (when unsure, a harmless extra hint beats a missed one).
    ...(agent && job.memorySeen !== undefined && job.trigger !== "dream"
      ? { memoryDigest: editedMemory(acc.blocks) ? memoryDigest(agent.repoPath) : job.memorySeen }
      : {}),
    ...(title && title !== DEFAULT_CONVERSATION_TITLE ? { title } : {}),
    ...(succeeded ? commandOverrides(acc.localCommand) : {}),
  });
}

/** Claude read the human's answers this stretch carried: they are not owed anymore. */
function settleAnswers(job: Job) {
  if (!job.acc.answered) return;
  if (job.resumed?.answer) safely("settle the answer", () => settleOwed(job.resumed!.answer!.questionId));
  if (job.lateAnswer) safely("settle the late answer", () => settleOwed(job.lateAnswer!));
}

/**
 * The run stands still (paused by the human, or waiting for Claude's usage limit): what it did so far is kept with
 * what continuing needs. It has not ended — no `run.finished`, nothing that waits for its end is told. Never throws.
 */
async function suspend(job: Job, agent: Agent | null, startedMs: number): Promise<void> {
  const pause = job.pause!;
  const acc = job.acc;
  const ts = now();
  const wasRunning = job.status === "running";
  const answered = acc.answered;
  const before = job.resumed;
  // Tries by the timer that hit the limit again before Claude answered.
  const retries = pause.reason === "limit" && !answered && before ? before.retries + (before.byTimer ? 1 : 0) : 0;
  // What the human chose for this run stays; otherwise the setting decides.
  const choice = before?.choice ?? null;
  const wanted = choice ?? getSettings().runner.autoContinueOnLimit;
  // A run that continued with the human's answer and stands still again before Claude read it keeps the answer: it is
  // sent again when the run continues.
  const answerNote =
    before?.answer && !answered && job.body === undefined
      ? continueContext({ reason: before.reason, userName: getSettings().general.userName, pausedAt: before.pausedAt, messages: [], answer: before.answer })
      : null;
  const delivered = answered || (!!before && before.redo === null && job.body === undefined && !answerNote);
  const unsent = delivered ? null : (job.body ?? before?.redo ?? answerNote ?? job.prompt);
  const row: PausedRow = {
    run_id: job.runId,
    conversation_id: job.conversationId,
    agent_id: job.agentId,
    message_id: job.messageId,
    user_message_id: job.userMessageId,
    also_answers: JSON.stringify(job.alsoAnswers),
    reason: pause.reason,
    limit_name: pause.limit ?? null,
    resume_at: pause.resumeAt ?? null,
    // Held for a budget: it continues by itself next month, or once the budget has room again.
    auto: (pause.reason === "limit" && !!pause.resumeAt && retries < MAX_RETRIES && wanted) || pause.reason === "budget" ? 1 : 0,
    budget_scope: pause.budget?.scope ?? null,
    budget_usd: pause.budget?.limitUsd ?? null,
    // The human let it run (or started it): that holds after this pause too.
    exempt: job.exempt ? 1 : 0,
    choice: choice === null ? null : choice ? 1 : 0,
    delivered: delivered ? 1 : 0,
    redo: unsent === null ? null : redact(unsent),
    retries,
    depth: job.depth,
    voice: job.voice ? 1 : 0,
    created_at: ts,
  };
  const spent = spentBy(job, startedMs);
  const asked = pause.reason === "question" ? pause.question : undefined;
  acc.markPause({
    type: "pause",
    reason: pause.reason,
    at: ts,
    ...(pause.reason === "limit" ? { limit: row.limit_name, resumeAt: row.resume_at } : {}),
    ...(pause.budget ? { budget: pause.budget, resumeAt: row.resume_at } : {}),
  });
  const text = redact(acc.lastTurnText());
  const blocks = redactedBlocks(job);
  if (job.deltaTimer) clearTimeout(job.deltaTimer);
  job.deltaTimer = null;
  jobs.delete(job.runId);
  const idx = queue.indexOf(job.runId);
  if (idx >= 0) queue.splice(idx, 1);

  try {
    if (!conversationExists(job.conversationId)) throw new Error("Conversation was deleted");
    sql(
      "UPDATE runs SET status = 'paused', result = ?, error = NULL, cost_usd = ?, duration_ms = ?, num_turns = ?, usage = ?, model = ? WHERE id = ?",
      text || null,
      spent.costUsd,
      spent.durationMs,
      spent.numTurns,
      spent.usage ? JSON.stringify(spent.usage) : null,
      acc.model ?? job.model ?? null,
      job.runId,
    );
    updateMessage(job.messageId, { content: text, blocks });
    saveConversation(job, agent, false, ts);
    // What Claude never got is sent again when the run continues.
    if (unsent === null) unanswered.delete(job.runId);
    else unanswered.set(job.runId, unsent);
    // An open question and the pause that waits for it exist together or not at all.
    tx(() => {
      if (asked) {
        saveQuestion(asked, { runId: job.runId, agentId: job.agentId, conversationId: job.conversationId, messageId: job.messageId, cutOff: !!pause.killed });
      }
      savePause(row);
    });
  } catch (err) {
    // A run that can't be kept must not look paused forever, and nothing may freeze its chat.
    log.error(`run ${job.runId} could not be paused`, err);
    safely("drop the pause", () => sql("DELETE FROM paused_runs WHERE run_id = ?", job.runId));
    if (asked) safely("drop the question", () => sql("DELETE FROM questions WHERE id = ?", asked.block.id));
    unanswered.delete(job.runId);
    acc.blocks.pop();
    jobs.set(job.runId, job);
    return finalize(job, { status: "failed", error: `The run couldn't be paused: ${errorText(err)}` }, agent, startedMs);
  }

  if (wasRunning) {
    // Booked once the pause is saved: a pause that couldn't be saved ends as a failed run, which books it then.
    safely("book the spend", () => bookStretch(job, spent, false));
    const others = [...jobs.values()].some((j) => j.agentId === job.agentId && j.status === "running");
    if (!others) safely("set agent status", () => setAgentStatus(job.agentId, "idle"));
    safely("touch agent", () => touchAgentRun(job.agentId));
  }
  settleAnswers(job);
  emitActivity(job, asked ? "Waiting for your answer" : pause.reason === "budget" ? "Held — a monthly budget is used up" : "Paused");
  safely("emit run.paused", () => bus.emit({ type: "run.paused", run: getRun(job.runId) }));
  bus.changed("runs");
  if (asked) safely("announce the question", () => announceQuestion(asked.block.id));
  log.info("run paused", { runId: job.runId, reason: pause.reason, ...(row.resume_at ? { resumeAt: row.resume_at, auto: !!row.auto } : {}) });
  if (pause.reason === "limit" && retries >= MAX_RETRIES && wanted) {
    safely("stop continuing", () => stopContinuing(row, `Claude still reports its ${row.limit_name ?? "usage limit"} after ${MAX_RETRIES} tries. Continue the chat when the limit has reset.`));
  }
  // The slot is free: other chats go on.
  pump();
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
  // A question the run asked but never stood still for (it was stopped, timed out or broke off right after) is gone.
  if (job.pause?.question) acc.blocks.splice(0, acc.blocks.length, ...withdrawOpenBlocks(acc.blocks, "Stopped before it could wait for your answer."));
  const blocks = redactedBlocks(job);
  const error = outcome.error ? redact(outcome.error) : null;
  if (outcome.status === "failed" && error) blocks.push({ type: "error", text: error });
  if (outcome.status === "cancelled") blocks.push({ type: "notice", level: "info", text: error ?? "Cancelled" });
  const ts = now();
  const wasRunning = job.status === "running";
  const spent = spentBy(job, startedMs);
  if (wasRunning) safely("book the spend", () => bookStretch(job, spent, outcome.status === "failed"));
  unanswered.delete(job.runId);
  settleAnswers(job);
  // Stopped before Claude read an answer: it must not reach a later turn as an order. (Not when Godmode shuts down, and
  // not when the human's queued messages take over: then the answer goes along with them.)
  if (outcome.status === "cancelled" && !shuttingDown && !job.thenQueue) safely("drop the owed answer", () => dropOwedAnswers(job.conversationId));

  safely("update run row", () =>
    sql(
      `UPDATE runs SET status = ?, result = ?, error = ?, cost_usd = ?, duration_ms = ?, num_turns = ?, usage = ?, model = ?, finished_at = ? WHERE id = ?`,
      outcome.status,
      text || null,
      error,
      spent.costUsd,
      spent.durationMs,
      spent.numTurns,
      spent.usage ? JSON.stringify(spent.usage) : null,
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
    safely("update conversation", () => saveConversation(job, agent, outcome.status === "succeeded", ts));
  }

  if (wasRunning) {
    // "Last run failed" follows the agent's real work (not dreams or condition checks): a failure is remembered until
    // a later run succeeds, the human stops one, or the human dismisses it. Set before run.finished goes out.
    if (job.trigger !== "dream" && job.trigger !== "check") {
      if (outcome.status === "failed") safely("remember the failure", () => setAgentFailedRun(job.agentId, job.runId));
      else if (outcome.status === "succeeded" || job.stoppedByHuman) safely("forget the failure", () => setAgentFailedRun(job.agentId, null));
    }
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
      const users = [job.userMessageId, ...job.alsoAnswers].flatMap((id) => (id ? [getMessage(id)] : []));
      appendTranscript(job.conversationId, done, users, assistant);
    });
  }
  // What the human wrote meanwhile and the agent didn't pick up becomes the next turn. A stopped run stops the chat:
  // its queue waits until the human sends it.
  if (convAlive && !shuttingDown && (outcome.status !== "cancelled" || job.thenQueue)) {
    await startQueued(job.conversationId).catch((err) => log.warn(`could not start the queue of conversation ${job.conversationId}`, err));
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

/** Why a tool call failed: its first line (the exit code) and its end — an error message closes the output. */
function failureExcerpt(result: string): string {
  const text = result.trim();
  if (text.length <= 320) return excerpt(text, 320);
  const first = text.split("\n", 1)[0]!.slice(0, 100);
  return `${excerpt(first, 100)} … ${excerpt(text.slice(-220), 220)}`;
}

/** One line per run in the diagnostic log: what it cost, how long it took and waited, which tools failed. */
function logRunFinished(job: Job, run: Run, agent: Agent | null, status: Outcome["status"], error: string | null) {
  const tools = job.acc.blocks.flatMap((b) => (b.type === "tool_use" ? [b] : []));
  const byName = new Map<string, number>();
  const failedByName = new Map<string, number>();
  let resultChars = 0;
  let imageChars = 0;
  let images = 0;
  for (const t of tools) {
    byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
    if (t.isError) failedByName.set(t.name, (failedByName.get(t.name) ?? 0) + 1);
    resultChars += t.result?.length ?? 0;
    if (t.image) {
      images++;
      imageChars += t.image.length;
    }
  }
  const usage = run.usage;
  const top = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => `${name}×${n}`);
  const sessionCost = job.acc.final?.costUsd ?? null;
  const details = {
    runId: run.id,
    agent: agent?.name ?? job.agentId,
    trigger: job.trigger,
    status,
    model: run.model,
    ms: run.durationMs,
    // From start to end by the clock: more than `ms` when the computer slept or Claude Code waited for a background task.
    wallMs: run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
    queuedMs: run.startedAt ? Date.parse(run.startedAt) - Date.parse(run.createdAt) : null,
    costUsd: run.costUsd,
    turns: run.numTurns,
    tokens: usage,
    // What the model read per turn: a chat that grew large makes every turn expensive.
    contextTokens: usage && run.numTurns ? Math.round((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) / run.numTurns) : null,
    ...(job.sessionCostBefore != null ? { resumedSession: true, sessionCostUsd: sessionCost } : {}),
    ...(job.acc.results > 1 ? { results: job.acc.results } : {}),
    toolCalls: tools.length,
    topTools: top(byName),
    ...(failedByName.size ? { failedToolCounts: top(failedByName) } : {}),
    failedTools: tools.filter((t) => t.isError).slice(0, 8).map((t) => ({ name: t.name, error: failureExcerpt(t.result ?? "") })),
    // How heavy the message got: its blocks, tool output and screenshots, and what sending and saving it took.
    blocks: job.acc.blocks.length,
    resultKb: Math.round(resultChars / 1024),
    ...(images ? { images, imageKb: Math.round(imageChars / 1024) } : {}),
    deltas: job.live?.seq ?? 0,
    ...(job.slowestPersistMs && job.slowestPersistMs >= 20 ? { slowestSaveMs: Math.round(job.slowestPersistMs) } : {}),
    ...(job.depth ? { depth: job.depth } : {}),
    ...(job.timedOut ? { timedOut: true } : {}),
    ...(job.stalled ? { watchdog: true } : {}),
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
 * Session settings from local slash commands. Claude Code keeps `/model` and `/effort` (with `/effort ultracode`) for
 * its process only, but every Godmode turn is a new process — so they are stored on the conversation. `/rename` renames
 * the chat. Only what Claude Code confirmed is stored: a rejected model would break every later turn of the chat.
 */
function commandOverrides(cmd: StreamAccumulator["localCommand"]): { model?: string | null; effort?: Effort | null; ultracode?: boolean; title?: string } {
  const arg = cmd?.args.trim();
  if (!cmd || !arg) return {};
  switch (cmd.name) {
    case "model":
      if (!/^Set model to /.test(cmd.output)) return {};
      return { model: arg.toLowerCase() === "default" ? null : arg };
    case "effort": {
      // "Ultracode on (this session only): …", "Ultracode off. Effort stays high." — and a new level ends it: "… · Ultracode off".
      const switched = /(?:^| · )Ultracode (on|off)\b/.exec(cmd.output)?.[1];
      const ultracode = switched ? { ultracode: switched === "on" } : {};
      const level = /effort level (?:set )?to (\w+)/i.exec(cmd.output)?.[1]?.toLowerCase();
      if (level === "auto") return { effort: null, ...ultracode };
      return level && (EFFORT_OPTIONS as readonly string[]).includes(level) ? { effort: level as Effort, ...ultracode } : ultracode;
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
