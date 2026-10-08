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
  ConversationFollowup,
  ConversationOrigin,
  Effort,
  Message,
  MessageBlock,
  MessageRole,
  MessageSource,
  PauseReason,
  Run,
  RunPause,
  RunTrigger,
} from "@godmode/shared";
import type { ComputerTarget, ConversationPatch, ConversationWithMessages, SendMessageInput, SendMessageResult, StartChatResult } from "@godmode/shared";
import { computerTargetLabel, MAX_MESSAGE_ATTACHMENT_BYTES } from "@godmode/shared";
import { all, bool, get, insert, int, run as sql, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, newId, notFound, now, parseJson } from "../util";
import { assignmentsChanged, normalizeVmId } from "../vm/assignments";
import { normalizeSshServerIds, parseServerIds } from "../ssh/assignments";
import { redact } from "../vault/vault";
import { getAgent, getDefaultAgentId, setAgentFailedRun } from "../agents/service";
import { activeRunForConversation, cancelRun, listActiveRuns, retryQueued, startRun, waitForRun } from "../runner/runner";
import { remoteRunForConversation } from "../remote/activeRuns";
import { closeChatTabs } from "../browser/manager";
import { displayToolName } from "../runner/stream";
import { normalizeWorkingDirectory } from "./folders";
import { parseComputerTarget } from "../computer/targets";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { clearQueue, listQueue } from "./messageQueue";
import { requireLicense } from "../license/license";
import { continueConversation, pauseOf, PAUSE_QUESTION_JOIN, PAUSE_QUESTION_SQL, toPause, type PauseQuestionCols } from "./pauses";

const log = logger("chat");

export const DEFAULT_CONVERSATION_TITLE = "New chat";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TITLE_MAX = 60;
const PREVIEW_MAX = 140;

interface ConversationRow extends PauseQuestionCols {
  id: string;
  agent_id: string;
  title: string;
  origin: ConversationOrigin;
  claude_session_id: string | null;
  model: string | null;
  effort: Effort | null;
  ultracode: number | null;
  working_directory: string | null;
  computer_target: string | null;
  vm_id: string | null;
  browser_profile_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  ssh_server_ids: string | null;
  instructions: string;
  runner_id: string | null;
  runner_state: string | null;
  runner_tools_id: string | null;
  pinned: number;
  archived: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  preview?: string | null;
  followup_note?: string | null;
  followup_due_at?: string | null;
  followup_created_at?: string | null;
  paused_run_id?: string | null;
  paused_reason?: PauseReason | null;
  paused_budget_scope?: "agent" | "team" | null;
  unread_run_id?: string | null;
  unread_status?: string | null;
  paused_budget_usd?: number | null;
  paused_limit?: string | null;
  paused_resume_at?: string | null;
  paused_auto?: number | null;
  paused_at?: string | null;
  from_run_id?: string | null;
  from_agent_id?: string | null;
  from_conversation_id?: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  blocks: string;
  run_id: string | null;
  attachments: string;
  source?: string | null;
  created_at: string;
}

const MESSAGE_SOURCES: readonly MessageSource[] = ["automation", "delegation", "task"];

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

/** What a runner last said about a chat that works there (`runner_state`, written by remote/mirror.ts). */
export interface RunnerChatState {
  running: boolean;
  paused: RunPause | null;
  followup: ConversationFollowup | null;
}

