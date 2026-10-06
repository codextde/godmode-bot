/**
 * Tasks: tickets on a Kanban board (per workspace, or global) that agents work on.
 *
 * Status flow (the columns of the board):
 *  - `backlog`: parked. Assigning an agent here never starts it.
 *  - `todo`: queued. A task that enters it with an agent (or gets one while in it) starts that agent.
 *  - `in_progress`: the agent is working on it (its run is queued or running), its run stands still (paused, or it
 *    waits for the human's answer), or it waits for the time the agent set to continue (`Task.followup`).
 *  - `in_review`: the agent delivered (coding: the pull request is open) — waiting for the human.
 *  - `blocked`: the run failed, was stopped or interrupted, publishing or setting up didn't work, the agent reported it
 *    needs something, or the human put it there (see TaskBlockedKind).
 *  - `done`: accepted (set by the human, or automatically when the pull request is merged).
 *  - `cancelled`: decided not to do it.
 *
 * Archiving takes a task off the board without deleting it (`archivedAt`): it keeps its status and never starts.
 * Changing its status, or a follow-up, brings it back.
 */
import type { ConversationFollowup, ID, ISODate, RunPause, RunStatus, RunTrigger } from "./models";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";

/**
 * - `general`: the agent does the task and reports back.
 * - `coding`: the agent changes the code on the task's branch, and Godmode pushes the branch and opens a pull request
 *   when it finishes.
 * - `research`: the agent investigates and answers with a written report.
 *
 * Every task whose workspace has a git repository (or that names one) works in its own git worktree on its own branch,
 * so tasks running side by side never touch each other's files or the human's own copy.
 */
export type TaskType = "general" | "coding" | "research";

export type PullRequestState = "open" | "merged" | "closed";

export const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
export const TASK_TYPES: readonly TaskType[] = ["general", "coding", "research"];

/** How urgent a ticket is. Queued tickets start in this order; "none" counts as medium. */
export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";
export const TASK_PRIORITIES: readonly TaskPriority[] = ["urgent", "high", "medium", "low", "none"];
/** Lower starts first. */
export const TASK_PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, none: 2, low: 3 };
export const MAX_TASK_LABELS = 10;
export const MAX_TASK_LABEL_LENGTH = 32;
export const MAX_TASK_NOTE_LENGTH = 2000;

/**
 * Why a ticket is blocked, so the board offers the right way on:
 *  - `needs_input`: the agent reported what it needs (`task_report_blocked`) — answer it.
 *  - `failed`: the run failed — try again. `interrupted`: Godmode restarted (or a backup was restored) mid-run — continue.
 *  - `stopped`: the human stopped the run — start again.
 *  - `publish`: pushing the branch or opening the pull request didn't work — publish again.
 *  - `setup`: the agent is gone or switched off, or the worktree couldn't be made — fix it and try again.
 *  - `manual`: the human moved it to Blocked (with an optional reason).
 */
export type TaskBlockedKind = "needs_input" | "failed" | "stopped" | "interrupted" | "publish" | "setup" | "manual";
/** Who did something on a ticket: the human, Godmode itself, or an agent. */
export type TaskActor = "user" | "system" | `agent:${string}`;

export type TaskEventKind =
  | "status"
  | "assigned"
  | "archived"
  | "started"
  | "waiting"
  | "delivered"
  | "blocked"
  | "feedback"
  | "note"
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "asked"
  | "answered";

