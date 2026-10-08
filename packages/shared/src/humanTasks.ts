/**
 * Tasks for the human: something an agent can't do itself and the human has to — create a passkey, solve a CAPTCHA,
 * sign a document, pay, call someone, give access. The agent hands it over with `human_task_create` and ends its turn;
 * the task waits on the human's own board ("My tasks"). Once the human marks it done (or says they can't), the agent's
 * chat continues by itself with their note. The human can also add tasks of their own.
 *
 * - `open`: waits for the human · `doing`: the human is on it · `done`: they did it · `declined`: they can't or won't
 * - `withdrawn`: the agent took it back, or its chat is gone.
 */
import type { Attachment, ID, ISODate } from "./models";

export type HumanTaskStatus = "open" | "doing" | "done" | "declined" | "withdrawn";
export type HumanTaskPriority = "normal" | "high";

export const HUMAN_TASK_ACTIVE: readonly HumanTaskStatus[] = ["open", "doing"];

export function isHumanTaskActive(t: Pick<HumanTask, "status">): boolean {
  return t.status === "open" || t.status === "doing";
}

export interface HumanTaskResponse {
  /** What the human wrote when they closed it ("" = nothing). Saved secrets masked. */
  text: string;
  attachments: Attachment[];
  at: ISODate;
}

export interface HumanTask {
  id: ID;
  /** Running number, shown as "H-12". */
  number: number;
  /** What to do, as an imperative: "Create a passkey for Google Ads". */
  title: string;
  /** How: exact steps, what the agent found, what it needs back. Markdown. */
  body: string;
  /** Where to do it. */
  url: string | null;
  priority: HumanTaskPriority;
  status: HumanTaskStatus;
  /** The agent that asked; null for the human's own tasks, or when the agent was deleted. */
  agentId: ID | null;
  /** The chat that continues once it is done. null: the human's own task, or the chat was deleted. */
  conversationId: ID | null;
  runId: ID | null;
  /** The board ticket the agent worked on: it waits in Blocked until this is done. */
  taskId: ID | null;
  workspaceId: ID | null;
  response: HumanTaskResponse | null;
  /** Withdrawn: why. */
  closedReason: string | null;
  /** Order within its column. */
  position: number;
  agentName?: string | null;
  conversationTitle?: string | null;
  taskNumber?: number | null;
  startedAt: ISODate | null;
  closedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface HumanTaskInput {
  title: string;
  body?: string;
  url?: string | null;
  priority?: HumanTaskPriority;
  workspaceId?: ID | null;
}

/** The human moves a task (to Doing, back to To do, within a column) or edits their own. */
export interface HumanTaskPatch {
  status?: "open" | "doing";
  /** Lands before this task in its column (null = at the end). */
  beforeId?: ID | null;
  title?: string;
  body?: string;
  url?: string | null;
  priority?: HumanTaskPriority;
}

/** The human closes a task: `done`, or `declined` (they can't or won't). The note goes to the agent. */
export interface HumanTaskCloseInput {
  outcome: "done" | "declined";
  note?: string;
  attachments?: { name: string; mime: string; data: string }[];
}

export interface HumanTaskCloseResult {
  task: HumanTask;
  /** The agent's chat continues with it (a run started, or the message waits in the chat's queue). */
  continued: boolean;
  /** Why the agent couldn't continue (switched off, deleted, its chat is gone). */
  notContinued?: string;
}

export function humanTaskRef(t: Pick<HumanTask, "number">): string {
  return `H-${t.number}`;
}
