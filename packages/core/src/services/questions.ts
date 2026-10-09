/**
 * Questions and approvals (owner: runner + gateway).
 *
 * An agent that needs the human asks with `ask_human` (a question with suggested answers) or `request_approval` (an OK
 * for one specific step). The run then stands still like a paused run (pause reason `question`, runner.ts `askPause`):
 * nothing that waits for its end is told it ended, and answering continues it in the same run and Claude session with
 * the answer. The question row is written in the same transaction as the pause row (runner.ts `suspend`), so an open
 * question always belongs to a run that stands still for it; stopping that run withdraws it.
 *
 * Only the human answers: through the API (desktop, dashboard, a paired phone), by writing into the chat, or — from
 * Slack, Telegram or Teams — as the platform account marked as the owner. Agents have no tool that answers.
 */
import type {
  AgentQuestion,
  AnswerQuestionInput,
  AnswerVia,
  Attachment,
  Message,
  MessageBlock,
  QuestionAnswer,
  QuestionKind,
  QuestionOption,
  QuestionStatus,
  Run,
  SendMessageInput,
} from "@godmode/shared";
import { RUN_STOPPED_BY_USER, parseSlashCommand } from "@godmode/shared";
import { all, get, insert, run as sql } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, badRequest, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { getAgent } from "../agents/service";
import { askPause, getRun, questionRefusal, resumeRun } from "../runner/runner";
import { describeNow, stripNoteTags, type ContinueAnswer } from "../runner/prompt";
import { audit } from "./audit";
import { getMessage, promptWithFiles, saveAttachments, updateMessage } from "./conversations";
import { hasDeliverable } from "./messageQueue";
import { markRead, notify } from "./notifications";
import { pausedRun } from "./pauses";
import { getSettings } from "./settings";

const log = logger("questions");

/** More than this many questions in one run: the agent decides the rest itself. */
export const MAX_QUESTIONS_PER_RUN = 10;
/** An automation that keeps skipping runs because of an open question reminds the human at most this often. */
const REMIND_EVERY_MS = 24 * 60 * 60_000;
/** How much of a context or an `affects` text goes into a notification. */
const NOTIFY_BODY_MAX = 280;

export type QuestionBlock = Extract<MessageBlock, { type: "question" }>;

/** What a run asked, before it stands still for it (the row is written then). */
export interface PendingQuestion {
  block: QuestionBlock;
  taskId: string | null;
  routineId: string | null;
  workspaceId: string | null;
}

/** The human's answer as the continued run reads it. `questionId`: the question it answers. */
export interface ResumedAnswer extends ContinueAnswer {
  questionId: string;
}

/** Who answers: `actor` for the audit log (`user`, `messaging:<id>`), and where. */
export interface Answerer {
  actor: string;
  via: AnswerVia;
}

interface QuestionRow {
  id: string;
  kind: QuestionKind;
  agent_id: string;
  run_id: string;
  conversation_id: string;
  message_id: string;
  task_id: string | null;
  routine_id: string | null;
  workspace_id: string | null;
  title: string;
  body: string;
  affects: string;
  options: string;
  status: QuestionStatus;
  option_id: string | null;
  answer: string | null;
  answer_attachments: string;
  answered_via: AnswerVia | null;
  answered_at: string | null;
  closed_reason: string | null;
  notification_id: string | null;
  cut_off: number;
  answer_owed: number;
  reminded_at: string | null;
  posted_chat_id: string | null;
  created_at: string;
  updated_at: string;
  conversation_title?: string | null;
  task_number?: number | null;
  routine_name?: string | null;
}

const SELECT = `SELECT q.*, c.title AS conversation_title, t.number AS task_number, r.name AS routine_name
  FROM questions q
  LEFT JOIN conversations c ON c.id = q.conversation_id
  LEFT JOIN tasks t ON t.id = q.task_id
  LEFT JOIN routines r ON r.id = q.routine_id`;

const RESOLVED: ReadonlySet<QuestionStatus> = new Set(["answered", "approved", "declined"]);

function answerOf(r: QuestionRow): QuestionAnswer | null {
  if (!RESOLVED.has(r.status) || !r.answered_at) return null;
  return {
    optionId: r.option_id,
    text: r.answer ?? "",
    attachments: parseJson<Attachment[]>(r.answer_attachments, []),
    at: r.answered_at,
    via: r.answered_via ?? "app",
  };
}

