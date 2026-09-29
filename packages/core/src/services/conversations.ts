/**
 * Conversations + messages + chat entry points (owner: runner).
 * A conversation belongs to one agent; every user turn starts a run (runner/runner.ts) that streams
 * into one assistant message. A human-readable transcript is kept in the agent repo.
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  Agent,
  Attachment,
  Conversation,
  ConversationOrigin,
  Effort,
  Message,
  MessageBlock,
  MessageRole,
  Run,
  RunTrigger,
} from "@godmode/shared";
import type { ComputerTarget, ConversationPatch, ConversationWithMessages, SendMessageInput, SendMessageResult, StartChatResult } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { all, bool, get, insert, int, run as sql, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, newId, notFound, now, parseJson } from "../util";
import { redact } from "../vault/vault";
import { getAgent, getDefaultAgentId } from "../agents/service";
import { activeRunForConversation, cancelRun, listActiveRuns, startRun, waitForRun } from "../runner/runner";
import { displayToolName } from "../runner/stream";
import { normalizeWorkingDirectory } from "./folders";
import { parseComputerTarget } from "../computer/targets";
import { audit } from "./audit";
import { getSettings } from "./settings";

const log = logger("chat");

export const DEFAULT_CONVERSATION_TITLE = "New chat";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TITLE_MAX = 60;
const PREVIEW_MAX = 140;

interface ConversationRow {
  id: string;
  agent_id: string;
  title: string;
  origin: ConversationOrigin;
  claude_session_id: string | null;
  model: string | null;
  effort: Effort | null;
  working_directory: string | null;
  computer_target: string | null;
  instructions: string;
  pinned: number;
  archived: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  preview?: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  blocks: string;
  run_id: string | null;
  attachments: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

/** Markdown → plain text for one-line previews (links keep their label, formatting marks are dropped). */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$|[.,!?;:])/g, "$1$2")
    .replace(/\|/g, " ");
}

function previewOf(text: string | null | undefined): string {
  const t = plainPreview(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    origin: r.origin,
    claudeSessionId: r.claude_session_id,
    model: r.model || null,
    effort: r.effort || null,
    workingDirectory: r.working_directory,
    computerTarget: parseComputerTarget(parseJson<unknown>(r.computer_target, null)),
    instructions: r.instructions,
    pinned: bool(r.pinned),
    archived: bool(r.archived),
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    preview: previewOf(r.preview),
    running: activeRunForConversation(r.id) !== null,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    blocks: parseJson<MessageBlock[]>(r.blocks, []),
    runId: r.run_id,
    attachments: parseJson<Attachment[]>(r.attachments, []),
    createdAt: r.created_at,
  };
}

const PREVIEW_SQL = `(SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.content != '' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview`;

function conversationRow(id: string): ConversationRow | null {
  return get<ConversationRow>(`SELECT c.*, ${PREVIEW_SQL} FROM conversations c WHERE c.id = ?`, id);
}

function requireConversationRow(id: string): ConversationRow {
  const row = conversationRow(id);
  if (!row) throw notFound("Conversation");
  return row;
}

export function conversationExists(id: string): boolean {
  return get<{ id: string }>("SELECT id FROM conversations WHERE id = ?", id) !== null;
}

/** Conversation model (with preview + running flag). */
export function getConversationSummary(id: string): Conversation {
  return toConversation(requireConversationRow(id));
}

