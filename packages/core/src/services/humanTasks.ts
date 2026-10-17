/**
 * Tasks for the human (see HumanTask): an agent that can't go on until the human does something hands it over with
 * `human_task_create` and ends its turn. The task waits on the human's board; closing it (done, or "can't do it")
 * continues the agent's chat with the human's note — straight away when the chat is idle, through the chat's queue
 * while the agent works there. A board ticket waits in Blocked meanwhile (tasks/service.ts `finished`).
 *
 * The board also holds what else waits for the human's word:
 * - every open question and approval (`ask_human`, `request_approval`) as a ticket of its own. It stands for the
 *   question (`question_id`): answering either one answers both, and the run that stands still continues.
 * - a decision an agent left open in the answer it finished with (`from_answer`, runner/openDecision.ts). Answering it
 *   continues the chat; writing into the chat answers it too.
 */
import type {
  Agent,
  AgentQuestion,
  AnswerQuestionInput,
  Attachment,
  HumanTask,
  HumanTaskCloseInput,
  HumanTaskCloseResult,
  HumanTaskInput,
  HumanTaskKind,
  HumanTaskPatch,
  HumanTaskPriority,
  HumanTaskStatus,
  MessageBlock,
  QuestionOption,
} from "@godmode/shared";
import { humanTaskRef, parseSlashCommand } from "@godmode/shared";
import { config } from "../config";
import { all, get, insert, run as sql } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { getAgent } from "../agents/service";
import { activeRunForConversation } from "../runner/runner";
import { describeNow, stripNoteTags } from "../runner/prompt";
import { detectOpenDecision } from "../runner/openDecision";
import { audit } from "./audit";
import { conversationExists, promptWithFiles, saveAttachments, sendMessage } from "./conversations";
import { hasQueued, submitMessage } from "./messageQueue";
import { markRead, notify } from "./notifications";
import { pauseOf } from "./pauses";
import { answerQuestion, getQuestion, listQuestions, type Answerer } from "./questions";
import { getSettings } from "./settings";
import { noteHumanTask } from "../tasks/service";

const log = logger("human-tasks");

/** Open tasks one chat may have at a time. */
export const MAX_OPEN_PER_CHAT = 5;
/** Closed tasks the board lists (newest first). */
const CLOSED_LIMIT = 60;
const POSITION_STEP = 1024;
/** How long an answered decision keeps a new one that asks the same off the list. */
const DECISION_MEMORY_MS = 3 * 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string | null;
  priority: HumanTaskPriority;
  status: HumanTaskStatus;
  kind: HumanTaskKind;
  options: string;
  question_id: string | null;
  from_answer: number;
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  response: string | null;
  response_option: string | null;
  response_attachments: string;
  closed_reason: string | null;
  notification_id: string | null;
  position: number;
  started_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  agent_name?: string | null;
  conversation_title?: string | null;
  task_number?: number | null;
}

const SELECT = `SELECT h.*, a.name AS agent_name, c.title AS conversation_title, t.number AS task_number
  FROM human_tasks h
  LEFT JOIN agents a ON a.id = h.agent_id
  LEFT JOIN conversations c ON c.id = h.conversation_id
  LEFT JOIN tasks t ON t.id = h.task_id`;

const ACTIVE_SQL = "('backlog', 'open', 'doing')";

const isActive = (status: string) => status === "backlog" || status === "open" || status === "doing";

