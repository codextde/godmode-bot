/**
 * Tasks: the Kanban board agents work from (see packages/shared/src/tasks.ts for the status flow).
 *
 * A task with an agent starts when it enters Todo (or In progress): a task with a repository (its own, or the
 * workspace's first git repository or repository folder) first gets its own git worktree on its own branch
 * (<data>/tasks/<id>), so tasks working side by side never touch each other's files or the human's copy. Then the
 * agent works in the task's conversation (origin "task", archived so it stays off the chat list). Every run in that
 * conversation — the first one and the human's follow-ups — moves the task along when it ends: In review when it
 * succeeded (coding: after pushing the branch and opening the pull request), Blocked when it failed, was stopped, or
 * the agent reported it can't go on. Merged pull requests move their task to Done. Any task's branch can also be pushed,
 * and its pull request opened, from the board.
 *
 * Archived tasks are off the board and never start (a working one is stopped and parked first); moving one, or a
 * follow-up in its conversation, brings it back.
 *
 * Descriptions are Markdown and may link files (screenshots, PDFs…, see ./attachments.ts): the agent gets a copy of
 * each and is told to read them first.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  PauseReason,
  PullRequestState,
  Run,
  RunStatus,
  ServerEvent,
  Task,
  TaskActor,
  TaskBlockedKind,
  TaskEvent,
  TaskEventData,
  TaskEventKind,
  TaskInput,
  TaskMessageInput,
  TaskPatch,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@godmode/shared";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_LABELS,
  MAX_TASK_NOTE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  cleanTaskLabel,
  isValidBranch,
  parseGitUrl,
} from "@godmode/shared";
import { config } from "../config";
import { all, get, getMeta, insert, run as sql, setMeta, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, badRequest, conflict, newId, notFound, now, parseJson, slugify } from "../util";
import { SECRET_PLACEHOLDER, redact, withoutSecrets } from "../vault/vault";
import { getAgent } from "../agents/service";
import { INTERRUPTED, activeRunForConversation, cancelRun, getRun, listActiveRuns, untilAsked, waitForRun } from "../runner/runner";
import { answerByMessage, type Answerer } from "../services/questions";
import { pauseOf, PAUSE_QUESTION_JOIN, PAUSE_QUESTION_SQL, toPause, type PauseQuestionCols } from "../services/pauses";
import { submitMessage } from "../services/messageQueue";
import { conversationExists, createConversation, sendMessage } from "../services/conversations";
import { cancelFollowup, getFollowup } from "../services/followups";
import { getSettings } from "../services/settings";
import {
  claimTaskAttachments,
  removeTaskAttachments,
  stageTaskAttachments,
  sweepTaskAttachments,
  withFileNames,
  withLocalPaths,
  withResultImages,
  type StagedAttachments,
} from "./attachments";
import { notify } from "../services/notifications";
import { workingDirectoryProblem } from "../services/folders";
import { isRepoFolder, listSources, reposDir } from "../services/workspaceSources";
import {
  commitWork,
  commitsAhead,
  needsClone,
  openPullRequest,
  prepareWorktree,
  pullRequestState,
  pushBranch,
  removeCheckout,
  removeSecrets,
  type TaskRepo,
} from "./git";

const log = logger("tasks");

const PR_WATCH_INTERVAL_MS = 5 * 60_000;
const POSITION_STEP = 1024;
const SUMMARY_MAX = 20_000;
const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
/** Statuses an agent's work (not the human) may move a task out of. */
const WORKING: readonly TaskStatus[] = ["in_progress"];
const STARTABLE: readonly TaskStatus[] = ["todo", "in_progress"];

interface TaskRow extends PauseQuestionCols {
  id: string;
  workspace_id: string | null;
  number: number;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  position: number;
  agent_id: string | null;
  conversation_id: string | null;
  repo_url: string;
  repo_path: string;
  base_branch: string;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: PullRequestState | null;
  pushed_sha: string | null;
  summary: string | null;
  blocked_reason: string | null;
  blocked_kind: TaskBlockedKind | null;
  priority: TaskPriority;
  due_date: string | null;
  labels: string;
  created_by: TaskActor;
  cost_usd: number;
  work_ms: number;
  run_count: number;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  run_id?: string | null;
  run_status?: RunStatus | null;
  run_started_at?: string | null;
  followup_due_at?: string | null;
  followup_note?: string | null;
  followup_set_at?: string | null;
  paused_run_id?: string | null;
  paused_reason?: PauseReason | null;
  paused_limit?: string | null;
  paused_resume_at?: string | null;
  paused_auto?: number | null;
  paused_budget_scope?: "agent" | "team" | null;
  paused_budget_usd?: number | null;
  paused_at?: string | null;
}

/** What Godmode is doing for a task right now (not persisted). */
const activity = new Map<string, string>();
/** Tasks being started or published (one at a time per task). */
const busy = new Set<string>();
/** Tasks the board asked to (re)start while they were busy: started once they are free. */
const again = new Set<string>();
let unsubscribe: (() => void) | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;

const SELECT = `SELECT t.*, r.id AS run_id, r.status AS run_status, r.started_at AS run_started_at,
    p.run_id AS paused_run_id, p.reason AS paused_reason,
    p.limit_name AS paused_limit, p.resume_at AS paused_resume_at, p.auto AS paused_auto, p.created_at AS paused_at, ${PAUSE_QUESTION_SQL},
    p.budget_scope AS paused_budget_scope, p.budget_usd AS paused_budget_usd,
    f.due_at AS followup_due_at, f.note AS followup_note, f.created_at AS followup_set_at
  FROM tasks t
  LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE conversation_id = t.conversation_id ORDER BY created_at DESC, rowid DESC LIMIT 1)
  LEFT JOIN paused_runs p ON p.conversation_id = t.conversation_id
  ${PAUSE_QUESTION_JOIN}
  LEFT JOIN followups f ON f.conversation_id = t.conversation_id`;

function toModel(r: TaskRow): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    number: r.number,
    title: r.title,
    description: r.description,
    type: r.type,
    status: r.status,
    position: r.position,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    runId: r.run_id ?? null,
    runStatus: r.run_status ?? null,
    pause:
      r.paused_run_id && r.paused_reason && r.paused_at
        ? toPause(
            {
              run_id: r.paused_run_id,
              reason: r.paused_reason,
              limit_name: r.paused_limit ?? null,
              resume_at: r.paused_resume_at ?? null,
              auto: r.paused_auto ?? 0,
              created_at: r.paused_at,
              budget_scope: r.paused_budget_scope ?? null,
              budget_usd: r.paused_budget_usd ?? null,
            },
            r,
          )
        : null,
    repoUrl: r.repo_url,
    repoPath: r.repo_path,
    baseBranch: r.base_branch,
    branch: r.branch,
    branchPushed: !!r.pushed_sha,
    worktree: r.branch ? checkoutDir(r.id) : null,
    pullRequest: r.pr_url ? { url: r.pr_url, number: r.pr_number, state: r.pr_state } : null,
    summary: r.summary,
    blockedReason: r.blocked_reason,
    activity: activity.get(r.id) ?? null,
    priority: r.priority ?? "none",
    dueDate: r.due_date ?? null,
    labels: parseJson<string[]>(r.labels, []),
    createdBy: r.created_by ?? "user",
    blockedKind: r.status === "blocked" ? (r.blocked_kind ?? null) : null,
    followup: r.followup_due_at ? { note: r.followup_note ?? "", dueAt: r.followup_due_at, createdAt: r.followup_set_at ?? r.followup_due_at } : null,
    costUsd: r.cost_usd ?? 0,
    workMs: r.work_ms ?? 0,
    runCount: r.run_count ?? 0,
    runStartedAt: r.run_started_at ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function row(id: string): TaskRow | null {
  return get<TaskRow>(`${SELECT} WHERE t.id = ?`, id);
}

function requireRow(id: string): TaskRow {
  const r = row(id);
  if (!r) throw notFound("Task");
  return r;
}

function emit(id: string) {
  const r = row(id);
  if (r) bus.emit({ type: "task.updated", task: toModel(r) });
}

function setActivity(id: string, label: string | null) {
  if (label) activity.set(id, label);
  else activity.delete(id);
  emit(id);
}