export function emitConversationUpdated(id: string) {
  const row = conversationRow(id);
  if (row) bus.emit({ type: "conversation.updated", conversation: toConversation(row) });
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export function titleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return DEFAULT_CONVERSATION_TITLE;
  const t = firstLine.replace(/\s+/g, " ");
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

export interface ModelChoice {
  /** `claude --model` value; null/empty = the agent's model. */
  model?: string | null;
  effort?: Effort | null;
}

export function createConversation(
  input: { agentId: string; title?: string; origin?: ConversationOrigin; workingDirectory?: string | null; instructions?: string } & ModelChoice,
): Conversation {
  getAgent(input.agentId); // 404 if the agent doesn't exist
  const workingDirectory = normalizeWorkingDirectory(input.workingDirectory);
  const ts = now();
  const id = newId("cnv");
  const title = input.title?.trim() ? input.title.trim().slice(0, 200) : DEFAULT_CONVERSATION_TITLE;
  insert("conversations", {
    id,
    agent_id: input.agentId,
    title,
    origin: input.origin ?? "chat",
    claude_session_id: null,
    model: input.model?.trim() || null,
    effort: input.effort ?? null,
    working_directory: workingDirectory,
    instructions: input.instructions?.trim() ?? "",
    pinned: 0,
    archived: 0,
    last_message_at: null,
    created_at: ts,
    updated_at: ts,
  });
  const conversation = getConversationSummary(id);
  bus.emit({ type: "conversation.updated", conversation });
  return conversation;
}

export function getConversation(id: string): ConversationWithMessages {
  const conversation = getConversationSummary(id);
  return { ...conversation, messages: listMessages(id), activeRunId: activeRunForConversation(id) };
}

export function listConversations(opts: { agentId?: string; search?: string; limit?: number; archived?: boolean } = {}): Conversation[] {
  const where: string[] = ["c.archived = ?"];
  const params: (string | number)[] = [opts.archived ? 1 : 0];
  if (opts.agentId) {
    where.push("c.agent_id = ?");
    params.push(opts.agentId);
  }
  const search = opts.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(
      "(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.content LIKE ? ESCAPE '\\'))",
    );
    params.push(like, like);
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
  params.push(limit);
  const rows = all<ConversationRow>(
    `SELECT c.*, ${PREVIEW_SQL} FROM conversations c WHERE ${where.join(" AND ")}
     ORDER BY ${opts.archived ? "" : "c.pinned DESC, "}COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`,
    ...params,
  );
  return rows.map(toConversation);
}

export function updateConversation(id: string, patch: ConversationPatch): Conversation {
  requireConversationRow(id);
  const title = patch.title === undefined ? undefined : patch.title.trim().slice(0, 200);
  if (title !== undefined && !title) throw badRequest("Title must not be empty");
  update("conversations", id, {
    title,
    pinned: int(patch.pinned),
    archived: int(patch.archived),
    model: patch.model === undefined ? undefined : patch.model?.trim() || null,
    effort: patch.effort,
    working_directory: patch.workingDirectory === undefined ? undefined : normalizeWorkingDirectory(patch.workingDirectory),
    computer_target: patch.computerTarget === undefined ? undefined : patch.computerTarget ? JSON.stringify(parseComputerTarget(patch.computerTarget)) : null,
    instructions: patch.instructions?.trim(),
    updated_at: now(),
  });
  const conversation = getConversationSummary(id);
  bus.emit({ type: "conversation.updated", conversation });
  return conversation;
}

/** Internal fields maintained by the runner. Does not emit. */
export function setConversationState(
  id: string,
  patch: {
    claudeSessionId?: string | null;
    /** `instructionsDigest` of the standing instructions the Claude session has seen. */
    instructionsDigest?: string;
    lastMessageAt?: string;
    title?: string;
    model?: string | null;
    effort?: Effort | null;
    archived?: boolean;
  },
) {
  update("conversations", id, {
    claude_session_id: patch.claudeSessionId,
    instructions_digest: patch.instructionsDigest,
    archived: int(patch.archived),
    model: patch.model,
    effort: patch.effort,
    last_message_at: patch.lastMessageAt,
    title: patch.title,
    updated_at: now(),
  });
}

/** Cancel any active run, then delete the conversation, its messages and its transcript file. */
export async function deleteConversation(id: string): Promise<void> {
  const row = requireConversationRow(id);
  const active = listActiveRuns().filter((r) => r.conversationId === id);
  for (const r of active) {
    await cancelRun(r.runId);
    await waitForRun(r.runId, 15_000);
  }
  sql("DELETE FROM messages WHERE conversation_id = ?", id);
  sql("DELETE FROM conversations WHERE id = ?", id);
  try {
    const agent = getAgent(row.agent_id);
    rmSync(transcriptPath(agent, id), { force: true });
  } catch (err) {
    log.warn(`could not remove transcript of conversation ${id}`, err);
  }
  bus.emit({ type: "conversation.deleted", id });
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export function listMessages(conversationId: string): Message[] {
  return all<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC", conversationId).map(
    toMessage,
  );
}

export function getMessage(id: string): Message {
  const row = get<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
  if (!row) throw notFound("Message");
  return toMessage(row);
}

export function addMessage(
  input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    blocks?: MessageBlock[];
    runId?: string | null;
    attachments?: Attachment[];
  },
  opts: { emit?: boolean } = {},
): Message {
  const row: MessageRow = {
    id: newId("msg"),
    conversation_id: input.conversationId,
    role: input.role,
    content: input.content,
    blocks: JSON.stringify(input.blocks ?? []),
    run_id: input.runId ?? null,
    attachments: JSON.stringify(input.attachments ?? []),
    created_at: now(),
  };
  insert("messages", { ...row });
  const message = toMessage(row);
  if (opts.emit !== false) bus.emit({ type: "message.created", message });
  return message;
}