export interface TaskEventData {
  /** body: the reason, when the human moved it to Blocked. */
  status: { from: TaskStatus; to: TaskStatus };
  assigned: { from: ID | null; to: ID | null; fromName: string; toName: string };
  archived: { archived: boolean };
  /** again: not the ticket's first start. */
  /** retry: tried again on its own after a failure (1, 2, …); body: why the run before failed. */
  started: { trigger: RunTrigger; again: boolean; subtasks?: number[]; retry?: number };
  /** body: what the agent said when it ended its turn. Waits for a follow-up (dueAt, note) or for sub-tickets. */
  waiting: { dueAt?: ISODate; note?: string; subtasks?: number[] };
  /** body: the full result. */
  delivered: { costUsd: number | null; durationMs: number | null; pullRequest: number | null };
  /** body: the reason. */
  blocked: { kind: TaskBlockedKind };
  /** body: the message; on: the ticket's status when it was sent. */
  feedback: { on: TaskStatus; files: string[] };
  /** body: the note. */
  note: Record<string, never>;
  pr_opened: { number: number | null; url: string };
  /** auto: merged by Godmode because its workspace merges delivered work automatically. */
  pr_merged: { number: number; url: string; auto?: boolean };
  pr_closed: { number: number; url: string };
  /** body: what was asked (see AgentQuestion). */
  asked: { questionId: ID; kind: "question" | "approval" };
  /** body: the answer. */
  answered: { questionId: ID; status: string };
}

/** Something that happened on a ticket — its timeline, oldest first. Append-only. */
export type TaskEvent = {
  [K in TaskEventKind]: {
    id: ID;
    taskId: ID;
    kind: K;
    actor: TaskActor;
    /** The agent's name when it happened ("" for the human and Godmode): stays readable after the agent is deleted. */
    actorName: string;
    /** Markdown; saved secrets masked. */
    body: string;
    data: TaskEventData[K];
    runId: ID | null;
    createdAt: ISODate;
  };
}[TaskEventKind];

export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 20_000;
export const MAX_TASK_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * A file (image, PDF, anything) added to a task's description. The description links it by its `url` —
 * `![shot.png](/api/tasks/attachments/<id>/shot.png)` for images, `[spec.pdf](/api/tasks/attachments/<id>/spec.pdf)`
 * for other files — and the agent gets a copy of every linked file when it starts.
 */
