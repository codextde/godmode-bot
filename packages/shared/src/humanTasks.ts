/**
 * Tasks for the human: something an agent can't do itself and the human has to — create a passkey, solve a CAPTCHA,
 * sign a document, pay, call someone, give access. The agent hands it over with `human_task_create` and ends its turn;
 * the task waits on the human's own board ("My tasks"). Once the human marks it done (or says they can't), the agent's
 * chat continues by itself with their note. The human can also add tasks of their own.
 *
 * Whatever else an agent needs from the human lands on the same board (`kind`): a question it asked (`ask_human`), a
 * step it wants an OK for (`request_approval`), and a decision it left open in the answer it finished with.
 *
 * - `open`: waits for the human · `doing`: the human is on it · `done`: they did it (answered, approved)
 * - `declined`: they can't or won't (declined the step, dismissed the decision)
 * - `withdrawn`: the agent took it back, its chat is gone, or the run that asked was stopped.
 */
import type { Attachment, ID, ISODate, QuestionOption } from "./models";

export type HumanTaskStatus = "open" | "doing" | "done" | "declined" | "withdrawn";
export type HumanTaskPriority = "normal" | "high";
/** `task`: something to do · `decision`: a question to answer · `approval`: one step to approve or decline. */
export type HumanTaskKind = "task" | "decision" | "approval";

export const HUMAN_TASK_ACTIVE: readonly HumanTaskStatus[] = ["open", "doing"];

export function isHumanTaskActive(t: Pick<HumanTask, "status">): boolean {
  return t.status === "open" || t.status === "doing";
}

export interface HumanTaskResponse {
  /** What the human wrote when they closed it ("" = nothing). Saved secrets masked. */
  text: string;
  /** The suggested answer they picked. */
  optionId: string | null;
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
  kind: HumanTaskKind;
  /** Suggested answers of a decision ([] = none). The human can always answer in their own words. */
  options: QuestionOption[];
  /** The question it stands for: the agent's run stands still until it is answered, here or in the chat. */
  questionId: ID | null;
  /** Godmode found it in the answer the agent finished with (the agent didn't ask with a tool). */
  fromAnswer: boolean;
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

/**
 * The human closes a task: `done`, or `declined` (they can't or won't). The note goes to the agent. A decision is
 * answered with `done` and a note or one of its options; an approval is approved with `done`, declined with `declined`.
 */
export interface HumanTaskCloseInput {
  outcome: "done" | "declined";
  note?: string;
  /** Decisions: the suggested answer the human picks. */
  optionId?: string;
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

/** The words for a task of each kind: what it is called, what closing it says, and how it reads once closed. */
export const HUMAN_TASK_WORDS: Record<HumanTaskKind, { label: string; done: string; declined: string; wasDone: string; wasDeclined: string }> = {
  task: { label: "Task", done: "Mark done", declined: "Can't do it", wasDone: "Done", wasDeclined: "Couldn't do it" },
  decision: { label: "Decision", done: "Answer", declined: "Dismiss", wasDone: "Answered", wasDeclined: "Dismissed" },
  approval: { label: "Approval", done: "Approve", declined: "Decline", wasDone: "Approved", wasDeclined: "Declined" },
};

/** What the human answered, in words: their note, else the option they picked. */
export function humanTaskAnswer(t: Pick<HumanTask, "response" | "options">): string {
  const r = t.response;
  if (!r) return "";
  return r.text || t.options.find((o) => o.id === r.optionId)?.label || "";
}