export function updateMessage(
  id: string,
  patch: { content?: string; blocks?: MessageBlock[]; runId?: string | null },
  opts: { emit?: boolean } = {},
): Message | null {
  const exists = get<{ id: string }>("SELECT id FROM messages WHERE id = ?", id);
  if (!exists) return null;
  update("messages", id, {
    content: patch.content,
    blocks: patch.blocks === undefined ? undefined : JSON.stringify(patch.blocks),
    run_id: patch.runId,
  });
  const message = getMessage(id);
  if (opts.emit !== false) bus.emit({ type: "message.updated", message });
  return message;
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function safeFileName(name: string): string {
  const base = basename(String(name ?? "").replace(/\\/g, "/"));
  let clean = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!clean) clean = "file";
  const ext = extname(clean).slice(0, 16);
  let stem = clean.slice(0, clean.length - ext.length) || "file";
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  return `${stem.slice(0, 120)}${ext}`;
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function decodeBase64(data: string): Buffer {
  const raw = data.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) throw badRequest("Attachment data must be base64");
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const size = Math.floor((raw.length * 3) / 4) - padding;
  if (size > MAX_ATTACHMENT_BYTES) throw badRequest(`Attachment too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
  return Buffer.from(raw, "base64");
}

/** Write uploads into `<repo>/workspace/uploads/<yyyy-mm-dd>/`; returns repo-relative paths (posix). */
export function saveAttachments(agent: Agent, files: NonNullable<SendMessageInput["attachments"]>): Attachment[] {
  const decoded = files.map((f) => ({ name: safeFileName(f.name), mime: f.mime || "application/octet-stream", bytes: decodeBase64(f.data) }));
  const day = localDate();
  const dir = join(agent.repoPath, "workspace", "uploads", day);
  mkdirSync(dir, { recursive: true });
  return decoded.map((f) => {
    const ext = extname(f.name);
    const stem = f.name.slice(0, f.name.length - ext.length);
    let name = f.name;
    for (let i = 1; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`;
    writeFileSync(join(dir, name), f.bytes);
    return { name, mime: f.mime, path: `workspace/uploads/${day}/${name}`, size: f.bytes.length };
  });
}

/* ------------------------------------------------------------------ */
/* Chat entry points                                                   */
/* ------------------------------------------------------------------ */

/** Store the user message (+attachments) and start a run for it. */
export async function sendMessage(
  conversationId: string,
  input: SendMessageInput & { trigger?: RunTrigger; routineId?: string | null; parentRunId?: string | null; depth?: number },
): Promise<SendMessageResult> {
  const conv = requireConversationRow(conversationId);
  const agent = getAgent(conv.agent_id);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  const content = (input.content ?? "").trim();
  const files = input.attachments ?? [];
  if (!content && files.length === 0) throw badRequest("Message is empty");

  const attachments = files.length ? saveAttachments(agent, files) : [];
  const message = addMessage({ conversationId, role: "user", content: redact(content), attachments });
  // Absolute: the run's cwd is not the agent repo when the chat works in a folder.
  let prompt = content;
  if (attachments.length) prompt += `${prompt ? "\n\n" : ""}Attached files: ${attachments.map((a) => join(agent.repoPath, a.path)).join(", ")}`;

  let started: Run;
  try {
    started = await startRun({
      agentId: agent.id,
      conversationId,
      prompt,
      trigger: input.trigger ?? "chat",
      routineId: input.routineId ?? null,
      parentRunId: input.parentRunId ?? null,
      depth: input.depth ?? 0,
      voice: input.voice ?? false,
      userMessageId: message.id,
    });
  } catch (err) {
    sql("DELETE FROM messages WHERE id = ?", message.id);
    emitConversationUpdated(conversationId);
    throw err;
  }

  // Writing in an archived chat brings it back; routines and delegations keep it archived.
  const restore = bool(conv.archived) && (input.trigger ?? "chat") === "chat";
  setConversationState(conversationId, { lastMessageAt: message.createdAt, archived: restore ? false : undefined });
  emitConversationUpdated(conversationId);
  return { message: getMessage(message.id), run: started };
}