function toConversation(r: ConversationRow): Conversation {
  // A chat on a runner has its runs, its pause and its follow-up there: the local tables hold nothing about them.
  const remote = r.runner_id ? (parseJson<Partial<RunnerChatState> | null>(r.runner_state, null) ?? {}) : null;
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    origin: r.origin,
    claudeSessionId: r.claude_session_id,
    model: r.model || null,
    effort: r.effort || null,
    ultracode: r.ultracode == null ? null : bool(r.ultracode),
    workingDirectory: r.working_directory,
    computerTarget: parseComputerTarget(parseJson<unknown>(r.computer_target, null)),
    vmId: r.vm_id ?? null,
    browserProfileId: r.browser_profile_id ?? null,
    workspaceId: r.workspace_id ?? null,
    projectId: r.project_id ?? null,
    sshServerIds: parseServerIds(r.ssh_server_ids),
    instructions: r.instructions,
    runnerId: r.runner_id ?? null,
    runnerToolsId: r.runner_tools_id ?? null,
    pinned: bool(r.pinned),
    archived: bool(r.archived),
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    preview: previewOf(r.preview),
    running: remote ? remoteRunForConversation(r.id) !== null || remote.running === true : activeRunForConversation(r.id) !== null,
    followup: remote
      ? (remote.followup ?? null)
      : r.followup_due_at
        ? { note: r.followup_note ?? "", dueAt: r.followup_due_at, createdAt: r.followup_created_at ?? r.followup_due_at }
        : null,
    paused: remote
      ? (remote.paused ?? null)
      : r.paused_run_id && r.paused_reason && r.paused_at
        ? toPause(
            {
              run_id: r.paused_run_id,
              reason: r.paused_reason,
              created_at: r.paused_at,
              limit_name: r.paused_limit ?? null,
              resume_at: r.paused_resume_at ?? null,
              auto: r.paused_auto ?? 0,
              budget_scope: r.paused_budget_scope ?? null,
              budget_usd: r.paused_budget_usd ?? null,
            },
            r,
          )
        : null,
    delegatedFrom: r.from_run_id && r.from_agent_id ? { agentId: r.from_agent_id, conversationId: r.from_conversation_id ?? null, runId: r.from_run_id } : null,
    unread: r.unread_run_id ? { runId: r.unread_run_id, failed: r.unread_status === "failed" } : null,
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
    // Only the three known values: a restored backup can't invent an author.
    ...(r.role === "user" && MESSAGE_SOURCES.includes(r.source as MessageSource) ? { source: r.source as MessageSource } : {}),
    createdAt: r.created_at,
  };
}

const PREVIEW_SQL = `(SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.content != '' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview`;
const FOLLOWUP_SQL = "f.note AS followup_note, f.due_at AS followup_due_at, f.created_at AS followup_created_at";
const PAUSE_SQL =
  "p.run_id AS paused_run_id, p.reason AS paused_reason, p.limit_name AS paused_limit, p.resume_at AS paused_resume_at, p.auto AS paused_auto, p.created_at AS paused_at, " +
  "p.budget_scope AS paused_budget_scope, p.budget_usd AS paused_budget_usd, " +
  PAUSE_QUESTION_SQL;
// A handed-over chat links back to the run (and through it the chat and agent) that asked. Derived, not stored: when
// the asking agent or its chat is deleted the link goes null by itself.
const DELEGATED_SQL =
  "pr.id AS from_run_id, pr.agent_id AS from_agent_id, pc.id AS from_conversation_id, (SELECT ur.status FROM runs ur WHERE ur.id = c.unread_run_id) AS unread_status";
const DELEGATED_JOIN =
  "LEFT JOIN runs pr ON c.origin = 'delegation' AND pr.id = (SELECT r.parent_run_id FROM runs r WHERE r.conversation_id = c.id AND r.parent_run_id IS NOT NULL ORDER BY r.created_at, r.rowid LIMIT 1) " +
  "LEFT JOIN conversations pc ON pc.id = pr.conversation_id";
const FROM_SQL = `conversations c LEFT JOIN followups f ON f.conversation_id = c.id LEFT JOIN paused_runs p ON p.conversation_id = c.id ${PAUSE_QUESTION_JOIN} ${DELEGATED_JOIN}`;

function conversationRow(id: string): ConversationRow | null {
  return get<ConversationRow>(`SELECT c.*, ${PREVIEW_SQL}, ${FOLLOWUP_SQL}, ${PAUSE_SQL}, ${DELEGATED_SQL} FROM ${FROM_SQL} WHERE c.id = ?`, id);
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

/** Normalize a chat's browser profile from an API input: undefined = unchanged, null/"" = the agent's, else an existing profile. */
function normalizeBrowserProfileId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const id = value?.trim() || null;
  if (id && !get<{ id: string }>("SELECT id FROM browser_profiles WHERE id = ?", id)) throw badRequest("That browser profile doesn't exist anymore");
  return id;
}