export function checkoutDir(taskId: string): string {
  return join(config().tasksDir, taskId);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** Tasks of a scope: "all" (default), "global" or a workspace id. The board's, or the archived ones (latest first). */
export function listTasks(opts: { workspaceId?: string; archived?: boolean } = {}): Task[] {
  const ws = opts.workspaceId ?? "all";
  const where = [opts.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL"];
  if (ws === "global") where.push("t.workspace_id IS NULL");
  else if (ws !== "all") where.push("t.workspace_id = ?");
  const order = opts.archived ? "ORDER BY t.archived_at DESC, t.number DESC" : "ORDER BY t.position ASC, t.number ASC";
  const params = ws === "all" || ws === "global" ? [] : [ws];
  return all<TaskRow>(`${SELECT} WHERE ${where.join(" AND ")} ${order}`, ...params).map(toModel);
}

export function getTask(id: string): Task {
  return toModel(requireRow(id));
}

export function taskForConversation(conversationId: string): Task | null {
  const r = get<TaskRow>(`${SELECT} WHERE t.conversation_id = ?`, conversationId);
  return r ? toModel(r) : null;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function cleanTitle(title: string | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) throw badRequest("Give the task a title");
  return t.slice(0, MAX_TASK_TITLE_LENGTH);
}

function cleanDescription(text: string | undefined): string {
  return (text ?? "").trim().slice(0, MAX_TASK_DESCRIPTION_LENGTH);
}

function cleanType(type: string | undefined): TaskType {
  if (type === undefined) return "general";
  if (!(TASK_TYPES as readonly string[]).includes(type)) throw badRequest(`Unknown task type "${type}"`);
  return type as TaskType;
}

function cleanStatus(status: string): TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) throw badRequest(`Unknown status "${status}"`);
  return status as TaskStatus;
}

function cleanRepoUrl(url: string | undefined): string {
  if (!url?.trim()) return "";
  const parsed = parseGitUrl(url);
  if ("error" in parsed) throw badRequest(parsed.error);
  return parsed.url;
}

/** Only the workspace's own folders that are git repositories: a task never makes worktrees of other folders. */
function cleanRepoPath(path: string | undefined, workspaceId: string | null): string {
  const p = (path ?? "").trim();
  if (!p) return "";
  const folder = workspaceId ? get<{ path: string }>("SELECT path FROM workspace_sources WHERE workspace_id = ? AND kind = 'folder' AND path = ?", workspaceId, p) : null;
  if (!folder) throw badRequest("Pick one of the workspace's folders as the task's repository.");
  if (!isRepoFolder(folder.path)) throw badRequest(`${folder.path} isn't a git repository.`);
  return folder.path;
}

function cleanBranch(branch: string | undefined): string {
  const b = (branch ?? "").trim();
  if (b && !isValidBranch(b)) throw badRequest(`"${b}" isn't a valid branch name`);
  return b;
}

function cleanPriority(p: string | undefined): TaskPriority {
  if (p === undefined) return "none";
  if (!(TASK_PRIORITIES as readonly string[]).includes(p)) throw badRequest(`Unknown priority "${p}"`);
  return p as TaskPriority;
}

/** A calendar day YYYY-MM-DD, or null. */
function cleanDueDate(d: string | null | undefined): string | null {
  const v = (d ?? "").trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const day = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !day || day.getUTCMonth() !== Number(m[2]) - 1 || day.getUTCDate() !== Number(m[3])) throw badRequest(`"${v}" isn't a date — use YYYY-MM-DD`);
  return v;
}

/** Cleaned, without repeats (the first spelling wins), at most MAX_TASK_LABELS. Saved secrets masked. */
function cleanLabels(list: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const label = cleanTaskLabel(redact(raw));
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  if (out.length > MAX_TASK_LABELS) throw badRequest(`A task can have up to ${MAX_TASK_LABELS} labels`);
  return out;
}

/** A task by its id, or by its number ("#12" or "12"). */
export function findTask(ref: string): Task {
  const r = ref.trim();
  const byNumber = /^#?(\d+)$/.exec(r);
  const found = byNumber ? get<TaskRow>(`${SELECT} WHERE t.number = ?`, Number(byNumber[1])) : row(r);
  if (!found) throw notFound("Task");
  return toModel(found);
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

interface EventRow {
  id: string;
  task_id: string;
  kind: TaskEventKind;
  actor: TaskActor;
  actor_name: string;
  body: string;
  data: string;
  run_id: string | null;
  created_at: string;
}

function toEvent(r: EventRow): TaskEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    actor: r.actor,
    actorName: r.actor_name,
    body: r.body,
    data: parseJson<Record<string, unknown>>(r.data, {}),
    runId: r.run_id,
    createdAt: r.created_at,
  } as TaskEvent;
}

function actorName(actor: TaskActor): string {
  if (!actor.startsWith("agent:")) return "";
  return get<{ name: string }>("SELECT name FROM agents WHERE id = ?", actor.slice(6))?.name ?? "";
}

function agentActor(agentId: string | null | undefined): TaskActor {
  return agentId ? `agent:${agentId}` : "system";
}

/**
 * Add a row to a ticket's timeline and tell the clients. Rows a run causes once (started, waiting, delivered, blocked)
 * are written once per run. Never throws: a timeline row must not break a move.
 */
function record<K extends TaskEventKind>(
  taskId: string,
  kind: K,
  actor: TaskActor,
  opts: { body?: string; data?: TaskEventData[K]; runId?: string | null } = {},
): TaskEvent | null {
  try {
    const r: EventRow = {
      id: newId("tev"),
      task_id: taskId,
      kind,
      actor,
      actor_name: actorName(actor),
      body: redact(opts.body ?? "").slice(0, SUMMARY_MAX),
      data: JSON.stringify(opts.data ?? {}),
      run_id: opts.runId ?? null,
      created_at: now(),
    };
    const changed = sql(
      "INSERT OR IGNORE INTO task_events (id, task_id, kind, actor, actor_name, body, data, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.id,
      r.task_id,
      r.kind,
      r.actor,
      r.actor_name,
      r.body,
      r.data,
      r.run_id,
      r.created_at,
    );
    if (!changed.changes) return null;
    const event = toEvent(r);
    bus.emit({ type: "task.event", event });
    return event;
  } catch (err) {
    log.warn(`task ${taskId}: could not record ${kind}`, err);
    return null;
  }
}

/** A ticket's timeline: the newest `limit` rows, oldest first. */
export function listTaskEvents(taskId: string, limit = 300): TaskEvent[] {
  requireRow(taskId);
  const n = Math.min(Math.max(1, Math.floor(limit)), 1000);
  return all<EventRow>(
    "SELECT * FROM (SELECT *, rowid AS rid FROM task_events WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC",
    taskId,
    n,
  ).map(toEvent);
}

/** Agents a task may be assigned to: its workspace's and global ones. */
function checkAgent(agentId: string | null | undefined, workspaceId: string | null): string | null {
  if (!agentId) return null;
  const agent = getAgent(agentId);
  if (agent.workspaceId && agent.workspaceId !== workspaceId) {
    throw badRequest(`${agent.name} belongs to another workspace — assign an agent of this workspace or a global one`);
  }
  return agent.id;
}