/** Create a conversation for the agent (default agent if omitted) and send the first message. */
export async function startChat(
  input: {
    agentId?: string;
    content: string;
    origin?: ConversationOrigin;
    title?: string;
    attachments?: SendMessageInput["attachments"];
    voice?: boolean;
    workingDirectory?: string | null;
    /** Screen, window or tab the human shares with this chat (already validated). */
    computerTarget?: ComputerTarget | null;
    instructions?: string;
  } & ModelChoice,
): Promise<StartChatResult> {
  const agentId = input.agentId || getDefaultAgentId();
  if (!agentId) throw badRequest("No agent given and no default agent exists");
  const agent = getAgent(agentId);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  const title =
    input.title?.trim() ||
    (input.content?.trim() ? titleFromContent(input.content) : input.attachments?.[0]?.name ? titleFromContent(input.attachments[0].name) : DEFAULT_CONVERSATION_TITLE);
  const conversation = createConversation({
    agentId,
    title,
    origin: input.origin ?? "chat",
    workingDirectory: input.workingDirectory,
    instructions: input.instructions,
    model: input.model,
    effort: input.effort,
  });
  if (input.computerTarget) {
    update("conversations", conversation.id, { computer_target: JSON.stringify(parseComputerTarget(input.computerTarget)) });
    audit("user", "computer.share", computerTargetLabel(input.computerTarget), { conversationId: conversation.id, kind: input.computerTarget.kind });
  }
  try {
    const result = await sendMessage(conversation.id, { content: input.content, attachments: input.attachments, voice: input.voice });
    return { ...result, conversation: getConversationSummary(conversation.id) };
  } catch (err) {
    // Don't leave an empty conversation behind when the first message could not be sent.
    sql("DELETE FROM conversations WHERE id = ?", conversation.id);
    bus.emit({ type: "conversation.deleted", id: conversation.id });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Transcript (conversations/<id>.md in the agent repo)                 */
/* ------------------------------------------------------------------ */

export function transcriptPath(agent: Agent, conversationId: string): string {
  return join(agent.repoPath, "conversations", `${conversationId}.md`);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toolSummary(blocks: MessageBlock[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) if (b.type === "tool_use") counts.set(displayToolName(b.name), (counts.get(displayToolName(b.name)) ?? 0) + 1);
  if (!counts.size) return "";
  return [...counts.entries()].map(([name, n]) => `\`${name}\`${n > 1 ? ` ×${n}` : ""}`).join(", ");
}

function speaker(runTrigger: RunTrigger): string {
  if (runTrigger === "routine") return "Routine";
  if (runTrigger === "delegation") return "Delegated task";
  return getSettings().general.userName.trim() || "User";
}

/** Append one finished exchange (user turn + assistant turn) to the human-readable transcript. */
export function appendTranscript(conversationId: string, finishedRun: Run, userMessage: Message | null, assistant: Message | null) {
  const row = conversationRow(conversationId);
  if (!row) return;
  const agent = getAgent(row.agent_id);
  const path = transcriptPath(agent, conversationId);
  mkdirSync(join(agent.repoPath, "conversations"), { recursive: true });
  const parts: string[] = [];
  if (!existsSync(path)) {
    parts.push(`# ${row.title}\n\nConversation \`${conversationId}\` with ${agent.name} · ${row.origin} · started ${fmtTime(row.created_at)}\n`);
  }
  if (userMessage) {
    parts.push(`## ${speaker(finishedRun.trigger)} · ${fmtTime(userMessage.createdAt)}\n\n${userMessage.content || "_(no text)_"}`);
    if (userMessage.attachments.length) parts.push(`Attachments: ${userMessage.attachments.map((a) => `\`${a.path}\``).join(", ")}`);
  }
  const meta = [
    finishedRun.status,
    finishedRun.numTurns != null ? `${finishedRun.numTurns} turns` : null,
    finishedRun.costUsd != null ? `$${finishedRun.costUsd.toFixed(4)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const answer = assistant?.content?.trim() || (finishedRun.error ? `_Error: ${finishedRun.error}_` : "_(no answer)_");
  parts.push(`## ${agent.name} · ${fmtTime(finishedRun.finishedAt ?? now())} · ${meta}\n\n${answer}`);
  const tools = assistant ? toolSummary(assistant.blocks) : "";
  if (tools) parts.push(`Tools used: ${tools}`);
  if (finishedRun.error && assistant?.content?.trim()) parts.push(`_Error: ${finishedRun.error}_`);
  appendFileSync(path, `${parts.join("\n\n")}\n\n---\n\n`);
}
