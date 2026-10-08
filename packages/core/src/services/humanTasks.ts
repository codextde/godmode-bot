/**
 * Tasks for the human (see HumanTask): an agent that can't go on until the human does something hands it over with
 * `human_task_create` and ends its turn. The task waits on the human's board; closing it (done, or "can't do it")
 * continues the agent's chat with the human's note — straight away when the chat is idle, through the chat's queue
 * while the agent works there. A board ticket waits in Blocked meanwhile (tasks/service.ts `finished`).
 */
import type { Agent, Attachment, HumanTask, HumanTaskCloseInput, HumanTaskCloseResult, HumanTaskInput, HumanTaskPatch, HumanTaskPriority, HumanTaskStatus, MessageBlock } from "@godmode/shared";
import { humanTaskRef } from "@godmode/shared";
import { all, get, insert, run as sql } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { getAgent } from "../agents/service";
import { activeRunForConversation } from "../runner/runner";
import { describeNow, stripNoteTags } from "../runner/prompt";
import { audit } from "./audit";
import { conversationExists, promptWithFiles, saveAttachments, sendMessage } from "./conversations";
import { hasQueued, submitMessage } from "./messageQueue";
import { markRead, notify } from "./notifications";
import { pauseOf } from "./pauses";
import { getSettings } from "./settings";
import { noteHumanTask } from "../tasks/service";

const log = logger("human-tasks");

/** Open tasks one chat may have at a time. */
export const MAX_OPEN_PER_CHAT = 5;
/** Closed tasks the board lists (newest first). */
const CLOSED_LIMIT = 60;
const POSITION_STEP = 1024;

