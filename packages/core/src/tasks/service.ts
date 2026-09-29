/**
 * Tasks: the Kanban board agents work from (see packages/shared/src/tasks.ts for the status flow).
 *
 * A task with an agent starts when it enters Todo (or In progress): coding tasks first get a checkout of the repository
 * on their own branch (<data>/tasks/<id>), then the agent works in the task's conversation (origin "task", archived so
 * it stays off the chat list). Every run in that conversation — the first one and the human's follow-ups — moves the
 * task along when it ends: In review when it succeeded (coding: after pushing the branch and opening the pull
 * request), Blocked when it failed, was stopped, or the agent reported it can't go on. Merged pull requests move
 * their task to Done.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, PullRequestState, Run, RunStatus, ServerEvent, Task, TaskInput, TaskPatch, TaskStatus, TaskType } from "@godmode/shared";
import { MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH, TASK_STATUSES, TASK_TYPES, isValidBranch, parseGitUrl } from "@godmode/shared";
import { config } from "../config";
import { all, get, getMeta, insert, run as sql, setMeta, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, newId, notFound, now, slugify } from "../util";
import { containsSecret, redact } from "../vault/vault";
import { getAgent } from "../agents/service";
import { activeRunForConversation, cancelRun, getRun, waitForRun } from "../runner/runner";
import { conversationExists, createConversation, sendMessage } from "../services/conversations";
import { notify } from "../services/notifications";
import { branchDiff, commitWork, openPullRequest, prepareCheckout, pullRequestState, pushBranch, secretFilesAdded } from "./git";

const log = logger("tasks");

const PR_WATCH_INTERVAL_MS = 5 * 60_000;
const POSITION_STEP = 1024;
const SUMMARY_MAX = 20_000;
const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
/** Statuses an agent's work (not the human) may move a task out of. */
const WORKING: readonly TaskStatus[] = ["in_progress"];
const STARTABLE: readonly TaskStatus[] = ["todo", "in_progress"];

interface TaskRow {
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
  base_branch: string;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: PullRequestState | null;
  pushed_sha: string | null;
  summary: string | null;
  blocked_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  run_id?: string | null;
  run_status?: RunStatus | null;
}

/** What Godmode is doing for a task right now (not persisted). */
const activity = new Map<string, string>();
/** Tasks being started or published (one at a time per task). */
const busy = new Set<string>();
/** Tasks the board asked to (re)start while they were busy: started once they are free. */
const again = new Set<string>();
let unsubscribe: (() => void) | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;

const SELECT = `SELECT t.*, r.id AS run_id, r.status AS run_status FROM tasks t
  LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE conversation_id = t.conversation_id ORDER BY created_at DESC, rowid DESC LIMIT 1)`;

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
    repoUrl: r.repo_url,
    baseBranch: r.base_branch,
    branch: r.branch,
    pullRequest: r.pr_url ? { url: r.pr_url, number: r.pr_number, state: r.pr_state } : null,
    summary: r.summary,
    blockedReason: r.blocked_reason,
    activity: activity.get(r.id) ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at,
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