/** A global agent's chat keeps the workspace it was started in; a workspace agent's chat is in the agent's workspace. */
function normalizeWorkspaceId(agent: Agent, value: string | null | undefined): string | null {
  const id = value?.trim();
  if (!id || agent.workspaceId) return null;
  return get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", id)?.id ?? null;
}

/**
 * Normalize a chat's project: undefined = unchanged, null/"" = the agent's, else one of the agent's workspace (any for
 * a global agent, whose chat then counts to the project's workspace).
 */
function normalizeProject(agent: Agent, value: string | null | undefined): { id: string; workspaceId: string } | null | undefined {
  if (value === undefined) return undefined;
  const id = value?.trim();
  if (!id) return null;
  const row = get<{ workspace_id: string }>("SELECT workspace_id FROM projects WHERE id = ?", id);
  if (!row) throw badRequest("That project doesn't exist anymore");
  if (agent.workspaceId && row.workspace_id !== agent.workspaceId) throw badRequest(`${agent.name} works in another workspace than this project`);
  return { id, workspaceId: row.workspace_id };
}

export interface ModelChoice {
  /** `claude --model` value; null/empty = the agent's model. */
  model?: string | null;
  effort?: Effort | null;
  /** Ultracode for this chat; null = the agent's. */
  ultracode?: boolean | null;
}

export function createConversation(
  input: {
    agentId: string;
    title?: string;
    origin?: ConversationOrigin;
    workingDirectory?: string | null;
    vmId?: string | null;
    browserProfileId?: string | null;
    workspaceId?: string | null;
    projectId?: string | null;
    sshServerIds?: string[];
    instructions?: string;
    /** No raw secrets in this chat, whatever its agent may read (see `chatFillOnly`). */
    fillOnly?: boolean;
  } & ModelChoice,
): Conversation {
  const agent = getAgent(input.agentId); // 404 if the agent doesn't exist
  const workingDirectory = normalizeWorkingDirectory(input.workingDirectory);
  const vmId = normalizeVmId(input.vmId) ?? null;
  const browserProfileId = normalizeBrowserProfileId(input.browserProfileId) ?? null;
  const sshServerIds = normalizeSshServerIds(input.sshServerIds) ?? [];
  const project = normalizeProject(agent, input.projectId) ?? null;
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
    ultracode: input.ultracode == null ? null : int(input.ultracode)!,
    working_directory: workingDirectory,
    vm_id: vmId,
    browser_profile_id: browserProfileId,
    workspace_id: agent.workspaceId ? null : (project?.workspaceId ?? normalizeWorkspaceId(agent, input.workspaceId)),
    project_id: project?.id ?? null,
    ssh_server_ids: JSON.stringify(sshServerIds),
    secret_access: input.fillOnly ? "fill" : null,
    instructions: input.instructions?.trim() ?? "",
    pinned: 0,
    archived: 0,
    last_message_at: null,
    created_at: ts,
    updated_at: ts,
  });
  const conversation = getConversationSummary(id);
  bus.emit({ type: "conversation.updated", conversation });
  if (vmId) assignmentsChanged();
  return conversation;
}

/**
 * The chat works without raw secrets even when its agent may read them: its task was handed over by an agent that
 * could not read them itself. It stays that way for everything that happens in the chat later. A chat that is gone
 * counts as fill-only too.
 */
export function chatFillOnly(conversationId: string): boolean {
  const row = get<{ secret_access: string | null }>("SELECT secret_access FROM conversations WHERE id = ?", conversationId);
  return !row || row.secret_access === "fill";
}

export function getConversation(id: string): ConversationWithMessages {
  const conversation = getConversationSummary(id);
  const activeRunId = conversation.runnerId ? remoteRunForConversation(id) : activeRunForConversation(id);
  return { ...conversation, messages: listMessages(id), activeRunId, queue: listQueue(id) };
}

/**
 * `workspaceId`: "all"/undefined = every chat; "global" = global agents' chats started outside any workspace;
 * a workspace id = chats of the workspace's agents, and global agents' chats started in it.
 */