function toQuestion(r: QuestionRow): AgentQuestion {
  return {
    id: r.id,
    kind: r.kind,
    agentId: r.agent_id,
    runId: r.run_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    taskId: r.task_id,
    routineId: r.routine_id,
    workspaceId: r.workspace_id,
    title: r.title,
    body: r.body,
    affects: r.affects,
    options: parseJson<QuestionOption[]>(r.options, []),
    status: r.status,
    answer: answerOf(r),
    closedReason: r.closed_reason,
    conversationTitle: r.conversation_title ?? undefined,
    taskNumber: r.task_number ?? null,
    routineName: r.routine_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function row(id: string): QuestionRow | null {
  return get<QuestionRow>(`${SELECT} WHERE q.id = ?`, id);
}

export function getQuestion(id: string): AgentQuestion {
  const r = row(id);
  if (!r) throw notFound("Question");
  return toQuestion(r);
}

/** `resolved` = answered, approved or declined. */
export type QuestionFilter = QuestionStatus | "resolved" | "all";

export function listQuestions(opts: { status?: QuestionFilter; conversationId?: string; agentId?: string; limit?: number } = {}): AgentQuestion[] {
  const where: string[] = [];
  const params: string[] = [];
  const status = opts.status ?? "all";
  if (status === "resolved") where.push("q.status IN ('answered', 'approved', 'declined')");
  else if (status !== "all") {
    where.push("q.status = ?");
    params.push(status);
  }
  if (opts.conversationId) {
    where.push("q.conversation_id = ?");
    params.push(opts.conversationId);
  }
  if (opts.agentId) {
    where.push("q.agent_id = ?");
    params.push(opts.agentId);
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
  return all<QuestionRow>(
    `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY q.status = 'open' DESC, q.created_at DESC LIMIT ${limit}`,
    ...params,
  ).map(toQuestion);
}

/** The question the chat's run stands still for, if any. */
export function openQuestionOf(conversationId: string): AgentQuestion | null {
  const r = get<QuestionRow>(`${SELECT} WHERE q.conversation_id = ? AND q.status = 'open'`, conversationId);
  return r ? toQuestion(r) : null;
}

export function openQuestionCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'")?.n ?? 0;
}

function emit(q: AgentQuestion, created = false) {
  bus.emit(created ? { type: "question.created", question: q } : { type: "question.updated", question: q });
  bus.changed("questions");
}

function humanName(): string {
  return getSettings().general.userName.trim() || "the human";
}

/** Text from the agent, as it may be stored and shown: saved secrets masked, no Godmode note tags. */
function clean(text: string | undefined, max: number): string {
  return stripNoteTags(redact(text ?? ""))
    .trim()
    .slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */

export type AskInput =
  | { kind: "question"; question: string; context?: string; options?: { label: string; description?: string; recommended?: boolean }[] }
  | { kind: "approval"; action: string; reason: string; affects: string };

/**
 * The gateway's `ask_human` / `request_approval`: put the question on the run, which stands still for it at its next
 * step. Nothing is stored or announced until then. Returns what the tool answers the model.
 */
export function askQuestion(ctx: { runId: string; conversationId: string; workspaceId: string | null }, input: AskInput): { ok: boolean; text: string; id?: string } {
  const human = humanName();
  const refused = questionRefusal(ctx.runId, human);
  if (refused) return { ok: false, text: refused };
  if (hasDeliverable(ctx.conversationId)) {
    return {
      ok: false,
      text: `${human} wrote to you while you were working — the message reaches you right after this step. Read it first: it may already answer this. Ask again afterwards if you still need to.`,
    };
  }
  const asked = get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE run_id = ?", ctx.runId)?.n ?? 0;
  if (asked >= MAX_QUESTIONS_PER_RUN) {
    return { ok: false, text: `You asked ${human} ${MAX_QUESTIONS_PER_RUN} times in this turn. Decide the rest yourself and say what you assumed.` };
  }

  const run = getRun(ctx.runId);
  const id = newId("qst");
  let recommended = false;
  const block: QuestionBlock =
    input.kind === "question"
      ? {
          type: "question",
          id,
          kind: "question",
          title: clean(input.question, 300),
          body: clean(input.context, 2000),
          affects: "",
          options: (input.options ?? []).slice(0, 4).map((o, i) => {
            const mark = !!o.recommended && !recommended;
            if (mark) recommended = true;
            const description = clean(o.description, 300);
            return { id: String(i + 1), label: clean(o.label, 80), ...(description ? { description } : {}), ...(mark ? { recommended: true } : {}) };
          }),
          askedAt: now(),
          status: "open",
        }
      : {
          type: "question",
          id,
          kind: "approval",
          title: clean(input.action, 300),
          body: clean(input.reason, 2000),
          affects: clean(input.affects, 1000),
          options: [],
          askedAt: now(),
          status: "open",
        };
  if (!block.title) return { ok: false, text: "The question is empty." };
  if (block.options.some((o) => !o.label)) return { ok: false, text: "Every suggested answer needs a label." };
  const taskId = get<{ id: string }>("SELECT id FROM tasks WHERE conversation_id = ?", ctx.conversationId)?.id ?? null;
  const pending: PendingQuestion = { block, taskId, routineId: run.routineId, workspaceId: ctx.workspaceId };
  const late = askPause(ctx.runId, pending, human);
  if (late) return { ok: false, text: late };
  return {
    ok: true,
    id,
    text:
      block.kind === "approval"
        ? `Asked ${human} to approve: “${block.title}”. This turn stops here and continues with the decision — don't call any more tools and don't write an answer now.`
        : `Asked ${human}: “${block.title}”. This turn stops here and continues with their answer — don't call any more tools and don't write an answer now.`,
  };
}

/** The row of a question whose run now stands still for it (runner.ts `suspend`, in the pause's transaction). */
export function saveQuestion(
  pending: PendingQuestion,
  run: { runId: string; agentId: string; conversationId: string; messageId: string; cutOff: boolean },
): void {
  const b = pending.block;
  const ts = now();
  insert("questions", {
    id: b.id,
    kind: b.kind,
    agent_id: run.agentId,
    run_id: run.runId,
    conversation_id: run.conversationId,
    message_id: run.messageId,
    task_id: pending.taskId,
    routine_id: pending.routineId,
    workspace_id: pending.workspaceId,
    title: b.title,
    body: b.body,
    affects: b.affects,
    options: JSON.stringify(b.options),
    status: "open",
    cut_off: run.cutOff ? 1 : 0,
    created_at: b.askedAt,
    updated_at: ts,
  });
}

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Where a question leads in the app: its task, else its chat. */
export function questionLink(q: Pick<AgentQuestion, "taskId" | "conversationId">): string {
  return q.taskId ? `/tasks?task=${q.taskId}` : `/chat/${q.conversationId}`;
}

/** Title and body of the notification for a question (also what the desktop toast shows). */
export function questionNotice(q: AgentQuestion, agentName: string): { title: string; body: string } {
  const approval = q.kind === "approval";
  if (q.taskId && q.taskNumber != null) {
    return { title: `Task #${q.taskNumber} needs your ${approval ? "OK" : "answer"}`, body: `${agentName}: ${q.title}` };
  }
  const detail = approval ? q.affects : q.options.length ? q.options.map((o) => o.label).join(" · ") : q.body;
  const body = shorten(detail, NOTIFY_BODY_MAX);
  return {
    title: approval ? `${agentName} needs your OK: ${q.title}` : `${agentName} asks: ${q.title}`,
    body: q.routineName ? `From “${q.routineName}” — ${body}` : body,
  };
}

/** The run stands still for the question now: tell the human (notification, event, audit). */
export function announceQuestion(id: string): void {
  const q = getQuestion(id);
  let agentName = "An agent";
  try {
    agentName = getAgent(q.agentId).name;
  } catch {
    /* agent gone */
  }
  const { title, body } = questionNotice(q, agentName);
  const n = notify("question", title, body, questionLink(q));
  sql("UPDATE questions SET notification_id = ? WHERE id = ?", n.id, id);
  audit(`agent:${q.agentId}`, "question.ask", q.id, { kind: q.kind, title: q.title, runId: q.runId, conversationId: q.conversationId, taskId: q.taskId, routineId: q.routineId });
  emit(q, true);
  log.info("agent asks the human", { questionId: q.id, kind: q.kind, runId: q.runId });
}

/* ------------------------------------------------------------------ */
/* Answering                                                           */
/* ------------------------------------------------------------------ */

function outcomeOf(status: QuestionStatus, optionId: string | null): ContinueAnswer["outcome"] {
  if (status === "approved" || status === "declined") return status;
  return optionId ? "option" : "text";
}

/**
 * The human answers. The run that asked continues at once with the answer (same run, same Claude session); returns
 * the question as answered and that run. 409 when it was answered or withdrawn already, or the run can't continue (the
 * question is open again then).
 */
export function answerQuestion(id: string, input: AnswerQuestionInput, by: Answerer): { question: AgentQuestion; run: Run } {
  const r = row(id);
  if (!r) throw notFound("Question");
  if (r.status !== "open") {
    throw new HttpError(409, r.status === "withdrawn" ? "This was withdrawn — the run was stopped." : "This was answered already.", "question_closed");
  }
  const paused = pausedRun(r.run_id);
  if (!paused || paused.reason !== "question") throw new HttpError(409, "This was withdrawn — the run was stopped.", "question_closed");

  const options = parseJson<QuestionOption[]>(r.options, []);
  const given = [input.optionId !== undefined, input.decision !== undefined, input.text !== undefined].filter(Boolean).length;
  if (given !== 1) throw badRequest("Give exactly one of an option, a decision or a text");
  const files = input.attachments ?? [];
  let status: QuestionStatus;
  let optionId: string | null = null;
  let raw: string;
  if (input.optionId !== undefined) {
    if (r.kind === "approval") throw badRequest("An approval is answered with approve or decline");
    const option = options.find((o) => o.id === input.optionId);
    if (!option) throw badRequest("Unknown option");
    status = "answered";
    optionId = option.id;
    raw = option.label;
  } else if (input.decision !== undefined) {
    if (r.kind !== "approval") throw badRequest("Only an approval is approved or declined");
    status = input.decision === "approve" ? "approved" : "declined";
    raw = (input.note ?? "").trim();
  } else {
    raw = (input.text ?? "").trim();
    if (!raw && !files.length) throw badRequest("The answer is empty");
    status = "answered";
  }

  const agent = getAgent(r.agent_id);
  const attachments = files.length ? saveAttachments(agent, files) : [];
  const ts = now();
  const stored = redact(raw);
  const changed = sql(
    `UPDATE questions SET status = ?, option_id = ?, answer = ?, answer_attachments = ?, answered_via = ?, answered_at = ?, answer_owed = 1,
       updated_at = ? WHERE id = ? AND status = 'open'`,
    status,
    optionId,
    stored,
    JSON.stringify(attachments),
    by.via,
    ts,
    ts,
    id,
  );
  if (!changed.changes) throw new HttpError(409, "This was answered already.", "question_closed");

  const answer: ResumedAnswer = {
    questionId: id,
    kind: r.kind,
    title: r.title,
    options: options.map((o) => o.label),
    askedAt: r.created_at,
    outcome: outcomeOf(status, optionId),
    text: attachments.length ? promptWithFiles(raw, agent, attachments) : raw,
    cutOff: r.cut_off === 1,
  };
  let run: Run;
  try {
    run = resumeRun(paused, "user", answer, { status, optionId, text: stored, attachments, at: ts, via: by.via });
  } catch (err) {
    // The run couldn't continue (agent switched off, shutting down): the question waits for another try.
    sql(
      `UPDATE questions SET status = 'open', option_id = NULL, answer = NULL, answer_attachments = '[]', answered_via = NULL, answered_at = NULL,
         answer_owed = 0, updated_at = ? WHERE id = ?`,
      now(),
      id,
    );
    throw err;
  }
  audit(by.actor, "question.answer", id, {
    kind: r.kind,
    status,
    optionId,
    answer: stored.slice(0, 200),
    via: by.via,
    agentId: r.agent_id,
    runId: r.run_id,
    conversationId: r.conversation_id,
  });
  if (r.notification_id) markRead([r.notification_id]);
  const question = getQuestion(id);
  emit(question);
  log.info("question answered", { questionId: id, status, via: by.via });
  return { question, run };
}

/**
 * How a typed reply answers a question when there are no buttons (a chat platform, the composer, voice): an option's
 * label or its number picks it; for an approval a few plain words approve or decline. Anything else is the human's own
 * words — for an approval the agent is told it is approved only if the message clearly says so.
 */
export function interpretReply(q: Pick<AgentQuestion, "kind" | "options">, text: string, attachments: SendMessageInput["attachments"] = []): AnswerQuestionInput {
  const raw = text.trim();
  if (attachments.length) return { text: raw, attachments };
  const said = raw.toLowerCase().replace(/[\s.!,]+$/u, "").trim();
  if (q.kind === "approval") {
    if (APPROVE.has(said)) return { decision: "approve" };
    if (DECLINE.has(said)) return { decision: "decline" };
    return { text: raw };
  }
  const byLabel = q.options.find((o) => o.label.trim().toLowerCase() === said);
  if (byLabel) return { optionId: byLabel.id };
  if (/^\d$/.test(said)) {
    const byNumber = q.options[Number(said) - 1];
    if (byNumber) return { optionId: byNumber.id };
  }
  return { text: raw };
}

const APPROVE = new Set(["approve", "approved", "yes", "ok", "okay", "go ahead", "do it", "👍", "✅"]);
const DECLINE = new Set(["decline", "declined", "no", "don't", "dont", "don’t", "👎", "❌"]);

/**
 * A message from the human to a chat whose run waits for an answer is that answer. Null when nothing waits, or the
 * message is a slash command (it waits in the queue for the next turn). `message` is the agent's message that asked.
 */
export function answerByMessage(
  conversationId: string,
  input: Pick<SendMessageInput, "content" | "attachments">,
  by: Answerer,
): { message: Message; run: Run; question: AgentQuestion } | null {
  const q = openQuestionOf(conversationId);
  if (!q) return null;
  if (parseSlashCommand(input.content ?? "") !== null) return null;
  const { question, run } = answerQuestion(q.id, interpretReply(q, input.content ?? "", input.attachments ?? []), by);
  return { message: getMessage(q.messageId), run, question };
}

/* ------------------------------------------------------------------ */
/* The block in the agent's message                                     */
/* ------------------------------------------------------------------ */

/** The question block with this id, answered or withdrawn. */
export function settleBlock(
  blocks: MessageBlock[],
  id: string,
  patch: { status: QuestionStatus; answer?: QuestionAnswer | null; closedReason?: string | null },
): MessageBlock[] {
  return blocks.map((b) => (b.type === "question" && b.id === id ? { ...b, ...patch } : b));
}

/** Every question block still open in these blocks, withdrawn (the run stopped before it could wait for the answer). */
export function withdrawOpenBlocks(blocks: MessageBlock[], reason: string | null): MessageBlock[] {
  return blocks.map((b) => (b.type === "question" && b.status === "open" ? { ...b, status: "withdrawn" as const, closedReason: reason } : b));
}

/** Cancel reasons that only say "it was stopped": the card says that itself. */
const PLAIN_STOPS = new Set(["Cancelled", RUN_STOPPED_BY_USER]);

/** The run that waited for the question was stopped (runner.ts `closePaused`): the question is withdrawn. */
export function withdrawQuestion(runId: string, reason: string): void {
  const r = get<QuestionRow>("SELECT * FROM questions WHERE run_id = ? AND status = 'open'", runId);
  if (!r) return;
  const closed = PLAIN_STOPS.has(reason) ? null : reason;
  sql("UPDATE questions SET status = 'withdrawn', closed_reason = ?, answer_owed = 0, updated_at = ? WHERE id = ?", closed, now(), r.id);
  if (r.notification_id) markRead([r.notification_id]);
  audit("system", "question.withdraw", r.id, { reason, runId });
  try {
    emit(getQuestion(r.id));
  } catch {
    /* the chat is being deleted with it */
  }
}

/** After a restart or a restore: every open question has a run that stands still for it, and the other way round. */
export function repairQuestions(): void {
  const orphans = all<QuestionRow>(
    "SELECT * FROM questions WHERE status = 'open' AND run_id NOT IN (SELECT run_id FROM paused_runs WHERE reason = 'question')",
  );
  const why = "Godmode restarted before this was answered.";
  for (const r of orphans) {
    sql("UPDATE questions SET status = 'withdrawn', closed_reason = ?, updated_at = ? WHERE id = ?", why, now(), r.id);
    if (r.notification_id) markRead([r.notification_id]);
    try {
      const message = getMessage(r.message_id);
      updateMessage(r.message_id, { blocks: settleBlock(message.blocks, r.id, { status: "withdrawn", closedReason: why }) });
    } catch {
      /* message gone */
    }
  }
  // A run that stands still for a question nobody can answer anymore is an ordinary paused run: it can be continued.
  sql(
    "UPDATE paused_runs SET reason = 'user' WHERE reason = 'question' AND run_id NOT IN (SELECT run_id FROM questions WHERE status = 'open')",
  );
  if (orphans.length) {
    log.warn(`withdrew ${orphans.length} question(s) whose run no longer waits`);
    bus.changed("questions");
  }
}

/* ------------------------------------------------------------------ */
/* Answers the agent hasn't read yet                                    */
/* ------------------------------------------------------------------ */

function continueAnswerOf(r: QuestionRow): ResumedAnswer {
  const options = parseJson<QuestionOption[]>(r.options, []);
  const attachments = parseJson<Attachment[]>(r.answer_attachments, []);
  let text = r.answer ?? "";
  if (attachments.length) {
    try {
      text = promptWithFiles(text, getAgent(r.agent_id), attachments);
    } catch {
      /* agent gone */
    }
  }
  return {
    questionId: r.id,
    kind: r.kind,
    title: r.title,
    options: options.map((o) => o.label),
    askedAt: r.created_at,
    outcome: outcomeOf(r.status, r.option_id),
    text,
    cutOff: r.cut_off === 1,
  };
}

/**
 * An answer the chat's agent hasn't read: the run that took it broke off (a crash, a restart) before Claude got it.
 * The chat's next run starts with it. Saved secrets in it are masked by then.
 */
export function owedAnswer(conversationId: string): ResumedAnswer | null {
  const r = get<QuestionRow>("SELECT * FROM questions WHERE conversation_id = ? AND answer_owed = 1 ORDER BY answered_at DESC LIMIT 1", conversationId);
  return r ? continueAnswerOf(r) : null;
}

/** Claude has the answer now. */
export function settleOwed(questionId: string): void {
  sql("UPDATE questions SET answer_owed = 0 WHERE id = ?", questionId);
}

/** The human stopped the run that was to read the chat's answer: nothing is owed anymore. */
export function dropOwedAnswers(conversationId: string): void {
  sql("UPDATE questions SET answer_owed = 0 WHERE conversation_id = ? AND answer_owed = 1", conversationId);
}

/* ------------------------------------------------------------------ */
/* Automations that wait                                                */
/* ------------------------------------------------------------------ */

/**
 * An automation skipped a run because its last one waits for the human's answer: remind them, at most once a day (the
 * question itself notified when it was asked).
 */
export function remindWaitingAutomation(routineId: string): void {
  const r = get<QuestionRow & { routine_name: string | null }>(
    `SELECT q.*, r.name AS routine_name FROM questions q LEFT JOIN routines r ON r.id = q.routine_id
     WHERE q.routine_id = ? AND q.status = 'open' ORDER BY q.created_at LIMIT 1`,
    routineId,
  );
  if (!r) return;
  const last = Date.parse(r.reminded_at ?? r.created_at);
  if (Number.isFinite(last) && Date.now() - last < REMIND_EVERY_MS) return;
  const skipped =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM automation_events WHERE routine_id = ? AND status = 'skipped' AND created_at >= ?", routineId, r.created_at)?.n ?? 0;
  const name = r.routine_name ?? "An automation";
  // The reminder takes the place of the earlier notice, so answering the question settles the latest one.
  if (r.notification_id) markRead([r.notification_id]);
  const n = notify(
    "question",
    `“${name}” is waiting for your answer`,
    `Asked ${describeNow(new Date(r.created_at))}: ${shorten(r.title, 200)}${skipped ? ` — ${skipped} run${skipped === 1 ? "" : "s"} skipped since` : ""}.`,
    questionLink({ taskId: r.task_id, conversationId: r.conversation_id }),
  );
  sql("UPDATE questions SET reminded_at = ?, notification_id = ? WHERE id = ?", now(), n.id, r.id);
}
