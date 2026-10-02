/**
 * A chat's message queue (owner: runner).
 *
 * A message the human sends while the agent works in the chat doesn't become a run that waits for the whole task: it
 * waits here. The running agent gets the queue between two of its steps (`takeQueued`, asked for by Claude Code's
 * PostToolBatch hook) and decides how the message fits into what it is doing. Whatever still waits when the run ends by
 * itself starts the chat's next run as one turn (`startQueued`); after a stop it waits for the human. While the chat's
 * run is paused the queue belongs to it: the run takes the messages along when it continues.
 */
import type { Agent, Attachment, Message, QueuedMessage, Run, SendMessageInput, SendMessageOutcome } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { all, bool, get, insert, int, run as sql } from "../db";
import { bus } from "../events/bus";
import { badRequest, conflict, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { activeRunForConversation, cancelRun, listActiveRuns, startRun, waitForRun } from "../runner/runner";
import { addMessage, emitConversationUpdated, messageTarget, promptWithFiles, saveAttachments, sendMessage, setConversationState } from "./conversations";
import { continueConversation, pauseOf } from "./pauses";

interface QueueRow {
  id: string;
  conversation_id: string;
  content: string;
  attachments: string;
  voice: number;
  created_at: string;
}

/** What the human typed, before redaction — memory only (the database keeps the redacted text). */
const typed = new Map<string, string>();

function toQueued(r: QueueRow): QueuedMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    content: r.content,
    attachments: parseJson<Attachment[]>(r.attachments, []),
    createdAt: r.created_at,
  };
}

function rows(conversationId: string): QueueRow[] {
  return all<QueueRow>("SELECT * FROM queued_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC", conversationId);
}

export function listQueue(conversationId: string): QueuedMessage[] {
  return rows(conversationId).map(toQueued);
}

export function hasQueued(conversationId: string): boolean {
  return get<{ id: string }>("SELECT id FROM queued_messages WHERE conversation_id = ? LIMIT 1", conversationId) !== null;
}

function emitQueue(conversationId: string) {
  bus.emit({ type: "queue.updated", conversationId, queue: listQueue(conversationId) });
}

function requireRow(conversationId: string, id: string): QueueRow {
  const row = get<QueueRow>("SELECT * FROM queued_messages WHERE id = ? AND conversation_id = ?", id, conversationId);
  if (!row) throw notFound("Queued message");
  return row;
}

function drop(conversationId: string, taken: QueueRow[]) {
  for (const r of taken) {
    sql("DELETE FROM queued_messages WHERE id = ?", r.id);
    typed.delete(r.id);
  }
  emitQueue(conversationId);
}

const isCommand = (r: QueueRow) => parseSlashCommand(typed.get(r.id) ?? r.content) !== null;

/** The messages at the head of the queue that make one turn: everything up to the next slash command, or that command alone. */
function head(queue: QueueRow[]): QueueRow[] {
  const first = queue[0];
  if (!first) return [];
  if (isCommand(first)) return [first];
  const next = queue.findIndex(isCommand);
  return next < 0 ? queue : queue.slice(0, next);
}

function enqueue(conversationId: string, input: SendMessageInput): QueuedMessage {
  const { agent } = messageTarget(conversationId);
  const content = (input.content ?? "").trim();
  const files = input.attachments ?? [];
  if (!content && !files.length) throw badRequest("Message is empty");
  if (input.queueId && get<{ id: string }>("SELECT id FROM queued_messages WHERE id = ?", input.queueId)) throw conflict("That message is queued already");
  const row: QueueRow = {
    id: input.queueId ?? newId("qmsg"),
    conversation_id: conversationId,
    content: redact(content),
    attachments: JSON.stringify(files.length ? saveAttachments(agent, files) : []),
    voice: int(input.voice ?? false)!,
    created_at: now(),
  };
  insert("queued_messages", { ...row });
  typed.set(row.id, content);
  emitQueue(conversationId);
  return toQueued(row);
}

/**
 * A message from the human: straight to the agent when the chat is idle, into the queue while the agent works or its run
 * is paused.
 */
export async function submitMessage(conversationId: string, input: SendMessageInput): Promise<SendMessageOutcome> {
  const busy = activeRunForConversation(conversationId) !== null;
  const paused = pauseOf(conversationId);
  if (!busy && !paused && !hasQueued(conversationId)) return sendMessage(conversationId, { ...input, trigger: "chat" });
  const queued = enqueue(conversationId, input);
  // Also with runs waiting behind the pause: the paused run is the one that takes the queue.
  if (paused) {
    // Writing to a chat the human paused continues it with the message. While Claude's limit is reached there is
    // nothing to continue with: the message waits and goes along when the run does.
    if (paused.reason === "user") {
      try {
        continueConversation(conversationId);
      } catch {
        /* the message stays queued */
      }
    }
    return { queued };
  }
  if (busy) return { queued };
  // Messages left over from before (a stopped run, a restart) go first, in the same turn. When the run can't start, the
  // message stays queued.
  const started = await startQueued(conversationId).catch(() => null);
  const message = started?.messages[started.taken.indexOf(queued.id)];
  return started && message ? { message, run: started.run } : { queued };
}