function checkWorkspace(id: string | null | undefined): string | null {
  if (!id) return null;
  if (!get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", id)) throw notFound("Workspace");
  return id;
}

/** Position for a task placed before `beforeId` in `status` (null = at the end of the column). */
function positionIn(workspaceId: string | null, status: TaskStatus, beforeId: string | null | undefined, selfId?: string): number {
  const siblings = all<{ id: string; position: number }>(
    "SELECT id, position FROM tasks WHERE workspace_id IS ? AND status = ? AND id IS NOT ? AND archived_at IS NULL ORDER BY position ASC, number ASC",
    workspaceId,
    status,
    selfId ?? null,
  );
  const idx = beforeId ? siblings.findIndex((s) => s.id === beforeId) : -1;
  if (idx < 0) return (siblings.at(-1)?.position ?? 0) + POSITION_STEP;
  const next = siblings[idx]!.position;
  const prev = idx > 0 ? siblings[idx - 1]!.position : next - 2 * POSITION_STEP;
  if (next - prev > 1e-6) return (prev + next) / 2;
  // Ran out of room between two neighbours: space the column out again.
  siblings.forEach((s, i) => sql("UPDATE tasks SET position = ? WHERE id = ?", (i + 1) * POSITION_STEP, s.id));
  bus.changed("tasks");
  return idx * POSITION_STEP + POSITION_STEP / 2;
}

function topPosition(workspaceId: string | null, status: TaskStatus, selfId: string): number {
  const top = get<{ p: number | null }>(
    "SELECT MIN(position) AS p FROM tasks WHERE workspace_id IS ? AND status = ? AND id != ? AND archived_at IS NULL",
    workspaceId,
    status,
    selfId,
  )?.p;
  return top == null ? POSITION_STEP : top - POSITION_STEP;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export function createTask(input: TaskInput, actor: TaskActor = "user"): Task {
  const workspaceId = checkWorkspace(input.workspaceId);
  const agentId = checkAgent(input.agentId, workspaceId);
  const status = input.status ? cleanStatus(input.status) : agentId ? "todo" : "backlog";
  const ts = now();
  const id = newId("tsk");
  // Never reused (a branch or pull request of a deleted task may still carry its number).
  const number = tx(() => {
    const n = Math.max(Number(getMeta("task_number")) || 0, get<{ n: number | null }>("SELECT MAX(number) AS n FROM tasks")?.n ?? 0) + 1;
    setMeta("task_number", String(n));
    return n;
  });
  const description = cleanDescription(input.description);
  insert("tasks", {
    id,
    workspace_id: workspaceId,
    number,
    title: cleanTitle(input.title),
    description,
    type: cleanType(input.type),
    status,
    position: positionIn(workspaceId, status, null),
    agent_id: agentId,
    repo_url: cleanRepoUrl(input.repoUrl),
    repo_path: cleanRepoPath(input.repoPath, workspaceId),
    base_branch: cleanBranch(input.baseBranch),
    priority: cleanPriority(input.priority),
    due_date: cleanDueDate(input.dueDate),
    labels: JSON.stringify(cleanLabels(input.labels)),
    created_by: actor,
    completed_at: status === "done" || status === "cancelled" ? ts : null,
    created_at: ts,
    updated_at: ts,
  });
  claimTaskAttachments(id, description);
  if (agentId) record(id, "assigned", actor, { data: { from: null, to: agentId, fromName: "", toName: actorName(`agent:${agentId}`) } });
  emit(id);
  if (agentId && (status === "todo" || status === "in_progress")) void dispatch(id);
  return getTask(id);
}

export function updateTask(id: string, patch: TaskPatch, actor: TaskActor = "user"): Task {
  const current = requireRow(id);
  const agentId = patch.agentId !== undefined ? checkAgent(patch.agentId, current.workspace_id) : current.agent_id;
  let status = patch.status !== undefined ? cleanStatus(patch.status) : current.status;
  // Nobody left to work on it: park it.
  if (!agentId && patch.status === undefined && status === "in_progress") status = "backlog";
  // Moving an archived task brings it back to the board; archiving a working one stops it and parks it.
  const archived = patch.archived ?? (!!current.archived_at && status === current.status);
  if (archived && status === "in_progress") status = "backlog";
  const restored = !!current.archived_at && !archived;
  const moved = status !== current.status || patch.beforeId !== undefined;
  const finished = status === "done" || status === "cancelled";
  const description = patch.description !== undefined ? cleanDescription(patch.description) : undefined;
  // Why it is blocked: set by the human when they move it to Blocked; only a reason they set can be changed later.
  const reassigned = agentId !== current.agent_id;
  let blockedReason: string | null | undefined;
  let blockedKind: TaskBlockedKind | null | undefined;
  if (patch.blockedReason !== undefined && status !== "blocked") throw badRequest("A reason only goes with Blocked");
  if (status !== current.status) {
    if (status === "blocked") {
      blockedReason = redact(patch.blockedReason ?? "").trim().slice(0, 2000) || null;
      blockedKind = "manual";
    } else {
      blockedReason = null;
      blockedKind = null;
    }
  } else if (status === "blocked") {
    if (patch.blockedReason !== undefined) {
      if (current.blocked_kind !== "manual") throw conflict("Only a reason you set yourself can be changed");
      blockedReason = redact(patch.blockedReason).trim().slice(0, 2000) || null;
    }
    // Another agent can't answer or continue what the previous one started: it starts again.
    if (reassigned && ["needs_input", "failed", "stopped", "interrupted"].includes(current.blocked_kind ?? "")) blockedKind = "manual";
  } else if (reassigned) {
    // The old agent's report is void.
    blockedReason = null;
  }
  update("tasks", id, {
    title: patch.title !== undefined ? cleanTitle(patch.title) : undefined,
    description,
    type: patch.type !== undefined ? cleanType(patch.type) : undefined,
    repo_url: patch.repoUrl !== undefined ? cleanRepoUrl(patch.repoUrl) : undefined,
    repo_path: patch.repoPath !== undefined ? cleanRepoPath(patch.repoPath, current.workspace_id) : undefined,
    base_branch: patch.baseBranch !== undefined ? cleanBranch(patch.baseBranch) : undefined,
    priority: patch.priority !== undefined ? cleanPriority(patch.priority) : undefined,
    due_date: patch.dueDate !== undefined ? cleanDueDate(patch.dueDate) : undefined,
    labels: patch.labels !== undefined ? JSON.stringify(cleanLabels(patch.labels)) : undefined,
    status,
    agent_id: agentId,
    position:
      restored && patch.beforeId === undefined
        ? topPosition(current.workspace_id, status, id)
        : moved
          ? positionIn(current.workspace_id, status, patch.beforeId, id)
          : undefined,
    completed_at: status === current.status ? undefined : finished ? now() : null,
    archived_at: archived === !!current.archived_at ? undefined : archived ? now() : null,
    blocked_reason: blockedReason,
    blocked_kind: blockedKind,
    updated_at: now(),
  });
  if (description !== undefined) claimTaskAttachments(id, description);

  const wasWorking = current.status === "in_progress";
  const starts =
    !archived &&
    !!agentId &&
    ((status !== current.status && (status === "todo" || (status === "in_progress" && !wasWorking))) ||
      ((status === "todo" || status === "in_progress") && (reassigned || restored)));
  // Start first: the restart owns the task before the old run's end is reported.
  if (starts) void dispatch(id, current.status === "blocked" ? { kind: current.blocked_kind, reason: current.blocked_reason } : undefined);
  if (wasWorking && (status !== "in_progress" || reassigned)) void stopWork(current, actor === "user");
  // A follow-up the agent scheduled would wake it up again (after dispatch, which already owns a task it restarts).
  if (current.conversation_id && ((archived && !current.archived_at) || (status !== current.status && status !== "in_progress") || reassigned)) {
    cancelFollowup(current.conversation_id);
  }

  if (status !== current.status) record(id, "status", actor, { body: status === "blocked" ? (blockedReason ?? "") : "", data: { from: current.status, to: status } });
  if (reassigned) {
    record(id, "assigned", actor, {
      data: { from: current.agent_id, to: agentId, fromName: actorName(agentActor(current.agent_id)), toName: actorName(agentActor(agentId)) },
    });
  }
  if (archived !== !!current.archived_at) record(id, "archived", actor, { data: { archived } });
  emit(id);
  return getTask(id);
}

/** Archive (or bring back) several tasks at once, e.g. a whole column. */
export function archiveTasks(ids: string[], archived: boolean, actor: TaskActor = "user"): Task[] {
  const unique = [...new Set(ids)];
  unique.forEach(requireRow);
  // Each restored task goes on top of its column: the last one first, so the column keeps its order.
  const updated = new Map((archived ? unique : [...unique].reverse()).map((id) => [id, updateTask(id, { archived }, actor)]));
  return unique.map((id) => updated.get(id)!);
}

/** The runs of the task's conversation that haven't ended: working, waiting, and the one that stands still (paused). */
function openRuns(conversationId: string | null): string[] {
  if (!conversationId) return [];
  const paused = pauseOf(conversationId)?.run_id;
  const active = listActiveRuns().filter((r) => r.conversationId === conversationId);
  // Waiting ones first: ending the run in front of them would start them.
  const waiting = active.filter((r) => r.status === "queued").map((r) => r.runId);
  const working = active.filter((r) => r.status === "running").map((r) => r.runId);
  return [...waiting, ...working, ...(paused ? [paused] : [])];
}

/** End them all; a paused run that stayed would continue later and pull the task back to work. */
async function stopRuns(runIds: string[], reason: string, byHuman = false) {
  for (const runId of runIds) {
    await cancelRun(runId, reason, { byHuman }).catch((err) => log.warn(`could not stop run ${runId}`, err));
    await waitForRun(runId, 15_000).catch(() => {});
  }
}

/** Cancel the run working on a task (the board moved it away from In progress). */
async function stopWork(task: TaskRow, byHuman = false) {
  // A restart that already owns the task shows its own progress.
  if (!busy.has(task.id)) activity.delete(task.id);
  await stopRuns(openRuns(task.conversation_id), "Stopped from the task board", byHuman);
}

export async function deleteTask(id: string): Promise<void> {
  const task = requireRow(id);
  sql("DELETE FROM tasks WHERE id = ?", id);
  // The agent would come back to a ticket that no longer exists. (After the delete: cancelling sweeps waiting tickets.)
  if (task.conversation_id) cancelFollowup(task.conversation_id);
  activity.delete(id);
  bus.emit({ type: "task.deleted", id });
  await stopRuns(openRuns(task.conversation_id), "The task was deleted");
  await removeCheckout(checkoutDir(id)).catch((err) => log.warn(`could not remove the worktree of task ${id}`, err));
  removeTaskAttachments(id);
}

/** Stop and clean up every task of a workspace that is being deleted (its rows go with the workspace). */
export async function removeWorkspaceTasks(workspaceId: string): Promise<void> {
  for (const t of all<TaskRow>("SELECT * FROM tasks WHERE workspace_id = ?", workspaceId)) {
    // Not delivered on the way out: cancelling a follow-up sweeps waiting tickets.
    busy.add(t.id);
    if (t.conversation_id) cancelFollowup(t.conversation_id);
    busy.delete(t.id);
    await stopWork(t);
    await removeCheckout(checkoutDir(t.id)).catch((err) => log.warn(`could not remove the worktree of task ${t.id}`, err));
    removeTaskAttachments(t.id);
  }
}

/** A follow-up from the human in the task's conversation (e.g. review feedback); the task goes back to work. */
export async function sendTaskMessage(
  id: string,
  content: string,
  attachments: TaskMessageInput["attachments"] = [],
  by: Answerer = { actor: "user", via: "task" },
  from: TaskActor = "user",
): Promise<Task> {
  const task = requireRow(id);
  if (!content.trim() && !attachments.length) throw badRequest("Message is empty");
  if (!task.conversation_id || !conversationExists(task.conversation_id)) throw conflict("The task hasn't started yet — move it to Todo to start it");
  const owner = get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", task.conversation_id)?.agent_id;
  if (!task.agent_id || owner !== task.agent_id) throw conflict("Move the task to Todo to hand it to its agent");
  if (busy.has(id)) throw conflict(`Godmode is ${activity.get(id)?.replace(/…$/, "").toLowerCase() ?? "preparing the task"} — send it again in a moment`);
  const human = getSettings().general.userName.trim() || "the human";
  if (from !== "user") {
    // Only the human continues a run that stands still (paused, waiting for the limit or for their answer).
    if (pauseOf(task.conversation_id)) throw conflict(`Task #${task.number} stands still — only ${human} can continue it`);
    const name = actorName(from) || "another agent";
    await sendMessage(task.conversation_id, { content: `[From ${name}, another agent — not from ${human}]\n\n${content}`, attachments, trigger: "task", source: "delegation" });
  } else {
    // A run that is asking right now stands still for it in a moment: then this message is the answer.
    await untilAsked(task.conversation_id);
    // The task's run waited for the human's answer: this message was it, and the run continues with it (the
    // timeline records the answer itself).
    if (answerByMessage(task.conversation_id, { content, attachments }, by)) return getTask(id);
    // A task that stands still takes the message along: it continues with it, or once Claude's limit has reset.
    if (pauseOf(task.conversation_id)) await submitMessage(task.conversation_id, { content, attachments });
    else await sendMessage(task.conversation_id, { content, attachments, trigger: "task" });
  }
  record(id, "feedback", from, { body: content, data: { on: task.status, files: attachments.map((a) => a.name) } });
  return getTask(id);
}

/** A progress note on a ticket (an agent at a milestone): on the timeline, nobody is notified. */
export function addTaskNote(taskId: string, text: string, actor: TaskActor, runId: string | null): TaskEvent {
  const task = requireRow(taskId);
  const note = text.trim();
  if (!note || note.length > MAX_TASK_NOTE_LENGTH) throw badRequest(`Write the note (up to ${MAX_TASK_NOTE_LENGTH} characters)`);
  if (runId && (get<{ n: number }>("SELECT COUNT(*) AS n FROM task_events WHERE kind = 'note' AND task_id = ? AND run_id = ?", taskId, runId)?.n ?? 0) >= 20) {
    throw conflict("That's enough notes for one run — put the rest in your summary.");
  }
  // A note a manager leaves from its own chat is about the ticket, not one of the ticket's runs.
  const own = runId && task.conversation_id && get("SELECT 1 FROM runs WHERE id = ? AND conversation_id = ?", runId, task.conversation_id) ? runId : null;
  const event = record(taskId, "note", actor, { body: note, runId: own });
  if (!event) throw new HttpError(500, "The note couldn't be saved");
  emit(taskId);
  return event;
}

/** The agent working on a task reports it can't finish (it moves to Blocked when its run ends). */
export function reportBlocked(conversationId: string, reason: string): Task {
  const task = get<TaskRow>("SELECT * FROM tasks WHERE conversation_id = ?", conversationId);
  if (!task) throw notFound("Task");
  sql("UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE id = ?", redact(reason.trim()).slice(0, 2000), now(), task.id);
  emit(task.id);
  return getTask(task.id);
}

/* ------------------------------------------------------------------ */
/* Starting work                                                       */
/* ------------------------------------------------------------------ */

/**
 * Move a task because of its work (not the human): only from `from` — a move the human made meanwhile wins. A task
 * that changes columns goes to the top, where the latest activity is. Returns whether it moved.
 */
function transition(id: string, status: TaskStatus, from: readonly TaskStatus[], blocked: { reason: string; kind: TaskBlockedKind } | null = null): boolean {
  const t = get<{ workspace_id: string | null; status: TaskStatus; position: number }>("SELECT workspace_id, status, position FROM tasks WHERE id = ?", id);
  if (!t || !from.includes(t.status)) return false;
  const position = t.status === status ? t.position : topPosition(t.workspace_id, status, id);
  sql(
    "UPDATE tasks SET status = ?, position = ?, blocked_reason = ?, blocked_kind = ?, updated_at = ? WHERE id = ?",
    status,
    position,
    blocked?.reason ?? null,
    blocked?.kind ?? null,
    now(),
    id,
  );
  return true;
}

/** Block a ticket because of its work, saying what kind of block it is (the board offers the matching way on). */
function block(id: string, reason: string, opts: { kind: TaskBlockedKind; from?: readonly TaskStatus[]; runId?: string | null; actor?: TaskActor }) {
  activity.delete(id);
  const text = redact(reason).slice(0, 2000);
  if (transition(id, "blocked", opts.from ?? WORKING, { reason: text, kind: opts.kind })) {
    record(id, "blocked", opts.actor ?? "system", { body: text, data: { kind: opts.kind }, runId: opts.runId ?? null });
    // The human stopped it: the agent mustn't come back on its own.
    if (opts.kind === "stopped" && opts.actor === "user") {
      const conv = get<{ conversation_id: string | null }>("SELECT conversation_id FROM tasks WHERE id = ?", id)?.conversation_id;
      if (conv) cancelFollowup(conv);
    }
  }
  emit(id);
}

/**
 * The repository a task works in: the one it names (a URL or one of the workspace's folders), else the workspace's
 * first git repository — a cloned URL or a folder that is a git repository. null = the task has none.
 */
function taskRepo(task: TaskRow): { repo: TaskRepo; branch: string } | { error: string } | null {
  const sources = task.workspace_id
    ? all<{ kind: "folder" | "git"; path: string; url: string | null; branch: string | null }>(
        "SELECT kind, path, url, branch FROM workspace_sources WHERE workspace_id = ? ORDER BY position, created_at",
        task.workspace_id,
      )
    : [];
  // Checked again on every start: only a folder the workspace still has, and still may be worked in.
  const usable = (path: string) => sources.some((s) => s.kind === "folder" && s.path === path) && !workingDirectoryProblem(path) && isRepoFolder(path);
  if (task.repo_path) {
    if (!usable(task.repo_path)) return { error: `The task's repository ${task.repo_path} isn't one of the workspace's git repository folders anymore.` };
    return { repo: { kind: "local", path: task.repo_path }, branch: "" };
  }
  if (task.repo_url) return { repo: { kind: "remote", url: task.repo_url }, branch: "" };
  for (const s of sources) {
    if (s.kind === "git" && s.url) return { repo: { kind: "remote", url: s.url }, branch: s.branch ?? "" };
    if (s.kind === "folder" && usable(s.path)) return { repo: { kind: "local", path: s.path }, branch: "" };
  }
  return null;
}

function branchName(task: TaskRow): string {
  const slug = slugify(task.title).slice(0, 40).replace(/-+$/, "") || "task";
  return `godmode/${task.number}-${slug}`;
}

interface Worktree {
  /** The repository: its URL, or the human's folder it comes from. */
  repo: string;
  base: string;
  branch: string;
}

const TYPE_BRIEF: Record<TaskType, string> = {
  general: "Do the task and finish with a short summary of what you did and anything the human should check.",
  research:
    "Research this thoroughly and answer with a well-structured report in Markdown: the key findings first, then details, sources (with links) and a recommendation where it helps.",
  coding: [
    "Implement the change, keep to the project's conventions, run its tests and linters when it has them, and commit your work with clear commit messages.",
    "Don't push and don't open a pull request: Godmode pushes the branch and opens the pull request when you finish.",
    "End with a summary of the changes — it becomes the pull request description.",
  ].join("\n"),
};

function worktreeBrief(task: TaskRow, w: Worktree): string {
  return [
    `You work in your own git worktree of ${w.repo} (your current directory), on the branch \`${w.branch}\` created from \`${w.base}\`. Other tasks and the human's own copy of the repository have their own files, so nothing you do here gets in their way.`,
    "Make every change here — not in other copies of the repository you may see. It's a fresh checkout: install dependencies first if you need to build or run something.",
    "The repository's stash, branches and settings are shared with other tasks (and the human's copy): don't use `git stash` (commit work in progress instead), don't switch or delete other branches, and don't change the git config.",
    `Keep secrets out of the branch: never write passwords, API keys or tokens into files or commit messages — read them from the environment — and don't commit \`.env\` or key files. Before the branch is pushed, Godmode leaves such files out and replaces saved secrets with ${SECRET_PLACEHOLDER}.`,
    ...(task.type === "coding" ? [] : ["When you finish, Godmode commits what you changed here on this branch (it isn't pushed)."]),
  ].join("\n");
}

function attachmentsBrief(staged: StagedAttachments): string[] {
  const lines: string[] = [];
  if (staged.files.length) {
    lines.push(
      "The description links files the human attached (listed with their paths at the end). Open every one with the Read tool before you start — it shows images and reads PDFs — and treat what they show as part of the task.",
    );
  }
  if (staged.missing.length) lines.push(`These attached files couldn't be found anymore: ${staged.missing.join(", ")}.`);
  return lines;
}

/** `description`: the task's, or with its attachments pointing at their local copies (what Claude gets). */
/** "Friday, October 9, 2026 (in 5 days)" — what the agent is told about a due day. */
function dueText(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 ? `in ${days} days` : `${-days} day${days === -1 ? "" : "s"} ago — overdue`;
  return `${due.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} (${when})`;
}

function firstLine(task: TaskRow, restarted: boolean, resume?: Resume): string {
  if (!restarted) return `You were assigned task #${task.number} on the task board.`;
  if (resume?.kind === "interrupted") {
    return `Godmode restarted while you were working on task #${task.number}. Pick the work up where you stopped — check what is already done before you repeat a step. Here is the task again (it may have changed):`;
  }
  if (resume?.kind === "failed") {
    const why = (resume.reason ?? "it failed").replace(/\s+/g, " ").trim().slice(0, 300);
    return `Your last run on task #${task.number} failed: ${why}. Try again — check what is already done before you repeat a step. Here is the task again (it may have changed):`;
  }
  return `The task #${task.number} was restarted from the board — here it is again (it may have changed):`;
}

function taskPrompt(task: TaskRow, worktree: Worktree | null, restarted: boolean, description: string, staged: StagedAttachments, resume?: Resume): string {
  const labels = parseJson<string[]>(task.labels, []);
  const lines = [
    firstLine(task, restarted, resume),
    "",
    `# ${task.title}`,
    "",
    description.trim() || "_No description._",
    "",
    "---",
    ...(task.priority && task.priority !== "none" ? [`Priority: ${task.priority}.`] : []),
    ...(task.due_date ? [`Due: ${dueText(task.due_date)}. If you can't make it, say so in your summary instead of cutting corners.`] : []),
    ...(labels.length ? [`Labels: ${labels.join(", ")}.`] : []),
    ...attachmentsBrief(staged),
    ...(worktree ? [worktreeBrief(task, worktree)] : []),
    TYPE_BRIEF[task.type],
    "If you need a decision or an OK to go on, ask with `ask_human` or `request_approval` — the task waits and continues with the answer. If you can't finish at all because something is missing (access, an account, information nobody can give you now), call `task_report_blocked` with what you need, then stop.",
    "On long work, leave a short progress note with the `task_note` tool at milestones — the human reads it on the task. If you have to wait for something (a reply, a build, office hours), schedule a follow-up: the task shows when you continue, and it goes to review once you finish.",
  ];
  return lines.join("\n");
}

/** Start (or restart) the agent on a task in Todo / In progress. Never throws; problems block the task. */
/** Why a ticket that is started again was blocked: the agent's opening line says so. */
interface Resume {
  kind: TaskBlockedKind | null;
  reason: string | null;
}

export async function dispatch(id: string, resume?: Resume): Promise<void> {
  if (busy.has(id)) {
    again.add(id);
    return;
  }
  busy.add(id);
  try {
    let task = row(id);
    if (!task || task.archived_at || !task.agent_id || !STARTABLE.includes(task.status)) return;
    let agent: Agent;
    try {
      agent = getAgent(task.agent_id);
    } catch {
      return block(id, "The assigned agent doesn't exist anymore.", { kind: "setup", from: STARTABLE });
    }
    if (!agent.enabled) return block(id, `${agent.name} is disabled — turn it on or assign another agent.`, { kind: "setup", from: STARTABLE });

    const previous = openRuns(task.conversation_id);
    if (previous.length) await stopRuns(previous, "Restarted from the task board");
    // Archived while the previous run was stopping.
    if (row(id)?.archived_at || !transition(id, "in_progress", STARTABLE)) return;
    sql("UPDATE tasks SET started_at = ?, completed_at = NULL WHERE id = ?", now(), id);

    // Its own git worktree on its own branch: tasks working side by side never touch each other's files.
    let worktree: Worktree | null = null;
    let workDir: string | null = null;
    const source = taskRepo(task);
    if (!source && task.type === "coding") return block(id, "Coding tasks need a git repository — add one to the workspace (or the task).", { kind: "setup", from: STARTABLE });
    if (source) {
      workDir = checkoutDir(id);
      try {
        if ("error" in source) throw new Error(source.error);
        setActivity(id, task.branch ? "Updating the worktree…" : needsClone(source.repo) ? "Cloning the repository…" : "Creating the worktree…");
        const prepared = await prepareWorktree({
          dir: workDir,
          repo: source.repo,
          base: task.base_branch || source.branch,
          branch: task.branch ?? branchName(task),
          fresh: !task.branch,
          trashDir: join(reposDir(), ".trash"),
        });
        const repoPath = source.repo.kind === "local" ? source.repo.path : "";
        sql("UPDATE tasks SET repo_url = ?, repo_path = ?, base_branch = ?, branch = ? WHERE id = ?", prepared.url, repoPath, prepared.base, prepared.branch, id);
        worktree = { repo: repoPath || prepared.url, base: prepared.base, branch: prepared.branch };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (task.type === "coding") return block(id, `Couldn't create the task's worktree: ${message}`, { kind: "setup" });
        // Other tasks can do without one: they work next to the workspace's folders, as chats do.
        log.warn(`task ${id} runs without a worktree: ${message}`);
        notify("warning", `Task #${task.number} works without its own worktree`, `Couldn't create it: ${message}`, `/tasks?task=${id}`);
        workDir = task.branch && existsSync(checkoutDir(id)) ? checkoutDir(id) : null;
      }
    }

    task = row(id);
    if (!task) {
      // Deleted while the worktree was being created.
      if (workDir) await removeCheckout(workDir).catch(() => {});
      return;
    }
    // Moved away (or reassigned) while the worktree was being created; a restart asked for meanwhile follows.
    if (task.status !== "in_progress" || task.agent_id !== agent.id) return setActivity(id, null);

    let conversationId = task.conversation_id;
    const reusable =
      conversationId &&
      get<{ agent_id: string; working_directory: string | null }>("SELECT agent_id, working_directory FROM conversations WHERE id = ?", conversationId);
    const restarted = !!reusable && reusable.agent_id === agent.id && (reusable.working_directory ?? null) === workDir;
    if (!restarted) {
      conversationId = createConversation({
        agentId: agent.id,
        title: `#${task.number} ${task.title}`,
        origin: "task",
        workingDirectory: workDir,
      }).id;
      sql("UPDATE conversations SET archived = 1 WHERE id = ?", conversationId);
      sql("UPDATE tasks SET conversation_id = ? WHERE id = ?", conversationId, id);
    }
    // The conversation shows the files attached to the message; Claude gets the description with their local copies.
    const staged = stageTaskAttachments(agent, task.number, task.description);
    activity.delete(id);
    await sendMessage(conversationId!, {
      content: taskPrompt(task, worktree, restarted, withFileNames(task.description), staged, resume),
      prompt: taskPrompt(task, worktree, restarted, withLocalPaths(task.description, staged.paths), staged, resume),
      files: staged.files,
      trigger: "task",
      source: "task",
    });
    emit(id);
  } catch (err) {
    log.warn(`task ${id} could not start`, err);
    block(id, err instanceof Error ? err.message : String(err), { kind: "setup", from: STARTABLE });
  } finally {
    release(id);
  }
}

/** The task is free again: start it if the board asked meanwhile, else handle a run that ended while it was busy. */
function release(id: string) {
  busy.delete(id);
  if (again.delete(id)) void dispatch(id);
  else void settle(id).catch((err) => log.warn(`task ${id}: could not settle`, err));
}

async function settle(id: string): Promise<void> {
  const t = row(id);
  if (!t || t.status !== "in_progress" || !t.conversation_id || !t.run_id || busy.has(id)) return;
  if (activeRunForConversation(t.conversation_id)) return;
  const latest = getRun(t.run_id);
  if (TERMINAL.has(latest.status)) await finished(id, latest);
}

/* ------------------------------------------------------------------ */
/* When a run ends                                                     */
/* ------------------------------------------------------------------ */

function latestRunId(conversationId: string): string | null {
  return get<{ id: string }>("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", conversationId)?.id ?? null;
}

/** What a ticket's chat last showed of its pause and follow-up: a change is worth telling the board about. */
const chatState = new Map<string, string>();

function onBusEvent(event: ServerEvent) {
  if (event.type === "entity.changed" && event.entity === "followups") return sweepWaiting();
  // The pause or the follow-up of a ticket's chat changed (whether it continues by itself, when it continues).
  if (event.type === "conversation.updated") {
    const id = get<{ id: string }>("SELECT id FROM tasks WHERE conversation_id = ?", event.conversation.id)?.id;
    if (!id) return;
    const c = event.conversation;
    const state = `${c.paused?.runId ?? ""}|${c.paused?.auto ?? ""}|${c.followup?.dueAt ?? ""}`;
    if (chatState.get(id) !== state) {
      chatState.set(id, state);
      emit(id);
    }
    return;
  }
  // The ticket's chat is gone: the agent can't continue a ticket that waited.
  if (event.type === "conversation.deleted") {
    const t = get<TaskRow>("SELECT * FROM tasks WHERE conversation_id = ?", event.id);
    if (t && t.status === "in_progress" && !busy.has(t.id) && !openRuns(event.id).length) {
      block(t.id, "The task's chat was deleted, so the agent can't continue it. Start it again to work in a new chat.", { kind: "stopped", actor: "user" });
    }
    return;
  }
  // Its agent was deleted: a ticket that waited for it is parked, as when the human takes the agent off.
  if (event.type === "agent.deleted") {
    for (const t of all<TaskRow>("SELECT * FROM tasks WHERE status = 'in_progress' AND agent_id IS NULL")) {
      if (busy.has(t.id) || openRuns(t.conversation_id).length) continue;
      if (transition(t.id, "backlog", ["in_progress"])) record(t.id, "status", "system", { data: { from: "in_progress", to: "backlog" } });
      emit(t.id);
    }
    return;
  }
  // What the agent asked the human on a ticket, and the answer.
  if (event.type === "question.created" || event.type === "question.updated") {
    const q = event.question;
    if (!q.taskId || !get<{ id: string }>("SELECT id FROM tasks WHERE id = ?", q.taskId)) return;
    if (event.type === "question.created") {
      record(q.taskId, "asked", `agent:${q.agentId}`, { body: q.title, data: { questionId: q.id, kind: q.kind } });
    } else if (q.answer) {
      const said = q.status === "approved" ? "Approved" : q.status === "declined" ? "Declined" : "";
      record(q.taskId, "answered", "user", { body: [said, q.answer.text].filter(Boolean).join(" — "), data: { questionId: q.id, status: q.status } });
    }
    return;
  }
  if (event.type !== "run.started" && event.type !== "run.finished" && event.type !== "run.paused") return;
  const task = get<TaskRow>("SELECT * FROM tasks WHERE conversation_id = ?", event.run.conversationId);
  if (!task) return;
  // A paused run has not ended: the task stays where it is and shows that its work stands still.
  if (event.type !== "run.finished") {
    if (event.type === "run.started" && event.run.status === "queued") {
      const before = task.status;
      if (!busy.has(task.id)) backToWork(task.id);
      // A new run (a run that continues after a pause started before). One the human's message from the sheet
      // started is on the timeline as that message already.
      if (!event.run.startedAt) {
        if (event.run.trigger === "chat") {
          // Written in the ticket's chat: on the timeline like a message from the sheet.
          record(task.id, "feedback", "user", { body: event.run.prompt, data: { on: before, files: [] } });
        } else if (busy.has(task.id) || event.run.trigger !== "task") {
          const again = !!get<{ id: string }>("SELECT id FROM task_events WHERE task_id = ? AND kind = 'started' LIMIT 1", task.id);
          record(task.id, "started", agentActor(event.run.agentId), { runId: event.run.id, data: { trigger: event.run.trigger, again } });
        }
      }
    }
    emit(task.id);
    return;
  }
  account(task.id, event.run);
  void finished(task.id, event.run).catch((err) => log.warn(`task ${task.id}: could not handle the end of run ${event.run.id}`, err));
}

/** What a run that ended cost and how long the agent worked on it, with the work it delegated. */
function account(taskId: string, run: Run) {
  try {
    const cost =
      get<{ c: number | null }>(
        `WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT r.id FROM runs r JOIN d ON r.parent_run_id = d.id)
         SELECT SUM(cost_usd) AS c FROM runs WHERE id IN (SELECT id FROM d)`,
        run.id,
      )?.c ?? 0;
    sql("UPDATE tasks SET cost_usd = cost_usd + ?, work_ms = work_ms + ?, run_count = run_count + 1 WHERE id = ?", cost, run.durationMs ?? 0, taskId);
  } catch (err) {
    log.warn(`task ${taskId}: could not add up run ${run.id}`, err);
  }
}

/** A follow-up (review feedback, a question) puts a delivered or blocked task back to work — and on the board. */
function backToWork(id: string) {
  if (transition(id, "in_progress", ["in_review", "blocked", "done", "cancelled", "backlog"])) sql("UPDATE tasks SET completed_at = NULL, archived_at = NULL WHERE id = ?", id);
}

async function finished(id: string, run: Run): Promise<void> {
  const task = row(id);
  if (!task) return;
  // Starting or publishing: handled once the task is free (settle).
  if (busy.has(id)) return;
  // Another turn is already queued in the conversation, or the board moved the task away meanwhile.
  if (latestRunId(run.conversationId) !== run.id || task.status !== "in_progress") return emit(id);
  const link = `/tasks?task=${id}`;
  const agent = agentActor(run.agentId);
  if (run.status === "cancelled") return block(id, "Stopped before it finished.", { kind: "stopped", runId: run.id, actor: "user" });
  if (run.status === "failed") {
    block(id, run.error || "The run failed.", { kind: run.error === INTERRUPTED ? "interrupted" : "failed", runId: run.id });
    notify("error", `Task #${task.number} is blocked`, run.error ?? "", link);
    return;
  }
  const summary = run.result ? run.result.slice(0, SUMMARY_MAX) : null;
  // Earlier results stay on the timeline with their pictures: only a deleted task takes its pictures along.
  const shown = summary && withResultImages(id, summary, resultFolders(task, run.conversationId));
  sql("UPDATE tasks SET summary = ? WHERE id = ?", shown, id);
  if (task.blocked_reason) {
    block(id, task.blocked_reason, { kind: "needs_input", runId: run.id, actor: agent });
    notify("warning", `Task #${task.number} needs you`, task.blocked_reason, link);
    return;
  }
  // The agent set itself a time to continue: the ticket waits (In progress, nothing running) instead of going to
  // review. What it did so far is kept on its branch (and pushed, for coding tickets) so nothing is out of reach.
  let followup = getFollowup(run.conversationId);
  // A follow-up an earlier run set (before the human answered) is stale once this run finished the work.
  const setBy = followup ? get<{ run_id: string | null }>("SELECT run_id FROM followups WHERE conversation_id = ?", run.conversationId)?.run_id : null;
  if (followup && setBy && setBy !== run.id) {
    cancelFollowup(run.conversationId);
    followup = null;
  }
  if (followup) {
    if (task.branch) {
      busy.add(id);
      try {
        if (task.type === "coding" && task.repo_url) await pushWork(requireRow(id)).catch((err) => log.warn(`task ${id}: could not push while it waits`, err));
        else await commitLeftovers(requireRow(id)).catch((err) => log.warn(`task ${id}: could not commit while it waits`, err));
      } finally {
        activity.delete(id);
        busy.delete(id);
      }
    }
    record(id, "waiting", agent, { body: shown ?? "", runId: run.id, data: { dueAt: followup.dueAt, note: followup.note } });
    activity.delete(id);
    emit(id);
    // A turn that started while it was committing is handled when it ends.
    if (again.delete(id)) void dispatch(id);
    return;
  }
  if (task.branch) {
    busy.add(id);
    try {
      if (task.type === "coding") await publish(requireRow(id), summary, run.id);
      else await keepWork(requireRow(id), run.id);
    } finally {
      release(id);
    }
    return;
  }
  if (deliver(id, run.id)) notify("success", `Task #${task.number} is ready for review`, task.title, link);
}

/**
 * Tickets that waited for a follow-up that is gone: the human cancelled it (the ticket goes to review with what the
 * agent delivered so far, without a notification — they did it themselves) or it couldn't start because the agent is
 * switched off or gone (the ticket is blocked, saying so).
 */
function sweepWaiting() {
  const waiting = all<TaskRow>(
    `SELECT * FROM tasks WHERE status = 'in_progress' AND archived_at IS NULL AND conversation_id IS NOT NULL
       AND conversation_id NOT IN (SELECT conversation_id FROM followups)`,
  );
  for (const t of waiting) {
    if (busy.has(t.id) || openRuns(t.conversation_id).length) continue;
    // Only a ticket whose latest run ended waiting (notes and other rows on the timeline don't change that).
    const runId = latestRunId(t.conversation_id!);
    if (!runId || !get("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'waiting' AND run_id = ?", t.id, runId)) continue;
    let usable: Agent | null = null;
    try {
      usable = t.agent_id ? getAgent(t.agent_id) : null;
    } catch {
      usable = null;
    }
    if (!usable || !usable.enabled) {
      block(t.id, usable ? `${usable.name} is disabled, so it couldn't continue — turn it on or assign another agent.` : "Its agent is gone, so nobody continues it.", {
        kind: "setup",
      });
      continue;
    }
    // Delivered the way a run's end delivers: a coding ticket pushes and opens its pull request, a pushed branch updates.
    void deliverWaiting(t.id, runId).catch((err) => log.warn(`task ${t.id}: could not deliver after its follow-up was cancelled`, err));
  }
}

async function deliverWaiting(id: string, runId: string): Promise<void> {
  const task = requireRow(id);
  if (!task.branch) {
    deliver(id, runId);
    return;
  }
  busy.add(id);
  try {
    if (task.type === "coding") await publish(task, task.summary, runId);
    else await keepWork(task, runId);
  } finally {
    release(id);
  }
}

/** Where the agent keeps the screenshots its result names: the folders it works in, and the temp folders. */
function resultFolders(task: TaskRow, conversationId: string): string[] {
  let agent: Agent | null = null;
  try {
    agent = task.agent_id ? getAgent(task.agent_id) : null;
  } catch {
    /* deleted meanwhile */
  }
  const folder = get<{ working_directory: string | null }>("SELECT working_directory FROM conversations WHERE id = ?", conversationId)?.working_directory;
  const workspaceId = task.workspace_id ?? agent?.workspaceId;
  return [
    ...(agent ? [agent.repoPath] : []),
    ...[folder ?? agent?.workingDirectory].filter((f): f is string => !!f),
    ...(workspaceId ? listSources(workspaceId).map((s) => s.path) : []),
    tmpdir(),
    ...(process.platform === "win32" ? [] : ["/tmp"]),
  ];
}

/** A general or research task: what it changed in its worktree is committed on its branch (pushed only when asked to). */
async function keepWork(task: TaskRow, runId: string): Promise<void> {
  const link = `/tasks?task=${task.id}`;
  try {
    // Pushed from the board before: follow-ups keep the branch (and its pull request) up to date.
    if (task.pushed_sha && task.repo_url) await pushWork(task);
    else await commitLeftovers(task);
  } catch (err) {
    log.warn(`task ${task.id}: could not commit or push its changes`, err);
    if (task.pushed_sha) notify("warning", `Task #${task.number}: ${task.branch} wasn't pushed`, redact(err instanceof Error ? err.message : String(err)), link);
  }
  if (deliver(task.id, runId)) notify("success", `Task #${task.number} is ready for review`, task.title, link);
}

/** The subject of the commits Godmode makes for a task — never with a secret, also when redaction is off. */
function commitSubject(task: TaskRow): string {
  return `${withoutSecrets(redact(task.title))} (#${task.number})`;
}

/** Commit what was left uncommitted in the task's worktree, except new files that look like secrets. */
async function commitLeftovers(task: TaskRow): Promise<void> {
  const { skipped } = await commitWork({ dir: checkoutDir(task.id), message: commitSubject(task) });
  if (skipped.length) notify("warning", `Task #${task.number}: files left out`, `Not committed because they look like secrets: ${skipped.join(", ")}`, `/tasks?task=${task.id}`);
}

/** In review — unless a newer turn (a follow-up) started meanwhile; its end decides then. */
function deliver(id: string, runId: string): boolean {
  activity.delete(id);
  const t = get<{ conversation_id: string | null; summary: string | null; pr_number: number | null; agent_id: string | null }>(
    "SELECT conversation_id, summary, pr_number, agent_id FROM tasks WHERE id = ?",
    id,
  );
  const moved = !!t?.conversation_id && latestRunId(t.conversation_id) === runId && transition(id, "in_review", WORKING);
  if (moved && t) {
    const run = get<{ cost_usd: number | null; duration_ms: number | null; agent_id: string }>("SELECT cost_usd, duration_ms, agent_id FROM runs WHERE id = ?", runId);
    record(id, "delivered", agentActor(run?.agent_id ?? t.agent_id), {
      body: t.summary ?? "",
      runId,
      data: { costUsd: run?.cost_usd ?? null, durationMs: run?.duration_ms ?? null, pullRequest: t.pr_number },
    });
  }
  emit(id);
  return moved;
}

function prBody(task: TaskRow, summary: string | null): string {
  const agent = task.agent_id ? get<{ name: string }>("SELECT name FROM agents WHERE id = ?", task.agent_id)?.name : null;
  return [
    summary?.trim() || task.description.trim() || task.title,
    "",
    "---",
    `Task #${task.number}${agent ? ` · done by ${agent}` : ""} with [Godmode Bot](https://github.com/codextde/godmode-bot)`,
  ].join("\n");
}

/**
 * Commit and push the task's branch. Secrets never go along and never stop the push: new env/key files are left out
 * of the commit, and what the agent committed itself is taken out first (see removeSecrets) — the human is told what
 * Godmode changed. `false` when the branch has no commits on top of its base, or a turn that started meanwhile
 * committed (its end pushes the branch).
 */
async function pushWork(task: TaskRow): Promise<boolean> {
  const dir = checkoutDir(task.id);
  await commitLeftovers(task);
  const { head, removed } = await removeSecrets({ dir, base: task.base_branch, lastPushed: task.pushed_sha, message: commitSubject(task), clean: withoutSecrets });
  if (!head) return false;
  if (removed) {
    const { left, replaced, kept } = removed;
    const body = [
      left.length ? `Left out of the push because they look like secrets or hold one (they stay in the worktree): ${left.join(", ")}.` : "",
      replaced.length ? `A saved secret was replaced with ${SECRET_PLACEHOLDER} in ${replaced.join(", ")} — make the code read it from the environment.` : "",
      `The commits that weren't pushed yet were rewritten without the secrets; the branch as the agent left it stays in ${dir} as ${kept}.`,
    ];
    notify("warning", `Task #${task.number}: secrets kept out of ${task.branch}`, withoutSecrets(body.filter(Boolean).join(" ")), `/tasks?task=${task.id}`);
  }
  const { pushed, sha } = await pushBranch({ dir, base: task.base_branch, branch: task.branch!, lastPushed: task.pushed_sha, head });
  if (pushed) sql("UPDATE tasks SET pushed_sha = ? WHERE id = ?", sha, task.id);
  return pushed;
}

/** Open the pull request of the pushed branch, or — when that can't be done here — link to the page that opens one. */
async function openTaskPullRequest(task: TaskRow, summary: string | null) {
  setActivity(task.id, "Opening the pull request…");
  const result = await openPullRequest({
    dir: checkoutDir(task.id),
    url: task.repo_url,
    base: task.base_branch,
    branch: task.branch!,
    // Never a secret, also when redaction is off: the summary may quote what the agent wrote into a file.
    title: withoutSecrets(redact(task.title)),
    body: withoutSecrets(redact(prBody(task, summary))),
  });
  const pr = result.pullRequest;
  if (pr) sql("UPDATE tasks SET pr_url = ?, pr_number = ?, pr_state = ? WHERE id = ?", pr.url, pr.number, pr.state, task.id);
  return result;
}

/** Push a coding task's branch when its agent finished and open its pull request (once; later pushes update it). */
async function publish(task: TaskRow, summary: string | null, runId: string): Promise<void> {
  const id = task.id;
  const link = `/tasks?task=${id}`;
  const title = redact(task.title);
  try {
    if (!task.repo_url) {
      setActivity(id, "Committing the changes…");
      await commitLeftovers(task);
      // A local repository without a remote: the work stays on the task's branch there.
      const changed = (await commitsAhead(checkoutDir(id), task.base_branch)) > 0;
      if (!deliver(id, runId)) return;
      if (changed) notify("success", `Task #${task.number}: the changes are on ${task.branch}`, `${task.repo_path} has no remote Godmode can push to — merge the branch there.`, link);
      else notify("info", `Task #${task.number}: no code changes`, "The agent finished without changing the code.", link);
      return;
    }
    setActivity(id, "Pushing the branch…");
    if (!(await pushWork(task))) {
      if (deliver(id, runId)) notify("info", `Task #${task.number}: no code changes`, "The agent finished without changing the code.", link);
      return;
    }
    if (task.pr_url && task.pr_number && task.pr_state === "open") {
      if (deliver(id, runId)) notify("success", `Task #${task.number}: pull request updated`, title, link);
      return;
    }
    const { pullRequest, problem } = await openTaskPullRequest(task, summary);
    const opened = requireRow(id);
    if (opened.pr_url && (opened.pr_url !== task.pr_url || opened.pr_number !== task.pr_number)) record(id, "pr_opened", "system", { data: { number: opened.pr_number, url: opened.pr_url } });
    if (!deliver(id, runId)) return;
    if (pullRequest?.number) notify("success", `Task #${task.number}: pull request #${pullRequest.number} is open`, title, link);
    else notify("warning", `Task #${task.number}: open the pull request`, `The branch ${task.branch} was pushed. ${problem ?? ""}`.trim(), link);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    block(id, `Couldn't push the branch: ${message}`, { kind: "publish", runId });
    notify("error", `Task #${task.number} is blocked`, message, link);
  }
}

/**
 * Push the task's branch from the board (general and research tasks never push theirs by themselves) and, with
 * `pullRequest`, open its pull request. What's left uncommitted in the worktree is committed first.
 */
export async function pushTaskBranch(id: string, opts: { pullRequest: boolean }): Promise<Task> {
  const task = requireRow(id);
  if (!task.branch) throw conflict("The task has no branch yet — start it first");
  if (!existsSync(checkoutDir(id))) throw conflict("The task's worktree is gone — move the task to Todo to set it up again");
  if (!task.repo_url) throw conflict(`${task.repo_path || "The repository"} has no remote Godmode can push to — merge ${task.branch} there.`);
  if (busy.has(id)) throw conflict(`Godmode is ${activity.get(id)?.replace(/…$/, "").toLowerCase() ?? "preparing the task"} — try again in a moment`);
  // A ticket that waits for its follow-up can be pushed; one whose run works or stands still can't.
  const waiting = task.status === "in_progress" && !!task.conversation_id && !!getFollowup(task.conversation_id);
  if (openRuns(task.conversation_id).length || (task.status === "in_progress" && !waiting)) {
    throw conflict("The task is in progress — push it once the agent is done");
  }
  const lastRun = task.conversation_id ? latestRunId(task.conversation_id) : null;
  busy.add(id);
  try {
    setActivity(id, "Pushing the branch…");
    if (!(await pushWork(task))) throw conflict(`${task.branch} has no changes on top of ${task.base_branch} yet.`);
    const current = requireRow(id);
    if (opts.pullRequest && !(current.pr_number && current.pr_state === "open")) {
      const { pullRequest, problem } = await openTaskPullRequest(current, current.summary && withFileNames(current.summary));
      if (!pullRequest) throw conflict(`${task.branch} was pushed. ${problem ?? ""}`.trim());
      const opened = requireRow(id);
      record(id, "pr_opened", "user", { data: { number: opened.pr_number, url: opened.pr_url ?? pullRequest.url } });
      // Handed over for review: a task blocked on its push is unblocked, and moves to Done when it's merged.
      if (transition(id, "in_review", ["blocked"]) && lastRun) {
        record(id, "delivered", agentActor(current.agent_id), { body: current.summary ?? "", runId: lastRun, data: { costUsd: null, durationMs: null, pullRequest: opened.pr_number } });
      }
    } else if (current.status === "blocked" && current.blocked_kind === "publish" && transition(id, "in_review", ["blocked"]) && lastRun) {
      // Publishing failed before and works now: delivered.
      record(id, "delivered", agentActor(current.agent_id), { body: current.summary ?? "", runId: lastRun, data: { costUsd: null, durationMs: null, pullRequest: current.pr_number } });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, redact(`Couldn't push ${task.branch}: ${err instanceof Error ? err.message : String(err)}`), "push_failed");
  } finally {
    activity.delete(id);
    // A turn started from the chat meanwhile: the task goes back to work as it would have, and its end is handled once released.
    if (task.conversation_id && latestRunId(task.conversation_id) !== lastRun) backToWork(id);
    emit(id);
    release(id);
  }
  return getTask(id);
}

/** Move tasks whose pull request was merged to Done (and note closed ones). */
export async function checkPullRequests(): Promise<void> {
  // Approved tickets too: their pull request may be merged after the human marked them done.
  const open = all<TaskRow>("SELECT * FROM tasks WHERE status IN ('in_review', 'done') AND pr_number IS NOT NULL AND pr_state = 'open' AND pr_url IS NOT NULL");
  for (const task of open) {
    const state = await pullRequestState(checkoutDir(task.id), task.pr_url!).catch(() => null);
    if (!state || state === "open") continue;
    sql("UPDATE tasks SET pr_state = ?, updated_at = ? WHERE id = ?", state, now(), task.id);
    record(task.id, state === "merged" ? "pr_merged" : "pr_closed", "system", { data: { number: task.pr_number!, url: task.pr_url! } });
    if (state === "merged" && transition(task.id, "done", ["in_review"])) {
      sql("UPDATE tasks SET completed_at = ? WHERE id = ?", now(), task.id);
      log.info(`task #${task.number}: pull request merged — done`);
    }
    emit(task.id);
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Meta key: ticket totals were added up again with each run's own cost (the first count took session totals). */
const TOTALS_KEY = "tasks.totals_own_cost";

/**
 * Every ticket's cost, working time and run count, added up again from its runs: each finished run of its chat with
 * what the work it handed over cost. Runs from before migration 30 hold Claude's total for the whole session, so only
 * what such a run added to its chat's session counts. Returns how many tickets changed.
 */
export function recomputeTicketTotals(): number {
  const since = get<{ applied_at: string }>("SELECT applied_at FROM _migrations WHERE id = 30")?.applied_at ?? "";
  const runs = all<{ id: string; conversation_id: string; parent_run_id: string | null; status: string; cost_usd: number | null; duration_ms: number | null; created_at: string }>(
    "SELECT id, conversation_id, parent_run_id, status, cost_usd, duration_ms, created_at FROM runs ORDER BY conversation_id, created_at, rowid",
  );
  const own = new Map<string, number>();
  const children = new Map<string, string[]>();
  let conversation = "";
  let previous: number | null = null;
  for (const r of runs) {
    if (r.conversation_id !== conversation) {
      conversation = r.conversation_id;
      previous = null;
    }
    if (r.parent_run_id) children.set(r.parent_run_id, [...(children.get(r.parent_run_id) ?? []), r.id]);
    if (r.cost_usd == null) continue;
    const sessionTotal = r.created_at < since && previous !== null && r.cost_usd >= previous;
    own.set(r.id, Math.max(0, sessionTotal ? r.cost_usd - previous! : r.cost_usd));
    previous = r.cost_usd;
  }
  const withHandedOver = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return (own.get(id) ?? 0) + (children.get(id) ?? []).reduce((sum, c) => sum + withHandedOver(c, seen), 0);
  };
  const byConversation = new Map<string, typeof runs>();
  for (const r of runs) if (["succeeded", "failed", "cancelled"].includes(r.status)) byConversation.set(r.conversation_id, [...(byConversation.get(r.conversation_id) ?? []), r]);
  let changed = 0;
  tx(() => {
    for (const t of all<{ id: string; conversation_id: string }>("SELECT id, conversation_id FROM tasks WHERE conversation_id IS NOT NULL")) {
      const list = byConversation.get(t.conversation_id) ?? [];
      const cost = Math.round(list.reduce((sum, r) => sum + withHandedOver(r.id), 0) * 1e6) / 1e6;
      const work = list.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
      changed += sql("UPDATE tasks SET cost_usd = ?, work_ms = ?, run_count = ? WHERE id = ? AND (cost_usd != ? OR work_ms != ? OR run_count != ?)", cost, work, list.length, t.id, cost, work, list.length).changes;
    }
  });
  return changed;
}

export function startTasks(): void {
  unsubscribe ??= bus.on(onBusEvent);
  if (getMeta(TOTALS_KEY) !== "1") {
    try {
      const n = recomputeTicketTotals();
      if (n) log.info(`added up the cost of ${n} ticket(s) again`);
      setMeta(TOTALS_KEY, "1");
    } catch (err) {
      log.warn("could not add up the tickets' cost again", err);
    }
  }
  try {
    sweepTaskAttachments();
  } catch (err) {
    log.warn("could not sweep task attachments", err);
  }
  reconcileTasks("Interrupted (Godmode restarted).");
  // The most urgent first, then the earliest due.
  for (const t of all<{ id: string }>(
    `SELECT id FROM tasks WHERE status = 'todo' AND agent_id IS NOT NULL AND archived_at IS NULL
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'low' THEN 3 ELSE 2 END, due_date IS NULL, due_date, position`,
  )) {
    void dispatch(t.id);
  }
  if (!watchTimer) {
    watchTimer = setInterval(() => {
      void checkPullRequests().catch((err) => log.warn("could not check pull requests", err));
      try {
        sweepTaskAttachments();
      } catch (err) {
        log.warn("could not sweep task attachments", err);
      }
    }, PR_WATCH_INTERVAL_MS);
    watchTimer.unref?.();
  }
}

/**
 * Work that was going on when Godmode stopped (or in a restored backup): its runs were marked interrupted. A paused run
 * is still there, and a ticket that waits for its follow-up keeps waiting; the others are blocked, to be continued.
 */
export function reconcileTasks(reason: string): void {
  for (const t of all<TaskRow>("SELECT * FROM tasks WHERE status = 'in_progress'")) {
    if (openRuns(t.conversation_id).length || (t.conversation_id && getFollowup(t.conversation_id))) continue;
    block(t.id, reason, { kind: "interrupted", from: ["in_progress"] });
  }
}

export function stopTasks(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
