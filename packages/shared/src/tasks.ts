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
 * - `coding`: Godmode clones the repository onto a fresh branch, the agent changes the code, and Godmode pushes the
 *   branch and opens a pull request when it finishes.
 * - `research`: the agent investigates and answers with a written report.
 */
export type TaskType = "general" | "coding" | "research";

export type PullRequestState = "open" | "merged" | "closed";

export const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
export const TASK_TYPES: readonly TaskType[] = ["general", "coding", "research"];

export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 20_000;

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
  /** Coding: git remote to clone. "" = the workspace's repository. */
  repoUrl: string;
  /** Coding: branch to start from and open the pull request against. "" = the workspace's, else the default branch. */
  baseBranch: string;
  /** Coding: the branch the agent works on, once created. */
  branch: string | null;
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
  baseBranch?: string;
}

export interface TaskMessageInput {
  content: string;
}