export function editQueued(conversationId: string, id: string, content: string): QueuedMessage {
  const row = requireRow(conversationId, id);
  const text = content.trim();
  if (!text && !parseJson<Attachment[]>(row.attachments, []).length) throw badRequest("Message is empty");
  // The stored text has the secret masked, and that is all an editor ever sees.
  if ((typed.get(id) ?? row.content) !== row.content) throw badRequest("This message contains a saved secret, so it can't be edited. Remove it and write it again.");
  sql("UPDATE queued_messages SET content = ? WHERE id = ?", redact(text), id);
  typed.set(id, text);
  emitQueue(conversationId);
  return toQueued({ ...row, content: redact(text) });
}

export function removeQueued(conversationId: string, id: string): void {
  drop(conversationId, [requireRow(conversationId, id)]);
}

/** Forget everything that waits (the chat is being deleted). */
export function clearQueue(conversationId: string): void {
  for (const r of rows(conversationId)) typed.delete(r.id);
  sql("DELETE FROM queued_messages WHERE conversation_id = ?", conversationId);
}

/**
 * Hand the waiting messages to the run that is working in the chat (called between two of its steps). Slash commands
 * stay: Claude Code only runs them at the start of a turn.
 */
export function takeQueued(conversationId: string, agent: Agent): { message: QueuedMessage; prompt: string }[] {
  const taken = head(rows(conversationId));
  if (!taken.length || isCommand(taken[0]!)) return [];
  const out = taken.map((r) => {
    const message = toQueued(r);
    return { message, prompt: promptWithFiles(typed.get(r.id) ?? r.content, agent, message.attachments) };
  });
  drop(conversationId, taken);
  return out;
}

/** Start the chat's next run with the messages that wait in its queue. Null when the agent is busy or nothing waits. */
export async function startQueued(conversationId: string): Promise<{ run: Run; messages: Message[]; taken: string[] } | null> {
  if (activeRunForConversation(conversationId) !== null || pauseOf(conversationId)) return null;
  const taken = head(rows(conversationId));
  if (!taken.length) return null;
  const { conv, agent } = messageTarget(conversationId);
  const messages = taken.map((r) =>
    addMessage({ conversationId, role: "user", content: r.content, attachments: parseJson<Attachment[]>(r.attachments, []) }),
  );
  let run: Run;
  try {
    run = await startRun({
      agentId: agent.id,
      conversationId,
      prompt: taken.map((r, i) => promptWithFiles(typed.get(r.id) ?? r.content, agent, messages[i]!.attachments)).join("\n\n"),
      trigger: "chat",
      voice: taken.some((r) => bool(r.voice)),
      userMessageId: messages[0]!.id,
      alsoAnswers: messages.slice(1).map((m) => m.id),
    });
  } catch (err) {
    // The messages stay in the queue: nothing the human wrote gets lost.
    for (const m of messages) sql("DELETE FROM messages WHERE id = ?", m.id);
    emitConversationUpdated(conversationId);
    throw err;
  }
  drop(conversationId, taken);
  const restore = bool(conv.archived) && conv.origin !== "task";
  setConversationState(conversationId, { lastMessageAt: messages[messages.length - 1]!.createdAt, archived: restore ? false : undefined });
  emitConversationUpdated(conversationId);
  return { run, messages: messages.map((m) => ({ ...m, runId: run.id })), taken: taken.map((r) => r.id) };
}

/** Don't wait for the agent's next step: stop what it is doing and start on the queue. */
export async function sendQueuedNow(conversationId: string): Promise<void> {
  messageTarget(conversationId);
  if (!hasQueued(conversationId)) throw notFound("Queued message");
  const jobs = listActiveRuns().filter((r) => r.conversationId === conversationId);
  if (!jobs.some((r) => r.status === "running") && pauseOf(conversationId)) {
    // The paused run takes the queue along as it continues.
    continueConversation(conversationId);
    return;
  }
  if (!jobs.length) {
    await startQueued(conversationId);
    return;
  }
  const running = jobs.find((r) => r.status === "running");
  if (!running) throw conflict("The agent hasn't started yet — the queue is next.");
  await cancelRun(running.runId, "Stopped to start on your queued messages", { thenQueue: true });
  await waitForRun(running.runId, 15_000);
}