interface Row {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string | null;
  priority: HumanTaskPriority;
  status: HumanTaskStatus;
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  response: string | null;
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

const ACTIVE_SQL = "('open', 'doing')";

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
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    runId: r.run_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    response: closed && r.closed_at ? { text: r.response ?? "", attachments: parseJson<Attachment[]>(r.response_attachments, []), at: r.closed_at } : null,
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

/** `active` = open or doing; `closed` = done, declined or withdrawn (the latest ones). */
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

/** The gateway's `human_task_create`. */
export function createAgentHumanTask(origin: HumanTaskOrigin, input: HumanTaskInput): HumanTask {
  const agent = getAgent(origin.agentId);
  const title = clean(input.title, 200);
  if (!title) throw badRequest("Say what to do (title).");
  const open = get<{ n: number }>(`SELECT COUNT(*) AS n FROM human_tasks WHERE conversation_id = ? AND status IN ${ACTIVE_SQL}`, origin.conversationId)?.n ?? 0;
  if (open >= MAX_OPEN_PER_CHAT) {
    throw conflict(`${humanName()} already has ${open} open tasks from this chat. Wait for them, or take one back with human_task_cancel.`);
  }
  const ticket = get<{ id: string; workspace_id: string | null }>("SELECT id, workspace_id FROM tasks WHERE conversation_id = ?", origin.conversationId);
  const id = newId("htk");
  const ts = now();
  insert("human_tasks", {
    id,
    number: nextNumber(),
    title,
    body: clean(input.body, 6000),
    url: cleanUrl(input.url),
    priority: input.priority === "high" ? "high" : "normal",
    status: "open",
    agent_id: agent.id,
    conversation_id: origin.conversationId,
    run_id: origin.runId,
    task_id: ticket?.id ?? null,
    workspace_id: ticket?.workspace_id ?? origin.workspaceId ?? agent.workspaceId ?? null,
    position: topPosition("open"),
    created_at: ts,
    updated_at: ts,
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
  const id = newId("htk");
  const ts = now();
  insert("human_tasks", {
    id,
    number: nextNumber(),
    title,
    body: redact(input.body ?? "").slice(0, 6000),
    url: cleanUrl(input.url),
    priority: input.priority === "high" ? "high" : "normal",
    status: "open",
    workspace_id: input.workspaceId ?? null,
    position: topPosition("open"),
    created_at: ts,
    updated_at: ts,
  });
  changed();
  return getHumanTask(id);
}

/* ------------------------------------------------------------------ */
/* Moving and editing                                                  */
/* ------------------------------------------------------------------ */

export function updateHumanTask(id: string, patch: HumanTaskPatch): HumanTask {
  const r = requireRow(id);
  const active = r.status === "open" || r.status === "doing";
  const sets: Record<string, string | number | null> = {};
  if (patch.status !== undefined || patch.beforeId !== undefined) {
    if (!active) throw conflict("This task is closed already");
    const status = patch.status ?? r.status;
    sets.status = status;
    sets.position = patch.beforeId === undefined && status !== r.status ? topPosition(status, id) : positionIn(status, patch.beforeId ?? null, id);
    if (status === "doing" && !r.started_at) sets.started_at = now();
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
  sql("DELETE FROM human_tasks WHERE id = ?", id);
  if (r.notification_id) markRead([r.notification_id]);
  audit("user", "human_task.delete", id, { title: r.title });
  changed();
}

/* ------------------------------------------------------------------ */
/* Closing: the agent continues                                        */
/* ------------------------------------------------------------------ */

/** The human closes a task. The agent that gave it continues its chat with the outcome and the note. */
export async function closeHumanTask(id: string, input: HumanTaskCloseInput): Promise<HumanTaskCloseResult> {
  const r = requireRow(id);
  if (r.status !== "open" && r.status !== "doing") throw conflict(r.status === "withdrawn" ? "The agent took this task back already." : "This task is closed already.");
  const note = (input.note ?? "").trim().slice(0, 20_000);
  const files = input.attachments ?? [];

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
    `UPDATE human_tasks SET status = ?, response = ?, response_attachments = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status IN ${ACTIVE_SQL}`,
    input.outcome,
    redact(note),
    JSON.stringify(attachments),
    ts,
    ts,
    id,
  );
  if (!done.changes) throw conflict("This task is closed already.");
  if (r.notification_id) markRead([r.notification_id]);
  if (r.task_id) noteHumanTask(r.task_id, "answered", "user", { body: redact(note), questionId: id, status: input.outcome });
  audit("user", "human_task.close", id, { outcome: input.outcome, note: redact(note).slice(0, 200), agentId: r.agent_id, conversationId: r.conversation_id });
  changed();

  let continued = false;
  let notContinued: string | undefined;
  try {
    const why = await continueAgent(r, agent, input.outcome, note, attachments);
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
  const head = outcome === "done" ? `Done: ${ref} ${r.title}` : `Can't do: ${ref} ${r.title}`;
  const others = openHumanTasksOf(conversationId).filter((t) => t.id !== r.id);

  // The agent is at work in the chat (or its run stands still): the message waits in the queue and reaches it there.
  if (activeRunForConversation(conversationId) || pauseOf(conversationId) || hasQueued(conversationId)) {
    const text = promptWithFiles(note ? `${head}\n\n${note}` : head, agent, attachments);
    await submitMessage(conversationId, { content: text });
    return null;
  }

  const human = humanName();
  const said = note ? `Their note:\n${stripNoteTags(note)}` : "They added no note.";
  const prompt = `<godmode-human-task>
You gave ${human} a task on ${describeNow(new Date(r.created_at))}: ${ref} “${r.title}”. ${outcome === "done" ? `${human} marked it done.` : `${human} says they can't do it.`}
${said}
${
  outcome === "done"
    ? "Check that it worked where you can, then pick the work up where you left off."
    : "Find another way if there is one; otherwise finish what you can and say plainly what stays undone without it."
}${others.length ? `\nStill open for ${human}: ${others.map((t) => `${humanTaskRef(t)} “${t.title}”`).join(", ")}.` : ""}
</godmode-human-task>`;
  const block: MessageBlock = { type: "human_task", id: r.id, number: r.number, title: r.title, outcome, note: redact(note), at: now() };
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
  if (r.status !== "open" && r.status !== "doing") throw conflict(`${humanTaskRef(r)} is ${r.status} already`);
  const why = clean(reason, 500) || null;
  sql("UPDATE human_tasks SET status = 'withdrawn', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?", why, now(), now(), id);
  if (r.notification_id) markRead([r.notification_id]);
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
  const ts = now();
  for (const g of gone) {
    sql("UPDATE human_tasks SET status = 'withdrawn', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?", "The chat it was for was deleted.", ts, ts, g.id);
    if (g.notification_id) markRead([g.notification_id]);
  }
  changed();
}

let offBus: (() => void) | null = null;

export function startHumanTasks(): void {
  if (offBus) return;
  withdrawOrphans();
  offBus = bus.on((e) => {
    if (e.type === "conversation.deleted" || e.type === "agent.deleted") withdrawOrphans();
  });
}

export function stopHumanTasks(): void {
  offBus?.();
  offBus = null;
}