export function listConversations(
  opts: { agentId?: string; workspaceId?: string; projectId?: string; search?: string; limit?: number; archived?: boolean } = {},
): Conversation[] {
  const where: string[] = ["c.archived = ?"];
  const params: (string | number)[] = [opts.archived ? 1 : 0];
  if (opts.agentId) {
    where.push("c.agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.workspaceId === "global") {
    where.push("c.workspace_id IS NULL AND c.agent_id IN (SELECT id FROM agents WHERE workspace_id IS NULL)");
  } else if (opts.workspaceId && opts.workspaceId !== "all") {
    where.push("(c.workspace_id = ? OR c.agent_id IN (SELECT id FROM agents WHERE workspace_id = ?))");
    params.push(opts.workspaceId, opts.workspaceId);
  }
  // A project's chats: the ones started in it, and those of its agents that didn't pick another.
  if (opts.projectId) {
    where.push("(c.project_id = ? OR (c.project_id IS NULL AND c.agent_id IN (SELECT id FROM agents WHERE project_id = ?)))");
    params.push(opts.projectId, opts.projectId);
  }
  // Every word, in the title or in a message ("invoice march" finds "March invoice review"); at most six words.
  for (const word of (opts.search ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    const like = `%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(
      "(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.content LIKE ? ESCAPE '\\'))",
    );
    params.push(like, like);
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
  params.push(limit);
  const rows = all<ConversationRow>(
    `SELECT c.*, ${PREVIEW_SQL}, ${FOLLOWUP_SQL}, ${PAUSE_SQL}, ${DELEGATED_SQL} FROM ${FROM_SQL} WHERE ${where.join(" AND ")}
     ORDER BY ${opts.archived ? "" : "c.pinned DESC, "}COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`,
    ...params,
  );
  return rows.map(toConversation);
}

export function updateConversation(id: string, patch: ConversationPatch): Conversation {
  const row = requireConversationRow(id);
  const project = patch.projectId === undefined ? undefined : normalizeProject(getAgent(row.agent_id), patch.projectId);
  const title = patch.title === undefined ? undefined : patch.title.trim().slice(0, 200);
  if (title !== undefined && !title) throw badRequest("Title must not be empty");
  update("conversations", id, {
    title,
    pinned: int(patch.pinned),
    archived: int(patch.archived),
    model: patch.model === undefined ? undefined : patch.model?.trim() || null,
    effort: patch.effort,
    ultracode: patch.ultracode === null ? null : int(patch.ultracode),
    working_directory: patch.workingDirectory === undefined ? undefined : normalizeWorkingDirectory(patch.workingDirectory),
    computer_target: patch.computerTarget === undefined ? undefined : patch.computerTarget ? JSON.stringify(parseComputerTarget(patch.computerTarget)) : null,
    vm_id: normalizeVmId(patch.vmId),
    browser_profile_id: normalizeBrowserProfileId(patch.browserProfileId),
    ssh_server_ids: patch.sshServerIds === undefined ? undefined : JSON.stringify(normalizeSshServerIds(patch.sshServerIds)),
    instructions: patch.instructions?.trim(),
    project_id: project === undefined ? undefined : (project?.id ?? null),
    // A global agent's chat moves along to the project's workspace.
    workspace_id: project && !get("SELECT 1 FROM agents WHERE id = ? AND workspace_id IS NOT NULL", row.agent_id) ? project.workspaceId : undefined,
    updated_at: now(),
  });
  const conversation = getConversationSummary(id);
  bus.emit({ type: "conversation.updated", conversation });
  if (patch.vmId !== undefined) assignmentsChanged();
  if (patch.browserProfileId !== undefined || project !== undefined) retryQueued();
  // Archived, or moved to another browser profile: its tabs aren't needed where they are.
  if (patch.archived || patch.browserProfileId !== undefined) void closeChatTabs(id);
  if (patch.sshServerIds !== undefined || (patch.archived !== undefined && conversation.sshServerIds.length)) bus.changed("ssh-servers");
  return conversation;
}

/** Internal fields maintained by the runner. Does not emit. */
export function setConversationState(
  id: string,
  patch: {
    claudeSessionId?: string | null;
    /** What Claude Code has counted for that session so far. A session set without it starts uncounted. */
    claudeSessionCostUsd?: number | null;
    /** `instructionsDigest` of the standing instructions the Claude session has seen. */
    instructionsDigest?: string;
    /** `memoryDigest` of the MEMORY.md the Claude session has seen. */
    memoryDigest?: string | null;
    lastMessageAt?: string;
    title?: string;
    model?: string | null;
    effort?: Effort | null;
    ultracode?: boolean | null;
    archived?: boolean;
  },
) {
  update("conversations", id, {
    claude_session_id: patch.claudeSessionId,
    claude_session_cost_usd: patch.claudeSessionCostUsd !== undefined ? patch.claudeSessionCostUsd : patch.claudeSessionId !== undefined ? null : undefined,
    instructions_digest: patch.instructionsDigest,
    memory_digest: patch.memoryDigest,
    archived: int(patch.archived),
    model: patch.model,
    effort: patch.effort,
    ultracode: patch.ultracode === null ? null : int(patch.ultracode),
    last_message_at: patch.lastMessageAt,
    title: patch.title,
    updated_at: now(),
  });
}

/** Cancel any active run, then delete the conversation, its messages and its transcript file. */
/**
 * The human has seen these chats (opened them, or "Mark all read"): nothing is new there anymore, and a failure in them
 * stops showing as "Last run failed" on the agent once its chat was read.
 */
export function markConversationsRead(ids: string[] | "all"): number {
  const rows =
    ids === "all"
      ? all<{ id: string; unread_run_id: string }>("SELECT id, unread_run_id FROM conversations WHERE unread_run_id IS NOT NULL")
      : ids.flatMap((id) => {
          const r = get<{ id: string; unread_run_id: string | null }>("SELECT id, unread_run_id FROM conversations WHERE id = ?", id);
          return r?.unread_run_id ? [{ id: r.id, unread_run_id: r.unread_run_id }] : [];
        });
  for (const r of rows) {
    sql("UPDATE conversations SET unread_run_id = NULL WHERE id = ? AND unread_run_id = ?", r.id, r.unread_run_id);
    // Seen: the agent stops saying "Last run failed" for it.
    const failed = get<{ id: string }>("SELECT id FROM agents WHERE failed_run_id = ?", r.unread_run_id);
    if (failed) setAgentFailedRun(failed.id, null);
    emitConversationUpdated(r.id);
  }
  return rows.length;
}

export async function deleteConversation(id: string): Promise<void> {
  const row = requireConversationRow(id);
  // First, so the run that is cancelled below doesn't hand over to the queue.
  clearQueue(id);
  const active = listActiveRuns().filter((r) => r.conversationId === id);
  for (const r of active) {
    await cancelRun(r.runId);
    await waitForRun(r.runId, 15_000);
  }
  // A paused run ends with its chat.
  const paused = get<{ run_id: string }>("SELECT run_id FROM paused_runs WHERE conversation_id = ?", id);
  if (paused) await cancelRun(paused.run_id);
  sql("DELETE FROM messages WHERE conversation_id = ?", id);
  sql("DELETE FROM conversations WHERE id = ?", id);
  // "Last run failed" would open a run whose chat is gone.
  const forgot = sql("UPDATE agents SET failed_run_id = NULL WHERE failed_run_id IN (SELECT id FROM runs WHERE conversation_id = ?)", id).changes;
  try {
    const agent = getAgent(row.agent_id);
    rmSync(transcriptPath(agent, id), { force: true });
  } catch (err) {
    log.warn(`could not remove transcript of conversation ${id}`, err);
  }
  await closeChatTabs(id);
  bus.emit({ type: "conversation.deleted", id });
  if (forgot) bus.changed("agents");
  if (parseServerIds(row.ssh_server_ids).length) bus.changed("ssh-servers");
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
    /** Who wrote a user message when it wasn't the human. Set by the core only. */
    source?: MessageSource;
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
    source: input.role === "user" ? (input.source ?? null) : null,
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
  let total = 0;
  const decoded = files.map((f) => {
    const bytes = decodeBase64(f.data);
    if ((total += bytes.length) > MAX_MESSAGE_ATTACHMENT_BYTES) throw badRequest(`Attachments too large together (max ${MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    return { name: safeFileName(f.name), mime: f.mime || "application/octet-stream", bytes };
  });
  const day = localDate();
  const dir = join(agent.repoPath, "workspace", "uploads", day);
  mkdirSync(dir, { recursive: true });
  // Where the search for a free name stopped, per name: many files of one name don't start it over each time.
  // Lower case, as "A.png" and "a.png" are one file on most disks.
  const tried = new Map<string, number>();
  return decoded.map((f) => {
    const ext = extname(f.name);
    const stem = f.name.slice(0, f.name.length - ext.length);
    let name = f.name;
    const key = f.name.toLowerCase();
    let i = tried.get(key) ?? 1;
    for (; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`;
    tried.set(key, i);
    writeFileSync(join(dir, name), f.bytes);
    return { name, mime: f.mime, path: `workspace/uploads/${day}/${name}`, size: f.bytes.length };
  });
}

/* ------------------------------------------------------------------ */
/* Chat entry points                                                   */
/* ------------------------------------------------------------------ */

/** The chat a message goes to and its agent; refuses chats that take no messages. */
export function messageTarget(conversationId: string, trigger: RunTrigger = "chat"): { conv: ConversationRow; agent: Agent } {
  const conv = requireConversationRow(conversationId);
  const agent = getAgent(conv.agent_id);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  if (conv.origin === "dream" && trigger !== "dream") {
    throw badRequest(`This is where ${agent.name} dreams (consolidates its memory). Start a new chat to talk to it.`);
  }
  return { conv, agent };
}

/** What Claude reads for a message with files. Absolute paths: the run's cwd is not the agent repo when the chat works in a folder. */
export function promptWithFiles(prompt: string, agent: Agent, attachments: Attachment[]): string {
  if (!attachments.length) return prompt;
  return `${prompt}${prompt ? "\n\n" : ""}Attached files: ${attachments.map((a) => join(agent.repoPath, a.path)).join(", ")}`;
}

/** Store the user message (+attachments) and start a run for it. */
export async function sendMessage(
  conversationId: string,
  input: SendMessageInput & {
    trigger?: RunTrigger;
    routineId?: string | null;
    parentRunId?: string | null;
    depth?: number;
    runId?: string;
    /** What Claude gets instead of `content`. */
    prompt?: string;
    /** Store a system message with these blocks instead of a message from the human. */
    marker?: MessageBlock[];
    /** Files already in the agent's repository (e.g. a task's attachments), attached like uploads. */
    files?: Attachment[];
    /** Who wrote it when it wasn't the human: an automation, an agent handing work over, the task board. */
    source?: MessageSource;
    /** The human started it by hand (Run now): a used-up monthly budget doesn't hold it. */
    byHuman?: boolean;
  },
): Promise<SendMessageResult> {
  const { conv, agent } = messageTarget(conversationId, input.trigger);
  // Before anything is stored: a refused run leaves no message or upload behind.
  requireLicense();
  const content = (input.content ?? "").trim();
  const files = input.attachments ?? [];
  if (!content && files.length === 0 && !input.files?.length) throw badRequest("Message is empty");

  const attachments = [...(input.files ?? []), ...(files.length ? saveAttachments(agent, files) : [])];
  const message = addMessage({ conversationId, role: input.marker ? "system" : "user", content: redact(content), blocks: input.marker, attachments, source: input.source });
  const prompt = promptWithFiles(input.prompt ?? content, agent, attachments);

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
      runId: input.runId,
      byHuman: input.byHuman,
    });
  } catch (err) {
    sql("DELETE FROM messages WHERE id = ?", message.id);
    emitConversationUpdated(conversationId);
    throw err;
  }

  // Someone writing to a chat the human paused continues it: the paused run goes on, this message is the turn after it.
  if ((input.trigger ?? "chat") === "chat" && pauseOf(conversationId)?.reason === "user") {
    try {
      continueConversation(conversationId);
    } catch (err) {
      log.warn(`could not continue the paused run of conversation ${conversationId}`, err);
    }
  }

  // Writing in an archived chat brings it back; routines and delegations keep it archived.
  const restore = bool(conv.archived) && (input.trigger ?? "chat") === "chat" && conv.origin !== "task";
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
    /** macOS VM for this chat (null/omitted = the agent's). */
    vmId?: string | null;
    /** Browser profile for this chat (null/omitted = the agent's). */
    browserProfileId?: string | null;
    /** Workspace the chat is started in (the sidebar's); a global agent browses with its default profile. */
    workspaceId?: string | null;
    /** Project the chat works on (the sidebar's); omitted = the agent's. */
    projectId?: string | null;
    /** SSH servers for this chat, in addition to the agent's. */
    sshServerIds?: string[];
    instructions?: string;
  } & ModelChoice,
): Promise<StartChatResult> {
  requireLicense();
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
    vmId: input.vmId,
    browserProfileId: input.browserProfileId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sshServerIds: input.sshServerIds,
    instructions: input.instructions,
    model: input.model,
    effort: input.effort,
    ultracode: input.ultracode,
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

/**
 * Who a turn's opening message is from. Read off the message, not the run: the human's feedback on a ticket also runs
 * with the trigger "task".
 */
function speaker(m?: Pick<Message, "source">, runTrigger?: RunTrigger): string {
  if (m?.source === "automation") return "Automation";
  if (m?.source === "delegation") return "Delegated task";
  if (m?.source === "task") return "Task";
  if (runTrigger === "followup") return "Follow-up";
  if (runTrigger === "heartbeat") return "Heartbeat";
  return getSettings().general.userName.trim() || "User";
}

/** Append one finished exchange (user turn + assistant turn) to the human-readable transcript. */
export function appendTranscript(conversationId: string, finishedRun: Run, userMessages: Message[], assistant: Message | null) {
  const row = conversationRow(conversationId);
  if (!row) return;
  const agent = getAgent(row.agent_id);
  const path = transcriptPath(agent, conversationId);
  mkdirSync(join(agent.repoPath, "conversations"), { recursive: true });
  const parts: string[] = [];
  if (!existsSync(path)) {
    parts.push(`# ${row.title}\n\nConversation \`${conversationId}\` with ${agent.name} · ${row.origin} · started ${fmtTime(row.created_at)}\n`);
  }
  const files = (attachments: Attachment[]) => `Attachments: ${attachments.map((a) => `\`${a.path}\``).join(", ")}`;
  for (const m of userMessages) {
    parts.push(`## ${speaker(m, finishedRun.trigger)} · ${fmtTime(m.createdAt)}\n\n${m.content || "_(no text)_"}`);
    if (m.attachments.length) parts.push(files(m.attachments));
  }
  for (const b of assistant?.blocks ?? []) {
    if (b.type === "question") {
      const options = b.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
      const asked = b.kind === "approval" ? `Asks for an OK: ${b.title}${b.body ? `\n\nWhy: ${b.body}` : ""}${b.affects ? `\n\nAffects: ${b.affects}` : ""}` : `${b.title}${b.body ? `\n\n${b.body}` : ""}${options ? `\n\n${options}` : ""}`;
      parts.push(`## ${agent.name} asked · ${fmtTime(b.askedAt)}\n\n${asked}`);
      if (b.answer) {
        const said = b.status === "approved" ? "Approved" : b.status === "declined" ? "Declined" : "";
        parts.push(`## ${speaker()} answered · ${fmtTime(b.answer.at)}\n\n${[said, b.answer.text].filter(Boolean).join(" — ") || "_(no text)_"}`);
      } else if (b.status === "withdrawn") parts.push(`_The question was withdrawn${b.closedReason ? `: ${b.closedReason}` : "."}_`);
      continue;
    }
    if (b.type !== "user_message") continue;
    parts.push(`## ${speaker()} · ${fmtTime(b.sentAt)} · while ${agent.name} was working\n\n${b.text || "_(no text)_"}`);
    if (b.attachments.length) parts.push(files(b.attachments));
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