function toHumanTask(r: Row): HumanTask {
  const closed = r.status === "done" || r.status === "declined";
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    body: r.body,
    url: r.url,
    priority: r.priority,
    status: r.status,
    kind: r.kind,
    options: parseJson<QuestionOption[]>(r.options, []),
    questionId: r.question_id,
    fromAnswer: r.from_answer === 1,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    runId: r.run_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    response:
      closed && r.closed_at
        ? { text: r.response ?? "", optionId: r.response_option, attachments: parseJson<Attachment[]>(r.response_attachments, []), at: r.closed_at }
        : null,
    closedReason: r.closed_reason,
    position: r.position,
    agentName: r.agent_name ?? null,
    conversationTitle: r.conversation_title ?? null,
    taskNumber: r.task_number ?? null,
    startedAt: r.started_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function row(id: string): Row | null {
  return get<Row>(`${SELECT} WHERE h.id = ?`, id);
}

function requireRow(id: string): Row {
  const r = row(id);
  if (!r) throw notFound("Task");
  return r;
}

export function getHumanTask(id: string): HumanTask {
  return toHumanTask(requireRow(id));
}

/** By id, or by its number ("H-12", "12"). */
export function findHumanTask(ref: string): HumanTask {
  const r = ref.trim();
  const n = /^(?:H-?)?(\d+)$/i.exec(r);
  const found = n ? get<Row>(`${SELECT} WHERE h.number = ?`, Number(n[1])) : row(r);
  if (!found) throw notFound(`Task ${r}`);
  return toHumanTask(found);
}

/** `active` = in the backlog, open or doing; `closed` = done, declined or withdrawn (the latest ones). */
export type HumanTaskFilter = "active" | "closed" | "all";

export function listHumanTasks(opts: { status?: HumanTaskFilter; conversationId?: string; agentId?: string } = {}): HumanTask[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.conversationId) {
    where.push("h.conversation_id = ?");
    params.push(opts.conversationId);
  }
  if (opts.agentId) {
    where.push("h.agent_id = ?");
    params.push(opts.agentId);
  }
  const scope = where.length ? ` AND ${where.join(" AND ")}` : "";
  const status = opts.status ?? "all";
  const active = status === "closed" ? [] : all<Row>(`${SELECT} WHERE h.status IN ${ACTIVE_SQL}${scope} ORDER BY h.position, h.number`, ...params);
  const closed =
    status === "active"
      ? []
      : all<Row>(`${SELECT} WHERE h.status NOT IN ${ACTIVE_SQL}${scope} ORDER BY COALESCE(h.closed_at, h.updated_at) DESC LIMIT ${CLOSED_LIMIT}`, ...params);
  return [...active, ...closed].map(toHumanTask);
}

export function openHumanTasksOf(conversationId: string): HumanTask[] {
  return listHumanTasks({ status: "active", conversationId });
}

export function activeHumanTaskCount(): number {
  return get<{ n: number }>(`SELECT COUNT(*) AS n FROM human_tasks WHERE status IN ${ACTIVE_SQL}`)?.n ?? 0;
}

function changed() {
  bus.changed("human-tasks");
}

function humanName(): string {
  return getSettings().general.userName.trim() || "the human";
}

/** Text an agent wrote, as it may be stored and shown: saved secrets masked, no Godmode note tags. */
function clean(text: string | undefined | null, max: number): string {
  return stripNoteTags(redact(text ?? ""))
    .trim()
    .slice(0, max);
}