/** Tasks of a scope: "all" (default), "global" or a workspace id. */
export function listTasks(opts: { workspaceId?: string } = {}): Task[] {
  const ws = opts.workspaceId ?? "all";
  const order = "ORDER BY t.position ASC, t.number ASC";
  const rows =
    ws === "all"
      ? all<TaskRow>(`${SELECT} ${order}`)
      : ws === "global"
        ? all<TaskRow>(`${SELECT} WHERE t.workspace_id IS NULL ${order}`)
        : all<TaskRow>(`${SELECT} WHERE t.workspace_id = ? ${order}`, ws);
  return rows.map(toModel);
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

function cleanBranch(branch: string | undefined): string {
  const b = (branch ?? "").trim();
  if (b && !isValidBranch(b)) throw badRequest(`"${b}" isn't a valid branch name`);
  return b;
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
    "SELECT id, position FROM tasks WHERE workspace_id IS ? AND status = ? AND id IS NOT ? ORDER BY position ASC, number ASC",
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

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export function createTask(input: TaskInput): Task {
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
  insert("tasks", {
    id,
    workspace_id: workspaceId,
    number,
    title: cleanTitle(input.title),
    description: cleanDescription(input.description),
    type: cleanType(input.type),
    status,
    position: positionIn(workspaceId, status, null),
    agent_id: agentId,
    repo_url: cleanRepoUrl(input.repoUrl),
    base_branch: cleanBranch(input.baseBranch),
    completed_at: status === "done" || status === "cancelled" ? ts : null,
    created_at: ts,
    updated_at: ts,
  });
  emit(id);
  if (agentId && (status === "todo" || status === "in_progress")) void dispatch(id);
  return getTask(id);
}

export function updateTask(id: string, patch: TaskPatch): Task {
  const current = requireRow(id);
  const agentId = patch.agentId !== undefined ? checkAgent(patch.agentId, current.workspace_id) : current.agent_id;
  let status = patch.status !== undefined ? cleanStatus(patch.status) : current.status;
  // Nobody left to work on it: park it.
  if (!agentId && patch.status === undefined && status === "in_progress") status = "backlog";
  const moved = status !== current.status || patch.beforeId !== undefined;
  const finished = status === "done" || status === "cancelled";
  update("tasks", id, {
    title: patch.title !== undefined ? cleanTitle(patch.title) : undefined,
    description: patch.description !== undefined ? cleanDescription(patch.description) : undefined,
    type: patch.type !== undefined ? cleanType(patch.type) : undefined,
    repo_url: patch.repoUrl !== undefined ? cleanRepoUrl(patch.repoUrl) : undefined,
    base_branch: patch.baseBranch !== undefined ? cleanBranch(patch.baseBranch) : undefined,
    status,
    agent_id: agentId,
    position: moved ? positionIn(current.workspace_id, status, patch.beforeId, id) : undefined,
    completed_at: status === current.status ? undefined : finished ? now() : null,
    blocked_reason: (status !== current.status && status !== "blocked") || agentId !== current.agent_id ? null : undefined,
    updated_at: now(),
  });

  const wasWorking = current.status === "in_progress";
  const reassigned = agentId !== current.agent_id;
  const starts =
    !!agentId &&
    ((status !== current.status && (status === "todo" || (status === "in_progress" && !wasWorking))) ||
      ((status === "todo" || status === "in_progress") && reassigned));
  // Start first: the restart owns the task before the old run's end is reported.
  if (starts) void dispatch(id);
  if (wasWorking && (status !== "in_progress" || reassigned)) void stopWork(current);
  emit(id);
  return getTask(id);
}

/** Cancel the run working on a task (the board moved it away from In progress). */
async function stopWork(task: TaskRow) {
  // A restart that already owns the task shows its own progress.
  if (!busy.has(task.id)) activity.delete(task.id);
  const active = task.conversation_id ? activeRunForConversation(task.conversation_id) : null;
  if (!active) return;
  try {
    await cancelRun(active, "Stopped from the task board");
  } catch (err) {
    log.warn(`could not stop the run of task ${task.id}`, err);
  }
}

export async function deleteTask(id: string): Promise<void> {
  const task = requireRow(id);
  sql("DELETE FROM tasks WHERE id = ?", id);
  activity.delete(id);
  bus.emit({ type: "task.deleted", id });
  const active = task.conversation_id ? activeRunForConversation(task.conversation_id) : null;
  if (active) {
    await cancelRun(active, "The task was deleted").catch(() => {});
    await waitForRun(active, 15_000).catch(() => {});
  }
  rmSync(checkoutDir(id), { recursive: true, force: true });
}

/** Stop and clean up every task of a workspace that is being deleted (its rows go with the workspace). */
export async function removeWorkspaceTasks(workspaceId: string): Promise<void> {
  for (const t of all<TaskRow>("SELECT * FROM tasks WHERE workspace_id = ?", workspaceId)) {
    const active = t.conversation_id ? activeRunForConversation(t.conversation_id) : null;
    await stopWork(t);
    if (active) await waitForRun(active, 15_000).catch(() => {});
    rmSync(checkoutDir(t.id), { recursive: true, force: true });
  }
}

/** A follow-up from the human in the task's conversation (e.g. review feedback); the task goes back to work. */
export async function sendTaskMessage(id: string, content: string): Promise<Task> {
  const task = requireRow(id);
  if (!content.trim()) throw badRequest("Message is empty");
  if (!task.conversation_id || !conversationExists(task.conversation_id)) throw conflict("The task hasn't started yet — move it to Todo to start it");
  const owner = get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", task.conversation_id)?.agent_id;
  if (!task.agent_id || owner !== task.agent_id) throw conflict("Move the task to Todo to hand it to its agent");
  if (busy.has(id)) throw conflict(`Godmode is ${activity.get(id)?.replace(/…$/, "").toLowerCase() ?? "preparing the task"} — send it again in a moment`);
  await sendMessage(task.conversation_id, { content, trigger: "task" });
  return getTask(id);
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
function transition(id: string, status: TaskStatus, from: readonly TaskStatus[], blockedReason: string | null = null): boolean {
  const t = get<{ workspace_id: string | null; status: TaskStatus; position: number }>("SELECT workspace_id, status, position FROM tasks WHERE id = ?", id);
  if (!t || !from.includes(t.status)) return false;
  const top = get<{ p: number | null }>("SELECT MIN(position) AS p FROM tasks WHERE workspace_id IS ? AND status = ? AND id != ?", t.workspace_id, status, id)?.p;
  const position = t.status === status ? t.position : top == null ? POSITION_STEP : top - POSITION_STEP;
  sql("UPDATE tasks SET status = ?, position = ?, blocked_reason = ?, updated_at = ? WHERE id = ?", status, position, blockedReason, now(), id);
  return true;
}

function block(id: string, reason: string, from: readonly TaskStatus[] = WORKING) {
  activity.delete(id);
  transition(id, "blocked", from, redact(reason).slice(0, 2000));
  emit(id);
}

/** The workspace's first git repository: what coding tasks clone unless they name another one. */
function workspaceRepo(workspaceId: string | null): { url: string; branch: string } {
  const source = workspaceId
    ? get<{ url: string | null; branch: string | null }>(
        "SELECT url, branch FROM workspace_sources WHERE workspace_id = ? AND kind = 'git' AND url IS NOT NULL ORDER BY position, created_at LIMIT 1",
        workspaceId,
      )
    : null;
  return { url: source?.url ?? "", branch: source?.branch ?? "" };
}

function branchName(task: TaskRow): string {
  const slug = slugify(task.title).slice(0, 40).replace(/-+$/, "") || "task";
  return `godmode/${task.number}-${slug}`;
}

const TYPE_BRIEF: Record<TaskType, (t: { repo: string; base: string; branch: string }) => string> = {
  general: () => "Do the task and finish with a short summary of what you did and anything the human should check.",
  research: () =>
    "Research this thoroughly and answer with a well-structured report in Markdown: the key findings first, then details, sources (with links) and a recommendation where it helps.",
  coding: ({ repo, base, branch }) =>
    [
      `You work in a fresh checkout of ${repo} (your current directory), on the branch \`${branch}\` created from \`${base}\`. Make every change here — not in other copies of the repository you may see.`,
      "Implement the change, keep to the project's conventions, run its tests and linters when it has them, and commit your work with clear commit messages.",
      "Don't push and don't open a pull request: Godmode pushes the branch and opens the pull request when you finish.",
      "End with a summary of the changes — it becomes the pull request description.",
    ].join("\n"),
};

function taskPrompt(task: TaskRow, coding: { repo: string; base: string; branch: string } | null, restarted: boolean): string {
  const lines = [
    restarted ? `The task #${task.number} was restarted from the board — here it is again (it may have changed):` : `You were assigned task #${task.number} on the task board.`,
    "",
    `# ${task.title}`,
    "",
    task.description.trim() || "_No description._",
    "",
    "---",
    TYPE_BRIEF[task.type](coding ?? { repo: "", base: "", branch: "" }),
    "If you can't finish because something is missing (access, information, a decision), call the `task_report_blocked` tool with what you need, then stop.",
  ];
  return lines.join("\n");
}

/** Start (or restart) the agent on a task in Todo / In progress. Never throws; problems block the task. */
export async function dispatch(id: string): Promise<void> {
  if (busy.has(id)) {
    again.add(id);
    return;
  }
  busy.add(id);
  try {
    let task = row(id);
    if (!task || !task.agent_id || !STARTABLE.includes(task.status)) return;
    let agent: Agent;
    try {
      agent = getAgent(task.agent_id);
    } catch {
      return block(id, "The assigned agent doesn't exist anymore.", STARTABLE);
    }
    if (!agent.enabled) return block(id, `${agent.name} is disabled — turn it on or assign another agent.`, STARTABLE);

    const previous = task.conversation_id ? activeRunForConversation(task.conversation_id) : null;
    if (previous) {
      await cancelRun(previous, "Restarted from the task board").catch(() => {});
      await waitForRun(previous, 15_000).catch(() => {});
    }
    if (!transition(id, "in_progress", STARTABLE)) return;
    sql("UPDATE tasks SET started_at = ?, completed_at = NULL WHERE id = ?", now(), id);

    let coding: { repo: string; base: string; branch: string } | null = null;
    let workDir: string | null = null;
    if (task.type === "coding") {
      const fallback = workspaceRepo(task.workspace_id);
      const repo = task.repo_url || fallback.url;
      if (!repo) return block(id, "Coding tasks need a git repository — add one to the workspace (or the task).", STARTABLE);
      const branch = task.branch ?? branchName(task);
      workDir = checkoutDir(id);
      setActivity(id, task.branch ? "Updating the checkout…" : "Cloning the repository…");
      let base: string;
      try {
        ({ base } = await prepareCheckout({ dir: workDir, url: repo, base: task.base_branch || fallback.branch, branch }));
      } catch (err) {
        return block(id, `Couldn't get the repository: ${err instanceof Error ? err.message : String(err)}`);
      }
      sql("UPDATE tasks SET repo_url = ?, base_branch = ?, branch = ? WHERE id = ?", repo, base, branch, id);
      coding = { repo, base, branch };
    }

    task = row(id);
    if (!task) {
      // Deleted while the repository was being cloned.
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      return;
    }
    // Moved away (or reassigned) while the repository was being cloned; a restart asked for meanwhile follows.
    if (task.status !== "in_progress" || task.agent_id !== agent.id) return;

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
    activity.delete(id);
    await sendMessage(conversationId!, { content: taskPrompt(task, coding, restarted), trigger: "task" });
    emit(id);
  } catch (err) {
    log.warn(`task ${id} could not start`, err);
    block(id, err instanceof Error ? err.message : String(err), STARTABLE);
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

function onBusEvent(event: ServerEvent) {
  if (event.type !== "run.started" && event.type !== "run.finished") return;
  const task = get<TaskRow>("SELECT * FROM tasks WHERE conversation_id = ?", event.run.conversationId);
  if (!task) return;
  if (event.type === "run.started") {
    // A follow-up (review feedback, a question) puts a delivered or blocked task back to work.
    if (event.run.status === "queued" && !busy.has(task.id) && transition(task.id, "in_progress", ["in_review", "blocked", "done", "cancelled", "backlog"])) {
      sql("UPDATE tasks SET completed_at = NULL WHERE id = ?", task.id);
    }
    emit(task.id);
    return;
  }
  void finished(task.id, event.run).catch((err) => log.warn(`task ${task.id}: could not handle the end of run ${event.run.id}`, err));
}

async function finished(id: string, run: Run): Promise<void> {
  const task = row(id);
  if (!task) return;
  // Starting or publishing: handled once the task is free (settle).
  if (busy.has(id)) return;
  // Another turn is already queued in the conversation, or the board moved the task away meanwhile.
  if (latestRunId(run.conversationId) !== run.id || task.status !== "in_progress") return emit(id);
  const link = `/tasks?task=${id}`;
  if (run.status === "cancelled") return block(id, "Stopped before it finished.");
  if (run.status === "failed") {
    block(id, run.error || "The run failed.");
    notify("error", `Task #${task.number} is blocked`, run.error ?? "", link);
    return;
  }
  const summary = run.result ? run.result.slice(0, SUMMARY_MAX) : null;
  sql("UPDATE tasks SET summary = ? WHERE id = ?", summary, id);
  if (task.blocked_reason) {
    block(id, task.blocked_reason);
    notify("warning", `Task #${task.number} needs you`, task.blocked_reason, link);
    return;
  }
  if (task.type === "coding" && task.branch) {
    busy.add(id);
    try {
      await publish(requireRow(id), summary, run.id);
    } finally {
      release(id);
    }
    return;
  }
  if (deliver(id, run.id)) notify("success", `Task #${task.number} is ready for review`, task.title, link);
}

/** In review — unless a newer turn (a follow-up) started meanwhile; its end decides then. */
function deliver(id: string, runId: string): boolean {
  activity.delete(id);
  const conv = get<{ conversation_id: string | null }>("SELECT conversation_id FROM tasks WHERE id = ?", id)?.conversation_id;
  const moved = !!conv && latestRunId(conv) === runId && transition(id, "in_review", WORKING);
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
 * Commit and push the task's branch and open its pull request (once; later pushes update it). Nothing is pushed when
 * the changes contain a secret from the vault; new env/key files are left out.
 */
async function publish(task: TaskRow, summary: string | null, runId: string): Promise<void> {
  const id = task.id;
  const dir = checkoutDir(id);
  const link = `/tasks?task=${id}`;
  const title = redact(task.title);
  try {
    setActivity(id, "Pushing the branch…");
    const { skipped } = await commitWork({ dir, message: `${title} (#${task.number})` });
    if (skipped.length) notify("warning", `Task #${task.number}: files left out`, `Not committed because they look like secrets: ${skipped.join(", ")}`, link);
    const secretFiles = await secretFilesAdded(dir, task.base_branch);
    if (secretFiles.length) {
      return block(id, `The branch ${task.branch} adds files that look like secrets (${secretFiles.join(", ")}), so Godmode didn't push it. Remove them from the branch (the checkout is in ${dir}), then move the task to Todo.`);
    }
    if (containsSecret(await branchDiff(dir, task.base_branch))) {
      return block(id, `The changes on ${task.branch} contain a secret saved in the vault, so Godmode didn't push them. Remove it from the branch (the checkout is in ${dir}), then move the task to Todo.`);
    }
    const { pushed, sha } = await pushBranch({ dir, base: task.base_branch, branch: task.branch!, lastPushed: task.pushed_sha });
    if (!pushed) {
      if (deliver(id, runId)) notify("info", `Task #${task.number}: no code changes`, "The agent finished without changing the code.", link);
      return;
    }
    sql("UPDATE tasks SET pushed_sha = ? WHERE id = ?", sha, id);
    if (task.pr_url && task.pr_number && task.pr_state === "open") {
      if (deliver(id, runId)) notify("success", `Task #${task.number}: pull request updated`, title, link);
      return;
    }
    setActivity(id, "Opening the pull request…");
    const { pullRequest, problem } = await openPullRequest({
      dir,
      url: task.repo_url,
      base: task.base_branch,
      branch: task.branch!,
      title,
      body: redact(prBody(task, summary)),
    });
    if (pullRequest) sql("UPDATE tasks SET pr_url = ?, pr_number = ?, pr_state = ? WHERE id = ?", pullRequest.url, pullRequest.number, pullRequest.state, id);
    if (!deliver(id, runId)) return;
    if (pullRequest?.number) notify("success", `Task #${task.number}: pull request #${pullRequest.number} is open`, title, link);
    else notify("warning", `Task #${task.number}: open the pull request`, `The branch ${task.branch} was pushed. ${problem ?? ""}`.trim(), link);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    block(id, `Couldn't push the branch: ${message}`);
    notify("error", `Task #${task.number} is blocked`, message, link);
  }
}

/** Move tasks whose pull request was merged to Done (and note closed ones). */
export async function checkPullRequests(): Promise<void> {
  const open = all<TaskRow>("SELECT * FROM tasks WHERE status = 'in_review' AND pr_number IS NOT NULL AND pr_state = 'open' AND pr_url IS NOT NULL");
  for (const task of open) {
    const state = await pullRequestState(checkoutDir(task.id), task.pr_url!).catch(() => null);
    if (!state || state === "open") continue;
    sql("UPDATE tasks SET pr_state = ?, updated_at = ? WHERE id = ?", state, now(), task.id);
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

export function startTasks(): void {
  unsubscribe ??= bus.on(onBusEvent);
  // Work that was going on when Godmode stopped: its runs were marked interrupted.
  for (const t of all<TaskRow>("SELECT * FROM tasks WHERE status = 'in_progress'")) {
    if (!t.conversation_id || !activeRunForConversation(t.conversation_id)) {
      sql("UPDATE tasks SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?", "Interrupted (Godmode restarted).", now(), t.id);
    }
  }
  for (const t of all<{ id: string }>("SELECT id FROM tasks WHERE status = 'todo' AND agent_id IS NOT NULL ORDER BY position")) void dispatch(t.id);
  if (!watchTimer) {
    watchTimer = setInterval(() => void checkPullRequests().catch((err) => log.warn("could not check pull requests", err)), PR_WATCH_INTERVAL_MS);
    watchTimer.unref?.();
  }
}

export function stopTasks(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