export interface TaskAttachment {
  id: ID;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export const TASK_ATTACHMENT_PATH = "/api/tasks/attachments/";

export function taskAttachmentUrl(id: string, name: string): string {
  // Parentheses too: they would end a Markdown link.
  const encoded = encodeURIComponent(name).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${TASK_ATTACHMENT_PATH}${id}/${encoded}`;
}

/** Matches a task attachment's url (group 1: its id, group 2: its encoded name). */
export const TASK_ATTACHMENT_URL = /\/api\/tasks\/attachments\/(tat_[A-Za-z0-9_-]+)\/([^\s)"'<>]+)/g;

/** Ids of the attachments a description links, in order, without repeats. */
export function taskAttachmentIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(TASK_ATTACHMENT_URL)].map((m) => m[1]!))];
}

/** Markdown that shows (image) or links (other file) an attachment. */
export function taskAttachmentMarkdown(a: Pick<TaskAttachment, "name" | "mime" | "url">): string {
  const label = a.name.replace(/[[\]\\]/g, "\\$&");
  return a.mime.startsWith("image/") ? `![${label}](${a.url})` : `[${label}](${a.url})`;
}

export interface TaskPullRequest {
  /** Pull request page, or — when it couldn't be opened automatically — the page to open it. */
  url: string;
  /** null while the pull request isn't open yet (the url then points at the "compare" page). */
  number: number | null;
  state: PullRequestState | null;
}

export interface Task {
  id: ID;
  /** null = a global task. */
  workspaceId: ID | null;
  /** Sequential, shown as #12. */
  number: number;
  title: string;
  /** Markdown. */
  description: string;
  type: TaskType;
  status: TaskStatus;
  /** Order within its column (ascending). */
  position: number;
  agentId: ID | null;
  /** Conversation the agent works in (follow-ups continue it). */
  conversationId: ID | null;
  /** Latest run in that conversation and its status. */
  runId: ID | null;
  runStatus: RunStatus | null;
  /** The agent's work on the task stands still: paused by the human, waiting for Claude's usage limit to reset, or waiting for the human's answer. */
  pause: RunPause | null;
  /** Git remote of the task's repository. "" = the workspace's repository (or a local one without a remote). */
  repoUrl: string;
  /** Workspace folder (a git repository) the task's worktree comes from. "" = the remote repository (`repoUrl`). */
  repoPath: string;
  /** Branch to start from (and open the pull request against). "" = the workspace's, else the default branch. */
  baseBranch: string;
  /** The task's own branch, once its worktree was created. */
  branch: string | null;
  /** Godmode pushed the branch to `repoUrl` (coding tasks when they finish, others when asked to from the board). */
  branchPushed: boolean;
  /** The task's own git worktree the agent works in, once created. */
  worktree: string | null;
  pullRequest: TaskPullRequest | null;
  /** The agent's final answer (report, summary of the changes). */
  summary: string | null;
  /** Why the task is blocked. */
  blockedReason: string | null;
  /** What Godmode is doing for the task right now ("Cloning the repository…", "Opening the pull request…"). */
  activity: string | null;
  priority: TaskPriority;
  /** A calendar day, YYYY-MM-DD. */
  dueDate: string | null;
  labels: string[];
  /** Who filed it: the human, or the agent that created it. */
  createdBy: TaskActor;
  /** Why it is blocked (null unless blocked, and for tickets blocked before kinds existed). */
  blockedKind: TaskBlockedKind | null;
  /** The time the agent set to continue on its own: the ticket waits for it (In progress, nothing running). */
  followup: ConversationFollowup | null;
  /** What every run that ended on this ticket cost, how long the agent worked, and how many runs there were. */
  costUsd: number;
  workMs: number;
  runCount: number;
  /** When the latest run started (null while it is queued). */
  runStartedAt: ISODate | null;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
  /** Off the board since then; null = on the board. */
  archivedAt: ISODate | null;
  /** The bigger ticket this one is part of (it waits for this one), and its number. */
  parentId: ID | null;
  parentNumber: number | null;
  /** The goal this ticket serves (its agent is told why), or null. */
  goalId: ID | null;
  /** Tickets this one waits for: it starts once each is delivered (or done, cancelled, archived). */
  waitsFor: { id: ID; number: number; title: string; finished: boolean }[];
  /** Its own sub-tickets: how many, how many are still open (not delivered, done, cancelled or archived), and how many
   *  of those are blocked. null = none. */
  subtasks: { total: number; open: number; blocked: number } | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface TaskInput {
  workspaceId?: ID | null;
  title: string;
  description?: string;
  type?: TaskType;
  /** Default: `backlog`, or `todo` when an agent is assigned. */
  status?: TaskStatus;
  agentId?: ID | null;
  repoUrl?: string;
  /** One of the workspace's folders that is a git repository. */
  repoPath?: string;
  baseBranch?: string;
  priority?: TaskPriority;
  dueDate?: string | null;
  labels?: string[];
  /** Make it a sub-ticket of this ticket (it waits for it). */
  parentId?: ID | null;
  /** The goal it serves (a part serves its ticket's goal). */
  goalId?: ID | null;
  /** Tickets it waits for before it starts. */
  waitsFor?: ID[];
}

export interface TaskPatch {
  /** The goal it serves; null = none. */
  goalId?: ID | null;
  /** Tickets it waits for before it starts (replaces the list). */
  waitsFor?: ID[];
  title?: string;
  description?: string;
  type?: TaskType;
  status?: TaskStatus;
  /** Place the task before this one in its (new) column; null = at the end. */
  beforeId?: ID | null;
  agentId?: ID | null;
  repoUrl?: string;
  repoPath?: string;
  baseBranch?: string;
  /** Take it off the board (a running agent is stopped and the task parked in the backlog), or bring it back. */
  archived?: boolean;
  priority?: TaskPriority;
  dueDate?: string | null;
  labels?: string[];
  /** Why it is blocked: with `status: "blocked"`, or to change a reason the human set. */
  blockedReason?: string;
}

export interface TaskMessageInput {
  content: string;
  /** Files for the agent (base64), as in chats. */
  attachments?: { name: string; mime: string; data: string }[];
}

/* ------------------------------------------------------------------ */
/* Helpers shared by the core, the desktop and the phone               */
/* ------------------------------------------------------------------ */

/** A day as YYYY-MM-DD in local time. */
export function localDay(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Past its due day and not finished. */
export function isOverdue(t: Pick<Task, "dueDate" | "status">, today = localDay()): boolean {
  return !!t.dueDate && t.dueDate < today && t.status !== "done" && t.status !== "cancelled";
}

/** Nothing runs and nothing stands still: the ticket waits for the time its agent set to continue. */
export function isWaiting(t: Pick<Task, "status" | "followup" | "pause" | "runStatus" | "activity">): boolean {
  return t.status === "in_progress" && !!t.followup && !t.pause && t.runStatus !== "queued" && t.runStatus !== "running" && !t.activity;
}

/** "#13", "#13 and #14", "#13, #14 and #15". */
export function ticketList(numbers: readonly number[]): string {
  const n = numbers.map((x) => `#${x}`);
  return n.length < 2 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** In Todo, not started: it waits for tickets that aren't finished yet. */
export function waitsForTickets(t: Pick<Task, "status" | "waitsFor">): boolean {
  return t.status === "todo" && t.waitsFor.some((w) => !w.finished);
}

/** In progress, nothing running: the ticket waits until its sub-tickets are done (then its agent continues). */
export function waitsForSubtasks(t: Pick<Task, "status" | "subtasks" | "pause" | "runStatus" | "activity" | "followup">): boolean {
  return t.status === "in_progress" && !!t.subtasks?.open && !t.followup && !t.pause && t.runStatus !== "queued" && t.runStatus !== "running" && !t.activity;
}

/** The ticket's run waits for the human's answer to a question or an approval. */
export function waitsForAnswer(t: Pick<Task, "status" | "pause">): boolean {
  return t.status === "in_progress" && t.pause?.reason === "question";
}

/** Where Reopen puts a done or cancelled ticket: back in review when there is something to review, else parked. */
export function reopenStatus(t: Pick<Task, "summary" | "conversationId" | "agentId">): TaskStatus {
  return t.summary && t.conversationId && t.agentId ? "in_review" : "backlog";
}

/** Approving this ticket merges its pull request first (POST /api/tasks/:id/approve). */
export function mergesOnApprove(t: Pick<Task, "status" | "pullRequest">): boolean {
  return t.status === "in_review" && !!t.pullRequest?.number && t.pullRequest.state === "open";
}

/** One label, cleaned: no leading #, single spaces, at most MAX_TASK_LABEL_LENGTH characters. "" = drop it. */
export function cleanTaskLabel(label: string): string {
  return label.replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, MAX_TASK_LABEL_LENGTH).trim();
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * One line that says what happened, for the timeline on every client and for agents reading it (`task_get`).
 * `you`: how the human is named as a subject ("You", or their name); `youObject` as an object ("you").
 */
export function taskEventText(e: TaskEvent, o: { you: string; youObject: string; when?: (iso: string) => string }): string {
  const a = e.actor === "user" ? o.you : e.actor === "system" ? "Godmode" : e.actorName || "An agent";
  const label = (s: TaskStatus) => TASK_STATUS_LABELS[s] ?? s;
  switch (e.kind) {
    case "status": {
      const { from, to } = e.data;
      if (to === "done") return from === "in_review" ? `${a} approved it` : `${a} marked it done`;
      if (to === "cancelled") return `${a} cancelled it`;
      if (from === "done" || from === "cancelled") return `${a} reopened it`;
      if (to === "blocked") return `${a} moved it to Blocked`;
      if (from === "blocked" && to === "todo") return `${a} restarted it`;
      if (from === "in_progress" && to === "backlog") return `${a} stopped it`;
      return `${a} moved it from ${label(from)} to ${label(to)}`;
    }
    case "assigned": {
      const { from, to, fromName, toName } = e.data;
      if (!from) return `${a} assigned it to ${toName || "an agent"}`;
      if (!to) return `${a} took ${fromName || "the agent"} off it`;
      return `${a} handed it from ${fromName || "an agent"} to ${toName || "another agent"}`;
    }
    case "archived":
      return e.data.archived ? `${a} archived it` : `${a} put it back on the board`;
    case "started":
      if (e.data.subtasks?.length) return `${a} picked it up again — ${ticketList(e.data.subtasks)} ${e.data.subtasks.length === 1 ? "is" : "are"} done`;
      if (e.data.retry) return e.data.retry > 1 ? `${a} tried once more on its own` : `${a} tried again on its own after the run failed`;
      if (!e.data.again) return `${a} started working`;
      if (e.data.trigger === "followup") return `${a} continued as planned`;
      if (e.data.trigger === "task") return `${a} started over`;
      return `${a} picked it up again`;
    case "waiting":
      if (e.data.subtasks?.length) return `${a} is waiting for ${ticketList(e.data.subtasks)}`;
      return `${a} is waiting — continues ${e.data.dueAt ? (o.when ? o.when(e.data.dueAt) : e.data.dueAt) : "later"}`;
    case "delivered":
      return `${a} delivered${e.data.pullRequest ? ` — pull request #${e.data.pullRequest}` : ""}`;
    case "blocked":
      switch (e.data.kind) {
        case "needs_input":
          return `${a} needs something from ${o.youObject}`;
        case "failed":
          return "The run failed";
        case "stopped":
          return "Stopped before it finished";
        case "interrupted":
          return "Interrupted by a restart";
        case "publish":
          return "Couldn't publish the work";
        case "setup":
          return "Couldn't set it up";
        default:
          return `${a} moved it to Blocked`;
      }
    case "feedback":
      if (e.data.on === "in_review") return `${a} requested changes`;
      if (e.data.on === "blocked") return `${a} answered`;
      if (e.data.on === "done" || e.data.on === "cancelled") return `${a} reopened it with a message`;
      return `${a} wrote`;
    case "note":
      return `${a} noted`;
    case "pr_opened":
      return e.data.number ? `Pull request #${e.data.number} opened` : "Branch pushed — the pull request still has to be opened";
    case "pr_merged":
      if (e.data.auto) return `Pull request #${e.data.number} merged automatically`;
      return e.actor === "user" ? `${a} merged pull request #${e.data.number}` : `Pull request #${e.data.number} merged`;
    case "pr_closed":
      return `Pull request #${e.data.number} closed without merging`;
    case "asked":
      return e.data.kind === "approval" ? `${a} asked ${o.youObject} for an OK` : `${a} asked ${o.youObject}`;
    case "answered":
      return e.data.status === "approved" ? `${a} approved` : e.data.status === "declined" ? `${a} declined` : `${a} answered`;
  }
}

export type GoalStatus = "active" | "achieved" | "dropped";

/** What the work is for: tickets serve a goal; its agent is told why, and the board shows how far it is. */
export interface Goal {
  id: ID;
  /** null = a goal across all workspaces. */
  workspaceId: ID | null;
  title: string;
  /** Why it matters, or how to tell it is reached (the agents get it with every ticket that serves it). */
  why: string;
  status: GoalStatus;
  /** A calendar day, YYYY-MM-DD. */
  targetDate: string | null;
  /** Tickets serving it (archived ones left out), and how many are done. */
  tickets: { total: number; done: number; open: number };
  /** What the work on its tickets cost so far. */
  costUsd: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface GoalInput {
  title: string;
  why?: string;
  workspaceId?: ID | null;
  targetDate?: string | null;
  status?: GoalStatus;
}

export const MAX_GOAL_TITLE_LENGTH = 200;
export const MAX_GOAL_WHY_LENGTH = 2000;