function cleanUrl(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw badRequest(`"${u}" is not a link — give a full http(s) address`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("Only http(s) links");
  return redact(parsed.toString()).slice(0, 2000);
}

function topPosition(status: HumanTaskStatus, selfId?: string): number {
  const top = get<{ p: number | null }>("SELECT MIN(position) AS p FROM human_tasks WHERE status = ? AND id IS NOT ?", status, selfId ?? null)?.p;
  return top == null ? POSITION_STEP : top - POSITION_STEP;
}

function positionIn(status: HumanTaskStatus, beforeId: string | null, selfId: string): number {
  const siblings = all<{ id: string; position: number }>("SELECT id, position FROM human_tasks WHERE status = ? AND id != ? ORDER BY position, number", status, selfId);
  const idx = beforeId ? siblings.findIndex((s) => s.id === beforeId) : -1;
  if (idx < 0) return (siblings.at(-1)?.position ?? 0) + POSITION_STEP;
  const next = siblings[idx]!.position;
  const prev = idx > 0 ? siblings[idx - 1]!.position : next - 2 * POSITION_STEP;
  if (next - prev > 1e-6) return (prev + next) / 2;
  siblings.forEach((s, i) => sql("UPDATE human_tasks SET position = ? WHERE id = ?", (i + 1) * POSITION_STEP, s.id));
  return idx * POSITION_STEP + POSITION_STEP / 2;
}

function nextNumber(): number {
  return (get<{ n: number | null }>("SELECT MAX(number) AS n FROM human_tasks")?.n ?? 0) + 1;
}

/* ------------------------------------------------------------------ */
/* Creating                                                            */
/* ------------------------------------------------------------------ */

/** Where an agent's task comes from: its run and chat. */
export interface HumanTaskOrigin {
  agentId: string;
  conversationId: string;
  runId: string;
  workspaceId: string | null;
}

/** A new row on the board, on top of To do. Returns its id. */
function add(fields: {
  title: string;
  body: string;
  url?: string | null;
  priority?: HumanTaskPriority;
  kind?: HumanTaskKind;
  options?: QuestionOption[];
  questionId?: string | null;
  fromAnswer?: boolean;
  agentId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
  createdAt?: string;
  status?: "backlog" | "open";
}): string {
  const id = newId("htk");
  const ts = now();
  insert("human_tasks", {
    id,
    number: nextNumber(),
    title: fields.title,
    body: fields.body,
    url: fields.url ?? null,
    priority: fields.priority === "high" ? "high" : "normal",
    status: fields.status ?? "open",
    kind: fields.kind ?? "task",
    options: JSON.stringify(fields.options ?? []),
    question_id: fields.questionId ?? null,
    from_answer: fields.fromAnswer ? 1 : 0,
    agent_id: fields.agentId ?? null,
    conversation_id: fields.conversationId ?? null,
    run_id: fields.runId ?? null,
    task_id: fields.taskId ?? null,
    workspace_id: fields.workspaceId ?? null,
    position: topPosition(fields.status ?? "open"),
    created_at: fields.createdAt ?? ts,
    updated_at: ts,
  });
  return id;
}

function ticketOf(conversationId: string): { id: string; workspace_id: string | null } | null {
  return get<{ id: string; workspace_id: string | null }>("SELECT id, workspace_id FROM tasks WHERE conversation_id = ?", conversationId);
}

/* ------------------------------------------------------------------ */
/* The same thing twice                                                */
/* ------------------------------------------------------------------ */

const FILLER = new Set(
  (
    "a an the and or but if then than so to of in on at by for from with without into onto about as is are was were be been being it its this that these those " +
    "i me my we our us you your he she they them their his her do does did done can could should shall may might must will would please again still now " +
    "just also not no yes there here what which who when where how why up down out over one ein eine einen einem einer der die das den dem des und oder aber " +
    "wenn dann zu von im in am an auf mit für fuer ohne ist sind war bitte noch jetzt schon auch nicht ja nein ich du sie wir ihr er es mir dir uns euch"
  ).split(" "),
);

function words(text: string): Set<string> {
  const plain = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d)[.,'](?=\d{3}\b)/g, "$1")
    .replace(/['’]s\b/g, "");
  return new Set((plain.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !FILLER.has(w) && (w.length > 1 || /\d/.test(w))));
}

/** Two titles that ask for the same thing: (nearly) all words of the shorter one are in the longer one. */
export function sameAsk(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (!small.size) return false;
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  if (shared === small.size && small.size === big.size) return true;
  return shared >= 3 && shared / small.size >= 0.8;
}

/** "H-12" mentions in a text that are tasks on the list. */
function mentionedTasks(text: string): Row[] {
  const numbers = [...new Set([...text.matchAll(/\bH-(\d{1,6})\b/g)].map((m) => Number(m[1])))];
  return numbers.map((n) => get<Row>(`${SELECT} WHERE h.number = ?`, n)).filter((r): r is Row => !!r);
}

/** A task on the human's list that already asks for this: open (or in the backlog, or being done), or answered since `since`. */
export function findSameHumanTask(title: string, opts: { since?: string; except?: string[] } = {}): HumanTask | null {
  const skip = new Set(opts.except ?? []);
  const rows = all<Row>(
    `${SELECT} WHERE h.status IN ${ACTIVE_SQL}${opts.since ? " OR (h.status IN ('done', 'declined') AND h.closed_at >= ?)" : ""} ORDER BY CASE WHEN h.status IN ${ACTIVE_SQL} THEN 0 ELSE 1 END, h.number DESC`,
    ...(opts.since ? [opts.since] : []),
  );
  const hit = rows.find((r) => !skip.has(r.id) && sameAsk(title, r.title));
  return hit ? toHumanTask(hit) : null;
}

/** Why an agent in this chat shouldn't put this on the list again, or null. A decision its own answer left open here doesn't count: asking it properly takes its place. */
export function duplicateAsk(conversationId: string, title: string): string | null {
  const same = findSameHumanTask(clean(title, 300), { except: openFromAnswer(conversationId).map((r) => r.id) });
  if (!same) return null;
  const ref = humanTaskRef(same);
  return `${alreadyThere(same)}. Don't add it a second time: work with ${ref}, and if your work waits for it, say so in your answer and mention ${ref}.`;
}

function alreadyThere(t: HumanTask): string {
  const from = [t.agentName, t.conversationTitle ? `chat "${t.conversationTitle}"` : ""].filter(Boolean).join(", ");
  return `${humanTaskRef(t)} “${t.title}” is already on ${humanName()}'s list${from ? ` (${from})` : ""}`;
}

/** The gateway's `human_task_create`. */
export function createAgentHumanTask(origin: HumanTaskOrigin, input: HumanTaskInput): HumanTask {
  const agent = getAgent(origin.agentId);
  const title = clean(input.title, 200);
  if (!title) throw badRequest("Say what to do (title).");
  const twice = duplicateAsk(origin.conversationId, title);
  if (twice) throw conflict(twice);
  const open =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM human_tasks WHERE conversation_id = ? AND question_id IS NULL AND from_answer = 0 AND status IN ${ACTIVE_SQL}`,
      origin.conversationId,
    )?.n ?? 0;
  if (open >= MAX_OPEN_PER_CHAT) {
    throw conflict(`${humanName()} already has ${open} open tasks from this chat. Wait for them, or take one back with human_task_cancel.`);
  }
  const ticket = ticketOf(origin.conversationId);
  const id = add({
    title,
    body: clean(input.body, 6000),
    url: cleanUrl(input.url),
    priority: input.priority,
    agentId: agent.id,
    conversationId: origin.conversationId,
    runId: origin.runId,
    taskId: ticket?.id ?? null,
    workspaceId: ticket?.workspace_id ?? origin.workspaceId ?? agent.workspaceId ?? null,
  });
  const task = getHumanTask(id);
  const n = notify("question", `${agent.name} has a task for you`, `${humanTaskRef(task)} ${title}`, `/my-tasks?task=${id}`);
  sql("UPDATE human_tasks SET notification_id = ? WHERE id = ?", n.id, id);
  if (task.taskId) noteHumanTask(task.taskId, "asked", `agent:${agent.id}`, { body: title, questionId: id, runId: origin.runId });
  audit(`agent:${agent.id}`, "human_task.create", id, { title, runId: origin.runId, conversationId: origin.conversationId, taskId: task.taskId });
  changed();
  log.info("agent gave the human a task", { id, agentId: agent.id });
  return task;
}

/** The human adds a task of their own (nobody continues when it is closed). */
export function createOwnHumanTask(input: HumanTaskInput): HumanTask {
  const title = redact(input.title ?? "").trim().slice(0, 200);
  if (!title) throw badRequest("Say what to do");
  const id = add({ title, body: redact(input.body ?? "").slice(0, 6000), url: cleanUrl(input.url), priority: input.priority, workspaceId: input.workspaceId ?? null, status: input.status === "backlog" ? "backlog" : "open" });
  changed();
  return getHumanTask(id);
}

/* ------------------------------------------------------------------ */
/* Decisions an answer left open                                       */
/* ------------------------------------------------------------------ */

/** A run that finished with an answer. */
export interface FinishedRun extends HumanTaskOrigin {
  /** The human wrote the message it answered and reads the answer in the chat: the ticket needs no notification. */
  attended: boolean;
}

/** The human's board is on the computer a runner works for: a runner keeps no tickets of its own for what it finds. */
const onRunner = () => config().role === "runner";

function withdraw(r: Pick<Row, "id" | "notification_id">, reason: string | null): void {
  const ts = now();
  sql("UPDATE human_tasks SET status = 'withdrawn', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?", reason, ts, ts, r.id);
  if (r.notification_id) markRead([r.notification_id]);
}

function openFromAnswer(conversationId: string): Row[] {
  return all<Row>(`SELECT * FROM human_tasks WHERE conversation_id = ? AND from_answer = 1 AND status IN ${ACTIVE_SQL} ORDER BY number`, conversationId);
}

/**
 * A run finished with this answer. A decision it leaves for the human without having asked with a tool
 * (runner/openDecision.ts) goes on their list, so the work doesn't look finished while it waits for a word nobody was
 * asked for. One per chat: a later answer's decision takes the place of an earlier one.
 */
export function noteOpenDecision(run: FinishedRun, answer: string): HumanTask | null {
  if (onRunner()) return null;
  // The run gave the human something itself: that is what it waits for.
  const handed = get<{ n: number }>(`SELECT COUNT(*) AS n FROM human_tasks WHERE run_id = ? AND from_answer = 0 AND status IN ${ACTIVE_SQL}`, run.runId)?.n ?? 0;
  const found = handed ? null : detectOpenDecision(answer, getSettings().general.userName);
  const title = found ? clean(found.title, 200) : "";
  const earlier = openFromAnswer(run.conversationId);
  if (!found || !title) {
    // The human wrote, the agent answered, and the answer no longer asks: the chat has moved past the earlier one.
    if (run.attended && earlier.length) {
      for (const e of earlier) withdraw(e, "The chat went on without it.");
      changed();
    }
    return null;
  }
  const same = earlier.find((e) => sameAsk(e.title, title));
  for (const e of earlier) if (e !== same) withdraw(e, "A later answer took its place.");
  if (same) {
    if (earlier.length > 1) changed();
    return getHumanTask(same.id);
  }
  // A report that lists what is already open ("H-12 and H-14 are still open"), or a decision the list already holds
  // or the human answered lately: no second ticket for it.
  const mentioned = mentionedTasks(title).length > 0;
  const since = new Date(Date.now() - DECISION_MEMORY_MS).toISOString();
  if (mentioned || findSameHumanTask(title, { since })) {
    if (earlier.length) changed();
    return null;
  }
  const agent = getAgent(run.agentId);
  const ticket = ticketOf(run.conversationId);
  const id = add({
    title,
    body: clean(found.body, 6000),
    kind: "decision",
    fromAnswer: true,
    agentId: agent.id,
    conversationId: run.conversationId,
    runId: run.runId,
    taskId: ticket?.id ?? null,
    workspaceId: ticket?.workspace_id ?? run.workspaceId ?? agent.workspaceId ?? null,
  });
  const task = getHumanTask(id);
  if (!run.attended) {
    const n = notify("question", `${agent.name} left you a decision`, `${humanTaskRef(task)} ${title}`, `/my-tasks?task=${id}`);
    sql("UPDATE human_tasks SET notification_id = ? WHERE id = ?", n.id, id);
  }
  if (task.taskId) noteHumanTask(task.taskId, "asked", `agent:${agent.id}`, { body: title, questionId: id, runId: run.runId, kind: "question" });
  audit(`agent:${agent.id}`, "human_task.found", id, { title, runId: run.runId, conversationId: run.conversationId, taskId: task.taskId });
  changed();
  log.info("an answer left a decision for the human", { id, agentId: agent.id, runId: run.runId });
  return task;
}

/**
 * The human writes into the chat: that answers the decision its agent left open there. The message is the turn that
 * continues the work, so nothing else is started. Call this before the message is sent and the function it returns
 * once it is on its way: a message that couldn't be sent answers nothing, and a decision the new turn leaves open is
 * not the one this message answered.
 */
export function replySettles(conversationId: string, text: string | undefined): () => void {
  const open = parseSlashCommand(text ?? "") !== null ? [] : openFromAnswer(conversationId);
  return () => {
    if (!open.length) return;
    const ts = now();
    const said = redact((text ?? "").trim()).slice(0, 20_000);
    for (const r of open) {
      const done = sql(
        `UPDATE human_tasks SET status = 'done', response = ?, closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status IN ${ACTIVE_SQL}`,
        said,
        "Answered in the chat.",
        ts,
        ts,
        r.id,
      );
      if (!done.changes) continue;
      if (r.notification_id) markRead([r.notification_id]);
      audit("user", "human_task.close", r.id, { outcome: "done", via: "chat", conversationId });
    }
    changed();
  };
}

/* ------------------------------------------------------------------ */
/* Questions and approvals                                             */
/* ------------------------------------------------------------------ */

function questionBody(q: AgentQuestion): string {
  if (q.kind !== "approval") return q.body;
  return [q.body, q.affects ? `**What it changes:** ${q.affects}` : ""].filter(Boolean).join("\n\n");
}

/** An agent asked (`ask_human`, `request_approval`): the question also waits on the board, as a ticket that stands for it. */
function mirrorQuestion(q: AgentQuestion): void {
  if (q.status !== "open" || get("SELECT 1 FROM human_tasks WHERE question_id = ?", q.id)) return;
  add({
    title: q.title,
    body: questionBody(q),
    kind: q.kind === "approval" ? "approval" : "decision",
    options: q.options,
    questionId: q.id,
    agentId: q.agentId,
    conversationId: q.conversationId,
    runId: q.runId,
    taskId: q.taskId,
    workspaceId: q.workspaceId,
    createdAt: q.createdAt,
  });
  changed();
}

/** The question was answered (anywhere) or withdrawn: so is its ticket. */
function settleMirror(q: AgentQuestion): void {
  if (q.status === "open") return;
  const r = get<Row>(`SELECT * FROM human_tasks WHERE question_id = ? AND status IN ${ACTIVE_SQL}`, q.id);
  if (!r) return;
  if (q.status === "withdrawn" || !q.answer) withdraw(r, q.closedReason ?? "The run that asked was stopped.");
  else {
    sql(
      "UPDATE human_tasks SET status = ?, response = ?, response_option = ?, response_attachments = ?, closed_at = ?, updated_at = ? WHERE id = ?",
      q.status === "declined" ? "declined" : "done",
      q.answer.text,
      q.answer.optionId,
      JSON.stringify(q.answer.attachments),
      q.answer.at,
      now(),
      r.id,
    );
  }
  changed();
}

/** After a start: every open question has its ticket, and no ticket waits for a question that is closed. */
function syncQuestions(): void {
  for (const q of listQuestions({ status: "open", limit: 500 })) {
    safely(() => mirrorQuestion(q));
  }
  for (const r of all<Row>(`SELECT * FROM human_tasks WHERE question_id IS NOT NULL AND status IN ${ACTIVE_SQL}`)) {
    safely(() => {
      let q: AgentQuestion | null = null;
      try {
        q = getQuestion(r.question_id!);
      } catch {
        q = null;
      }
      if (q) settleMirror(q);
      else {
        withdraw(r, "The run that asked is gone.");
        changed();
      }
    });
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn("could not keep a question's ticket in step", err);
  }
}

/** The human answers a question from its ticket: the run that stands still for it continues. */
function answerFromTicket(r: Row, input: HumanTaskCloseInput, by: Answerer): HumanTaskCloseResult {
  const note = (input.note ?? "").trim();
  const files = input.attachments ?? [];
  let answer: AnswerQuestionInput;
  if (r.kind === "approval") answer = { decision: input.outcome === "done" ? "approve" : "decline", ...(note ? { note } : {}) };
  else if (input.outcome === "declined") throw badRequest("The agent stands still until you answer. If the question no longer matters, stop it in its chat.");
  else if (input.optionId && !note && !files.length) answer = { optionId: input.optionId };
  else {
    const picked = input.optionId ? parseJson<QuestionOption[]>(r.options, []).find((o) => o.id === input.optionId)?.label : "";
    answer = { text: [picked, note].filter(Boolean).join("\n\n"), ...(files.length ? { attachments: files } : {}) };
  }
  const { question } = answerQuestion(r.question_id!, answer, by);
  settleMirror(question);
  return { task: getHumanTask(r.id), continued: true };
}

/* ------------------------------------------------------------------ */
/* Moving and editing                                                  */
/* ------------------------------------------------------------------ */

export function updateHumanTask(id: string, patch: HumanTaskPatch): HumanTask {
  const r = requireRow(id);
  const active = isActive(r.status);
  const sets: Record<string, string | number | null> = {};
  if (patch.status !== undefined || patch.beforeId !== undefined) {
    if (!active) throw conflict("This task is closed already");
    const status = patch.status ?? r.status;
    sets.status = status;
    sets.position = patch.beforeId === undefined && status !== r.status ? topPosition(status, id) : positionIn(status, patch.beforeId ?? null, id);
    if (status === "doing" && !r.started_at) sets.started_at = now();
    // Parked for later: its notification no longer waits to be read.
    if (status === "backlog" && r.status !== "backlog" && r.notification_id) markRead([r.notification_id]);
  }
  const own = !r.agent_id && !r.run_id;
  if (patch.title !== undefined || patch.body !== undefined || patch.url !== undefined) {
    if (!own) throw badRequest("An agent's task keeps its words — close it with a note instead");
    if (patch.title !== undefined) {
      const title = redact(patch.title).trim().slice(0, 200);
      if (!title) throw badRequest("Say what to do");
      sets.title = title;
    }
    if (patch.body !== undefined) sets.body = redact(patch.body).slice(0, 6000);
    if (patch.url !== undefined) sets.url = cleanUrl(patch.url);
  }
  if (patch.priority !== undefined) sets.priority = patch.priority === "high" ? "high" : "normal";
  const keys = Object.keys(sets);
  if (!keys.length) return toHumanTask(r);
  sql(`UPDATE human_tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => sets[k]!), now(), id);
  changed();
  return getHumanTask(id);
}

export function deleteHumanTask(id: string): void {
  const r = requireRow(id);
  if (r.question_id && isActive(r.status)) throw badRequest("The agent stands still for this question. Answer it, or stop the agent in its chat.");
  sql("DELETE FROM human_tasks WHERE id = ?", id);
  if (r.notification_id) markRead([r.notification_id]);
  audit("user", "human_task.delete", id, { title: r.title });
  changed();
}

/* ------------------------------------------------------------------ */
/* Closing: the agent continues                                        */
/* ------------------------------------------------------------------ */

/**
 * The human closes a task. The agent that gave it continues its chat with the outcome and the note. A ticket that
 * stands for a question answers it (the run that asked continues); a decision found in an answer continues the chat
 * with the answer, or is dismissed without waking anyone.
 */
export async function closeHumanTask(id: string, input: HumanTaskCloseInput, by: Answerer = { actor: "user", via: "app" }): Promise<HumanTaskCloseResult> {
  const r = requireRow(id);
  if (!isActive(r.status)) throw conflict(r.status === "withdrawn" ? "The agent took this task back already." : "This task is closed already.");
  if (r.question_id) return answerFromTicket(r, input, by);
  const note = (input.note ?? "").trim().slice(0, 20_000);
  const files = input.attachments ?? [];
  const decision = r.kind === "decision";
  const option = decision && input.optionId ? (parseJson<QuestionOption[]>(r.options, []).find((o) => o.id === input.optionId) ?? null) : null;
  if (decision && input.optionId && !option) throw badRequest("Unknown option");
  if (decision && input.outcome === "done" && !note && !option && !files.length) throw badRequest("Write your answer first.");

  let agent: Agent | null = null;
  try {
    agent = r.agent_id ? getAgent(r.agent_id) : null;
  } catch {
    agent = null;
  }
  const attachments = files.length && agent ? saveAttachments(agent, files) : [];
  if (files.length && !agent) throw badRequest("Files go to the agent that gave you the task — this one has none");

  const ts = now();
  const done = sql(
    `UPDATE human_tasks SET status = ?, response = ?, response_option = ?, response_attachments = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status IN ${ACTIVE_SQL}`,
    input.outcome,
    redact(note),
    option?.id ?? null,
    JSON.stringify(attachments),
    ts,
    ts,
    id,
  );
  if (!done.changes) throw conflict("This task is closed already.");
  if (r.notification_id) markRead([r.notification_id]);
  const said = [option?.label, note].filter(Boolean).join("\n\n");
  if (r.task_id) {
    noteHumanTask(r.task_id, "answered", "user", { body: redact(said), questionId: id, status: decision && input.outcome === "done" ? "answered" : input.outcome, ...(decision ? { kind: "question" as const } : {}) });
  }
  audit(by.actor, "human_task.close", id, { outcome: input.outcome, note: redact(said).slice(0, 200), agentId: r.agent_id, conversationId: r.conversation_id });
  changed();
  // Dismissed: the agent didn't wait for it, so nobody is woken.
  if (decision && input.outcome === "declined") return { task: getHumanTask(id), continued: false };

  let continued = false;
  let notContinued: string | undefined;
  try {
    const why = await continueAgent(r, agent, input.outcome, said, attachments);
    if (why === null) continued = true;
    else notContinued = why || undefined;
  } catch (err) {
    notContinued = err instanceof Error ? err.message : String(err);
    log.warn(`task ${id}: the agent couldn't continue`, err);
  }
  return { task: getHumanTask(id), continued, ...(notContinued ? { notContinued } : {}) };
}

/** Null when the chat continues; otherwise why not ("" = the human's own task, nothing to continue). */
async function continueAgent(r: Row, agent: Agent | null, outcome: "done" | "declined", note: string, attachments: Attachment[]): Promise<string | null> {
  if (!r.agent_id && !r.run_id) return "";
  if (!agent) return "The agent that gave you this task was deleted.";
  if (!r.conversation_id || !conversationExists(r.conversation_id)) return `${agent.name}'s chat for it was deleted.`;
  if (!agent.enabled) return `${agent.name} is switched off — turn it on and tell it in the chat.`;
  const ticket = get<{ number: number; status: string; archived_at: string | null }>("SELECT number, status, archived_at FROM tasks WHERE conversation_id = ?", r.conversation_id);
  if (ticket && (ticket.archived_at || ticket.status === "cancelled")) return `Task #${ticket.number} was ${ticket.archived_at ? "archived" : "cancelled"}, so ${agent.name} doesn't pick it up.`;

  const conversationId = r.conversation_id;
  const ref = `H-${r.number}`;
  const decision = r.kind === "decision";
  const head = decision ? `Answer to ${ref} ${r.title}` : outcome === "done" ? `Done: ${ref} ${r.title}` : `Can't do: ${ref} ${r.title}`;
  const others = openHumanTasksOf(conversationId).filter((t) => t.id !== r.id);

  // The agent is at work in the chat (or its run stands still): the message waits in the queue and reaches it there.
  if (activeRunForConversation(conversationId) || pauseOf(conversationId) || hasQueued(conversationId)) {
    const text = promptWithFiles(note ? `${head}\n\n${note}` : head, agent, attachments);
    await submitMessage(conversationId, { content: text });
    return null;
  }

  const human = humanName();
  const said = note ? `Their note:\n${stripNoteTags(note)}` : "They added no note.";
  const stillOpen = others.length ? `\nStill open for ${human}: ${others.map((t) => `${humanTaskRef(t)} “${t.title}”`).join(", ")}.` : "";
  const prompt = decision
    ? `<godmode-human-task>
Your answer of ${describeNow(new Date(r.created_at))} left this for ${human} to decide: “${r.title}”. Godmode put it on their task list as ${ref}, and ${human} answered:
${stripNoteTags(note) || "(only the attached files)"}
Act on the answer and pick the work up where you left off. It settles this question and nothing else.${stillOpen}
</godmode-human-task>`
    : `<godmode-human-task>
You gave ${human} a task on ${describeNow(new Date(r.created_at))}: ${ref} “${r.title}”. ${outcome === "done" ? `${human} marked it done.` : `${human} says they can't do it.`}
${said}
${
  outcome === "done"
    ? "Check that it worked where you can, then pick the work up where you left off."
    : "Find another way if there is one; otherwise finish what you can and say plainly what stays undone without it."
}${stillOpen}
</godmode-human-task>`;
  const block: MessageBlock = { type: "human_task", id: r.id, number: r.number, title: r.title, outcome, note: redact(note), at: now(), ...(decision ? { kind: "decision" as const } : {}) };
  await sendMessage(conversationId, {
    content: note ? `${head}\n\n${note}` : head,
    prompt,
    marker: [block],
    files: attachments,
    trigger: ticket ? "task" : "chat",
    source: ticket ? "task" : undefined,
    byHuman: true,
  });
  return null;
}

/** The agent takes a task back: it isn't needed anymore. */
export function withdrawHumanTask(id: string, reason: string, by: { agentId: string }): HumanTask {
  const r = requireRow(id);
  if (r.agent_id !== by.agentId) throw badRequest(`${humanTaskRef(r)} isn't one you gave`);
  if (!isActive(r.status)) throw conflict(`${humanTaskRef(r)} is ${r.status} already`);
  if (r.question_id) throw badRequest(`${humanTaskRef(r)} is your question to the human: it waits for their answer`);
  const why = clean(reason, 500) || null;
  withdraw(r, why);
  audit(`agent:${by.agentId}`, "human_task.withdraw", id, { reason: why });
  changed();
  return getHumanTask(id);
}

/** An agent's tasks whose chat (and so the agent's work) is gone: nobody waits for them anymore. */
function withdrawOrphans(): void {
  const gone = all<{ id: string; notification_id: string | null }>(
    `SELECT id, notification_id FROM human_tasks WHERE status IN ${ACTIVE_SQL} AND run_id IS NOT NULL AND conversation_id IS NULL`,
  );
  if (!gone.length) return;
  for (const g of gone) withdraw(g, "The chat it was for was deleted.");
  changed();
}

let offBus: (() => void) | null = null;

export function startHumanTasks(): void {
  if (offBus) return;
  withdrawOrphans();
  const tickets = !onRunner();
  if (tickets) syncQuestions();
  offBus = bus.on((e) => {
    if (e.type === "conversation.deleted" || e.type === "agent.deleted") withdrawOrphans();
    else if (!tickets) return;
    else if (e.type === "question.created") safely(() => mirrorQuestion(e.question));
    else if (e.type === "question.updated") safely(() => settleMirror(e.question));
  });
}

export function stopHumanTasks(): void {
  offBus?.();
  offBus = null;
}
