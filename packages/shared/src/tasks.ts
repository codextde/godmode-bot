/**
 * Tasks: tickets on a Kanban board (per workspace, or global) that agents work on.
 *
 * Status flow (the columns of the board):
 *  - `backlog`: parked. Assigning an agent here never starts it.
 *  - `todo`: queued. A task that enters it with an agent (or gets one while in it) starts that agent.
 *  - `in_progress`: the agent is working on it (its run is queued or running).
 *  - `in_review`: the agent delivered (coding: the pull request is open) — waiting for the human.
 *  - `blocked`: the run failed, was stopped, or the agent reported it can't go on.
 *  - `done`: accepted (set by the human, or automatically when the pull request is merged).
 *  - `cancelled`: decided not to do it.
 */
import type { ID, ISODate, RunStatus } from "./models";

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
  /** Git remote of the task's repository. "" = the workspace's repository (or a local one without a remote). */
  repoUrl: string;
  /** Workspace folder (a git repository) the task's worktree comes from. "" = the remote repository (`repoUrl`). */
  repoPath: string;
  /** Branch to start from (and open the pull request against). "" = the workspace's, else the default branch. */
  baseBranch: string;
  /** The task's own branch, once its worktree was created. */
  branch: string | null;
  /** The task's own git worktree the agent works in, once created. */
  worktree: string | null;
  pullRequest: TaskPullRequest | null;
  /** The agent's final answer (report, summary of the changes). */
  summary: string | null;
  /** Why the task is blocked. */
  blockedReason: string | null;
  /** What Godmode is doing for the task right now ("Cloning the repository…", "Opening the pull request…"). */
  activity: string | null;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
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
}

export interface TaskPatch {
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
}

export interface TaskMessageInput {
  content: string;
  /** Files for the agent (base64), as in chats. */
  attachments?: { name: string; mime: string; data: string }[];
}
