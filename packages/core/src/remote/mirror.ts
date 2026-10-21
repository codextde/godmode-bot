/**
 * The controller's copy of what a runner does (owner: remote).
 *
 * A chat that works on a runner lives there: its messages, its runs, its queue. This computer keeps a copy under the
 * same ids, so the UI shows the chat like any other and still can while the runner is offline. This module writes that
 * copy — from the events the runner sends over the link (`applyRunnerEvent`), from the answers to forwarded requests
 * (`adoptChat`, `reconcileConversation`) and after every connect (`catchUp`) — and tells the local bus what changed.
 *
 * It is also where the other machine's word stops being trusted. A runner may create chats for agents that exist here
 * and may afterwards change only rows of chats whose `runner_id` is its own id. Everything it sends is read field by
 * field: an id is a plain token (ids become file names), a date is an ISO date, text has a length. What doesn't pass is
 * dropped without an answer. Nothing here imports remote/runners.ts; it calls back through `setMirrorHooks`.
 */
import type {
  AppNotification,
  Attachment,
  Conversation,
  ConversationFollowup,
  ConversationOrigin,
  ConversationWithMessages,
  Message,
  MessageBlock,
  MessageRole,
  MissingLogin,
  MissingLoginKind,
  MissingLoginStatus,
  NotificationKind,
  QueuedMessage,
  Run,
  RunDelta,
  RunDeltaState,
  RunPause,
  RunStatus,
  RunTrigger,
  ServerEvent,
} from "@godmode/shared";
import { EFFORT_OPTIONS, MAX_INSTRUCTIONS_LENGTH, applyRunDelta, isModelId, runnerView } from "@godmode/shared";
import { all, get, insert, run as sql, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getRun } from "../runner/runner";
import { addRunSnapshots } from "../server/ws";
import {
  DEFAULT_CONVERSATION_TITLE,
  conversationExists,
  emitConversationUpdated,
  getConversation,
  getConversationSummary,
  getMessage,
  type RunnerChatState,
} from "../services/conversations";
import { HttpError, now, truncate } from "../util";
import { getQuestion } from "../services/questions";
import { liteMessage } from "../services/liteMessage";
import { clearRemoteRun, clearRunner, remoteRuns, setRemoteRun } from "./activeRuns";
import { primaryRunnerId } from "./group";

const log = logger("mirror");

/** The link, as far as the mirror needs it. */
export interface RunnerApi {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface MirrorHooks {
  /** A run on a runner ended (remote/runners.ts exchanges the agent's memory then). */
  runFinished?(runnerId: string, run: Run): void;
  /** The copy of a run's in-flight message missed a delta: ask the runner for its whole block list (`run.resync`). */
  resync?(runnerId: string, runId: string): void;
  /** The chat moved to this computer and the runner hasn't dropped its copy yet: it is never adopted again. */
  released?(runnerId: string, conversationId: string): boolean;
}

let hooks: MirrorHooks = {};

export function setMirrorHooks(next: MirrorHooks): void {
  hooks = next;
}

/* ------------------------------------------------------------------ */
/* Reading what a runner sent                                          */
/* ------------------------------------------------------------------ */

/** Ids as `newId` makes them. They end up in file names (transcripts, run logs) and URLs, so nothing else passes. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** What `now()` stores. Run logs are filed under the first ten characters. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/** A Claude session id goes on a command line (`--resume <id>`) should the chat ever run here: it must not read as a flag. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** An in-app route like "/inbox" — never something the UI would leave the app for ("//host", "https://…"). */
const APP_LINK = /^\/(?!\/)[^\\\s\x00-\x1f]{0,499}$/;
/** The views a runner has (server/ws.ts `validView`); they are shown here as `runner:<id>:<view>`. */
const VIEW = /^(display|window|tab):/;

const TITLE_MAX = 200;
const NOTIFICATION_TITLE_MAX = 200;
const NOTIFICATION_BODY_MAX = 4000;
const LABEL_MAX = 300;
const QUEUE_MAX = 200;
/** Blocks of an in-flight message; a patch can't make this computer build a longer list. */
const LIVE_BLOCKS_MAX = 100_000;
/** A copy that fell behind asks the runner again after this long when the whole list didn't come. */
const RESYNC_EVERY_MS = 5_000;

const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled"];
const RUN_TRIGGERS: readonly RunTrigger[] = ["chat", "routine", "check", "dream", "delegation", "manual", "api", "followup", "task", "heartbeat"];
/** Without "dream": a runner doesn't dream, and a copied dream chat would be taken for the agent's own (memory/dreaming.ts). */
const ORIGINS: readonly ConversationOrigin[] = ["chat", "routine", "delegation", "api", "slack", "telegram", "teams", "task", "heartbeat"];
const ROLES: readonly MessageRole[] = ["user", "assistant", "system"];
const NOTIFICATION_KINDS: readonly NotificationKind[] = ["info", "success", "warning", "error", "missing_login", "run"];
const LOGIN_KINDS: readonly MissingLoginKind[] = ["missing_credential", "invalid_credential", "missing_totp", "missing_account", "other"];
const LOGIN_STATUSES: readonly MissingLoginStatus[] = ["open", "resolved", "dismissed"];

type Raw = Record<string, unknown>;
type RunEvent = "run.started" | "run.paused" | "run.finished";

function record(v: unknown): Raw | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

function safeId(v: unknown): string | null {
  return typeof v === "string" && SAFE_ID.test(v) ? v : null;
}

function isoDate(v: unknown): string | null {
  return typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Text, cut to `max` characters; null when it isn't text. */
function text(v: unknown, max = Number.POSITIVE_INFINITY): string | null {
  if (typeof v !== "string") return null;
  return v.length > max ? v.slice(0, max) : v;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function readAttachments(v: unknown): Attachment[] {
  return list(v).flatMap((item) => {
    const a = record(item);
    const size = finite(a?.size);
    return a && typeof a.name === "string" && typeof a.mime === "string" && typeof a.path === "string" && size !== null
      ? [{ name: a.name, mime: a.mime, path: a.path, size }]
      : [];
  });
}

function readPause(v: unknown): RunPause | null {
  const p = record(v);
  const runId = safeId(p?.runId);
  const pausedAt = isoDate(p?.pausedAt);
  if (!p || !runId || !pausedAt || (p.reason !== "user" && p.reason !== "limit")) return null;
  return { runId, reason: p.reason, pausedAt, limit: text(p.limit, LABEL_MAX), resumeAt: isoDate(p.resumeAt), auto: p.auto === true };
}

function readFollowup(v: unknown): ConversationFollowup | null {
  const f = record(v);
  const dueAt = isoDate(f?.dueAt);
  if (!f || !dueAt) return null;
  return { note: text(f.note, MAX_INSTRUCTIONS_LENGTH) ?? "", dueAt, createdAt: isoDate(f.createdAt) ?? dueAt };
}

/** A chat as a runner reports it, reduced to what this computer keeps of it. */
interface Chat {
  id: string;
  agentId: string;
  origin: ConversationOrigin;
  archived: boolean;
  createdAt: string;
  state: RunnerChatState;
  /** Its folder and shared screen there: kept only for another computer of the group, whose app shows them. */
  place: { working_directory: string | null; computer_target: string | null };
  /** The other computer only mirrors it too: it lives on a third one. */
  elsewhere: boolean;
  /** The columns that stay the runner's: written when the chat is adopted and on every update. */
  columns: {
    title: string;
    claude_session_id: string | null;
    model: string | null;
    effort: string | null;
    instructions: string;
    vm_id: string | null;
    browser_profile_id: string | null;
    ssh_server_ids: string;
    workspace_id: string | null;
    project_id: string | null;
    ultracode: number | null;
    last_message_at: string | null;
    updated_at: string;
    runner_state: string;
  };
}

function knownProject(id: string | null): string | null {
  return id && get("SELECT 1 FROM projects WHERE id = ?", id) ? id : null;
}

function readConversation(v: unknown): Chat | null {
  const c = record(v);
  const id = safeId(c?.id);
  const agentId = safeId(c?.agentId);
  const origin = oneOf(c?.origin, ORIGINS);
  const createdAt = isoDate(c?.createdAt);
  const updatedAt = isoDate(c?.updatedAt);
  const title = text(c?.title, TITLE_MAX);
  if (!c || !id || !agentId || !origin || !createdAt || !updatedAt || title === null) return null;
  const state: RunnerChatState = { running: c.running === true, paused: readPause(c.paused), followup: readFollowup(c.followup) };
  return {
    id,
    agentId,
    origin,
    archived: c.archived === true,
    createdAt,
    state,
    elsewhere: typeof c.runnerId === "string" && c.runnerId.length > 0,
    place: {
      working_directory: typeof c.workingDirectory === "string" && c.workingDirectory.startsWith("/") ? text(c.workingDirectory, 4096) : null,
      computer_target: record(c.computerTarget) ? JSON.stringify(c.computerTarget).slice(0, 4000) : null,
    },
    columns: {
      title: title.trim() || DEFAULT_CONVERSATION_TITLE,
      claude_session_id: typeof c.claudeSessionId === "string" && SESSION_ID.test(c.claudeSessionId) ? c.claudeSessionId : null,
      model: typeof c.model === "string" && isModelId(c.model) ? c.model : null,
      effort: oneOf(c.effort, EFFORT_OPTIONS),
      instructions: text(c.instructions, MAX_INSTRUCTIONS_LENGTH) ?? "",
      vm_id: safeId(c.vmId),
      browser_profile_id: safeId(c.browserProfileId),
      ssh_server_ids: JSON.stringify(list(c.sshServerIds).filter((s) => safeId(s) !== null)),
      workspace_id: safeId(c.workspaceId),
      // Only a project this computer knows (one deleted here meanwhile would break the foreign key).
      project_id: knownProject(safeId(c.projectId)),
      ultracode: typeof c.ultracode === "boolean" ? (c.ultracode ? 1 : 0) : null,
      last_message_at: isoDate(c.lastMessageAt),
      updated_at: updatedAt,
      runner_state: JSON.stringify(state),
    },
  };
}

type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  blocks: string;
  run_id: string | null;
  attachments: string;
  created_at: string;
};

const MESSAGE_COLUMNS = "id, conversation_id, role, content, blocks, run_id, attachments, created_at";

function readMessage(v: unknown): MessageRow | null {
  const m = record(v);
  const id = safeId(m?.id);
  const conversationId = safeId(m?.conversationId);
  const role = oneOf(m?.role, ROLES);
  const createdAt = isoDate(m?.createdAt);
  if (!m || !id || !conversationId || !role || !createdAt || typeof m.content !== "string") return null;
  return {
    id,
    conversation_id: conversationId,
    role,
    content: m.content,
    // What a block shows is the runner's business; that it is a block is checked, so the UI always finds a `type`.
    blocks: JSON.stringify(list(m.blocks).filter((b) => typeof record(b)?.type === "string")),
    run_id: safeId(m.runId),
    attachments: JSON.stringify(readAttachments(m.attachments)),
    created_at: createdAt,
  };
}

type RunRow = {
  id: string;
  agent_id: string;
  conversation_id: string;
  routine_id: string | null;
  parent_run_id: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  prompt: string;
  result: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
  usage: string | null;
  model: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

const RUN_COLUMNS =
  "id, agent_id, conversation_id, routine_id, parent_run_id, trigger, status, prompt, result, error, cost_usd, duration_ms, num_turns, usage, model, started_at, finished_at, created_at";

function readUsage(v: unknown): string | null {
  const u = record(v);
  const inputTokens = finite(u?.inputTokens);
  const outputTokens = finite(u?.outputTokens);
  const cacheReadTokens = finite(u?.cacheReadTokens);
  const cacheWriteTokens = finite(u?.cacheWriteTokens);
  if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) return null;
  return JSON.stringify({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
}

function readRun(v: unknown): RunRow | null {
  const r = record(v);
  const id = safeId(r?.id);
  const agentId = safeId(r?.agentId);
  const conversationId = safeId(r?.conversationId);
  const trigger = oneOf(r?.trigger, RUN_TRIGGERS);
  const status = oneOf(r?.status, RUN_STATUSES);
  const createdAt = isoDate(r?.createdAt);
  if (!r || !id || !agentId || !conversationId || !trigger || !status || !createdAt || typeof r.prompt !== "string") return null;
  return {
    id,
    agent_id: agentId,
    conversation_id: conversationId,
    // Automations run on this computer only. A runner's run never counts as one of theirs: the id would make
    // automations/events.ts change that automation's status.
    routine_id: null,
    parent_run_id: safeId(r.parentRunId),
    trigger,
    status,
    prompt: r.prompt,
    result: text(r.result),
    error: text(r.error),
    cost_usd: finite(r.costUsd),
    duration_ms: finite(r.durationMs),
    num_turns: finite(r.numTurns),
    usage: readUsage(r.usage),
    model: text(r.model, LABEL_MAX),
    started_at: isoDate(r.startedAt),
    finished_at: isoDate(r.finishedAt),
    created_at: createdAt,
  };
}

function readQueue(conversationId: string, v: unknown): QueuedMessage[] {
  return list(v)
    .slice(0, QUEUE_MAX)
    .flatMap((item) => {
      const q = record(item);
      const id = safeId(q?.id);
      const createdAt = isoDate(q?.createdAt);
      return q && id && createdAt && typeof q.content === "string" ? [{ id, conversationId, content: q.content, attachments: readAttachments(q.attachments), createdAt }] : [];
    });
}

/* ------------------------------------------------------------------ */
/* Whose row is it                                                     */
/* ------------------------------------------------------------------ */

/** The chat, when it is this runner's — the question every write asks first. */
function ownChat(runnerId: string, conversationId: string): { agent_id: string } | null {
  const row = get<{ agent_id: string; runner_id: string | null }>("SELECT agent_id, runner_id FROM conversations WHERE id = ?", conversationId);
  return row && row.runner_id === runnerId ? row : null;
}

/** A run stored here that belongs to one of this runner's chats. */
function ownRun(runnerId: string, runId: string): { agent_id: string; conversation_id: string } | null {
  const row = get<{ agent_id: string; conversation_id: string; runner_id: string | null }>(
    "SELECT r.agent_id, r.conversation_id, c.runner_id FROM runs r LEFT JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ?",
    runId,
  );
  return row && row.runner_id === runnerId ? row : null;
}

/** A run stored here that is not this runner's: a local one, or another runner's. */
function foreignRun(runnerId: string, runId: string): boolean {
  return get<{ id: string }>("SELECT id FROM runs WHERE id = ?", runId) !== null && !ownRun(runnerId, runId);
}

function changed<T extends object>(stored: T, next: T): boolean {
  return (Object.keys(next) as (keyof T)[]).some((k) => stored[k] !== next[k]);
}

/** The chat as the UI gets it, to tell whether a write changed anything it shows. */
function viewOf(conversationId: string): string | null {
  return conversationExists(conversationId) ? JSON.stringify(getConversationSummary(conversationId)) : null;
}

/* ------------------------------------------------------------------ */
/* Writing the copy                                                    */
/* ------------------------------------------------------------------ */

function isDevice(runnerId: string): boolean {
  return get<{ kind: string }>("SELECT kind FROM runners WHERE id = ?", runnerId)?.kind === "device";
}

/** Adopt a chat the runner reports for the first time, or bring its copy up to date. False: it isn't this runner's to write. */
function writeConversation(runnerId: string, chat: Chat): boolean {
  // A secondary keeps a copy of its primary's own chats only: those of the other computers it mirrors are theirs.
  if (chat.elsewhere && runnerId === primaryRunnerId()) return false;
  const row = get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", chat.id);
  const place = isDevice(runnerId) ? chat.place : {};
  if (row) {
    if (row.runner_id !== runnerId) return false;
    // `pinned` and `archived` stay as they are: the human files chats on this computer.
    update("conversations", chat.id, { ...chat.columns, ...place });
    return true;
  }
  if (!get<{ id: string }>("SELECT id FROM agents WHERE id = ?", chat.agentId) || hooks.released?.(runnerId, chat.id)) return false;
  insert("conversations", {
    id: chat.id,
    agent_id: chat.agentId,
    origin: chat.origin,
    // Folders and shared screens are this computer's; a chat on a runner has neither.
    working_directory: null,
    computer_target: null,
    runner_id: runnerId,
    pinned: 0,
    archived: chat.archived ? 1 : 0,
    created_at: chat.createdAt,
    ...chat.columns,
    ...place,
  });
  return true;
}

/**
 * A light copy of a message (screenshots as links, long output cut: liteMessage) doesn't replace what this computer
 * already has of it: a chat that comes back from the computer that stood in keeps its screenshots here.
 */
function keepWhole(stored: MessageRow, row: MessageRow): MessageRow {
  if (!row.blocks.includes('"imageUrl"') && !row.blocks.includes('"resultTruncated"')) return row;
  let mine: MessageBlock[];
  let theirs: MessageBlock[];
  try {
    mine = JSON.parse(stored.blocks) as MessageBlock[];
    theirs = JSON.parse(row.blocks) as MessageBlock[];
  } catch {
    return row;
  }
  const byId = new Map(mine.flatMap((b) => (b.type === "tool_use" ? [[b.id, b] as const] : [])));
  let kept = false;
  const blocks = theirs.map((b) => {
    if (b.type !== "tool_use") return b;
    const old = byId.get(b.id);
    if (!old || old.type !== "tool_use") return b;
    const lite = b as typeof b & { imageUrl?: string; resultTruncated?: boolean };
    let next: MessageBlock = b;
    if (lite.imageUrl && !b.image && old.image) {
      const { imageUrl: _url, ...rest } = lite;
      next = { ...rest, image: old.image };
      kept = true;
    }
    if (lite.resultTruncated && old.result && old.result.length > (b.result?.length ?? 0) && old.result.startsWith(b.result ?? "")) {
      const { resultTruncated: _cut, ...rest } = next as typeof lite;
      next = { ...rest, result: old.result };
      kept = true;
    }
    return next;
  });
  return kept ? { ...row, blocks: JSON.stringify(blocks) } : row;
}

/** Store one message of a runner's chat. Null: the chat isn't this runner's, or the id is taken by a message elsewhere. */
function writeMessage(runnerId: string, incoming: MessageRow): "inserted" | "updated" | null {
  if (!ownChat(runnerId, incoming.conversation_id)) return null;
  const stored = get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, incoming.id);
  if (!stored) {
    insert("messages", incoming);
    return "inserted";
  }
  if (stored.conversation_id !== incoming.conversation_id) return null;
  const row = keepWhole(stored, incoming);
  if (changed(stored, row)) {
    const { id, conversation_id: _chat, ...rest } = row;
    update("messages", id, rest);
  }
  return "updated";
}

/**
 * Make a chat's messages the runner's list, in the runner's order. `listMessages` sorts by time, then by the order rows
 * were inserted: messages the runner dropped are deleted and new ones at the end appended; when one was missed in the
 * middle (or the order differs), the chat's messages are written again, in order. Returns what the UI doesn't know yet.
 */
function writeMessages(conversationId: string, incoming: unknown, keepOwn = false): { created: string[]; updated: string[]; removed: number } {
  const stored = all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`, conversationId);
  const known = new Map(stored.map((m) => [m.id, m]));
  const rows: MessageRow[] = [];
  const ids = new Set<string>();
  for (const item of list(incoming)) {
    const row = readMessage(item);
    if (!row || row.conversation_id !== conversationId || ids.has(row.id)) continue;
    // An id that is a message of another chat here is never taken over.
    if (!known.has(row.id) && get<{ id: string }>("SELECT id FROM messages WHERE id = ?", row.id)) continue;
    ids.add(row.id);
    rows.push(known.has(row.id) ? keepWhole(known.get(row.id)!, row) : row);
  }
  const kept = stored.filter((m) => ids.has(m.id));
  const created = rows.filter((r) => !known.has(r.id)).map((r) => r.id);
  const updated = rows.filter((r) => known.has(r.id) && changed(known.get(r.id)!, r)).map((r) => r.id);
  // Another computer of the group may have only part of a chat (a copy without old messages): what is here stays.
  if (keepOwn) {
    for (const row of rows) {
      if (!known.has(row.id)) insert("messages", row);
      else if (updated.includes(row.id)) {
        const { id, conversation_id: _chat, ...rest } = row;
        update("messages", id, rest);
      }
    }
    return { created, updated, removed: 0 };
  }
  const removed = stored.length - kept.length;

  if (kept.every((m, i) => rows[i]!.id === m.id)) {
    for (const m of stored) if (!ids.has(m.id)) sql("DELETE FROM messages WHERE id = ? AND conversation_id = ?", m.id, conversationId);
    for (const row of rows) {
      if (!known.has(row.id)) insert("messages", row);
      else if (updated.includes(row.id)) {
        const { id, conversation_id: _chat, ...rest } = row;
        update("messages", id, rest);
      }
    }
  } else {
    sql("DELETE FROM messages WHERE conversation_id = ?", conversationId);
    for (const row of rows) insert("messages", row);
  }
  return { created, updated, removed };
}

/**
 * Store a run of a runner's chat and keep the registry of working runs in step. Null: not this runner's to write.
 * `before` is the status the copy had (null = the run is new here).
 */
function writeRun(runnerId: string, row: RunRow): { before: RunStatus | null } | null {
  const chat = ownChat(runnerId, row.conversation_id);
  // A chat's runs are its agent's: no run is booked on another agent.
  if (!chat || chat.agent_id !== row.agent_id) return null;
  const stored = get<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, row.id);
  if (stored && stored.conversation_id !== row.conversation_id) return null;
  // A run that ended doesn't start again: an answer that was on its way while the run finished must not bring it back.
  if (stored && TERMINAL.has(stored.status) && !TERMINAL.has(row.status)) return null;
  // Cancelling a run cancels what it delegated (runner/runner.ts): a runner's run must not hang on a run that isn't its own.
  const next: RunRow = { ...row, parent_run_id: row.parent_run_id && !foreignRun(runnerId, row.parent_run_id) ? row.parent_run_id : null };
  if (!stored) insert("runs", next);
  else if (changed(stored, next)) {
    const { id, conversation_id: _chat, ...rest } = next;
    update("runs", id, rest);
  }
  if (next.status === "queued" || next.status === "running" || next.status === "paused") {
    setRemoteRun({ runId: next.id, conversationId: next.conversation_id, agentId: next.agent_id, runnerId, status: next.status });
  } else clearRemoteRun(next.id);
  return { before: stored?.status ?? null };
}

function runFinished(runnerId: string, run: Run): void {
  try {
    hooks.runFinished?.(runnerId, run);
  } catch (err) {
    log.warn(`the hook for the end of run ${run.id} failed`, err);
  }
}

function emitRun(runnerId: string, type: RunEvent, runId: string): void {
  if (type !== "run.started") forgetLive(runId);
  const run = getRun(runId);
  bus.emit({ type, run });
  if (type === "run.finished") runFinished(runnerId, run);
}

/* ------------------------------------------------------------------ */
/* Events from the runner                                              */
/* ------------------------------------------------------------------ */

function onRun(runnerId: string, type: RunEvent, raw: unknown): boolean {
  const row = readRun(raw);
  if (!row) return false;
  const fits = type === "run.finished" ? TERMINAL.has(row.status) : type === "run.paused" ? row.status === "paused" : row.status === "queued" || row.status === "running";
  if (!fits || !writeRun(runnerId, row)) return false;
  emitRun(runnerId, type, row.id);
  return true;
}

interface LiveRun extends RunDeltaState {
  runnerId: string;
  conversationId: string;
  messageId: string;
}

/**
 * The in-flight message of the runs on runners, as their deltas built it: what the runner's patches apply to, and what
 * a UI here gets when it joins, missed a delta or doesn't apply patches.
 */
const live = new Map<string, LiveRun>();
/** When the whole list of a run was last asked for. */
const resyncs = new Map<string, number>();

function forgetLive(runId: string): void {
  live.delete(runId);
  resyncs.delete(runId);
}

addRunSnapshots((want) => {
  const out: RunDelta[] = [];
  for (const [runId, r] of live) {
    if ((want.runId && want.runId !== runId) || (want.conversationId && want.conversationId !== r.conversationId)) continue;
    out.push({ type: "run.delta", runId, conversationId: r.conversationId, messageId: r.messageId, ...(r.stream !== undefined ? { stream: r.stream } : {}), seq: r.seq, blocks: r.blocks });
  }
  return out;
});

function isBlock(v: unknown): v is MessageBlock {
  return typeof record(v)?.type === "string";
}

function readPatch(patch: unknown, length: unknown): { patch: [number, MessageBlock][]; length: number } | null {
  if (!Array.isArray(patch) || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > LIVE_BLOCKS_MAX) return null;
  const out: [number, MessageBlock][] = [];
  for (const entry of patch) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [index, block] = entry as [unknown, unknown];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= length || !isBlock(block)) return null;
    out.push([index, block]);
  }
  return { patch: out, length };
}

function askForWhole(runnerId: string, runId: string): void {
  const at = Date.now();
  if (at - (resyncs.get(runId) ?? 0) < RESYNC_EVERY_MS) return;
  resyncs.set(runId, at);
  try {
    hooks.resync?.(runnerId, runId);
  } catch (err) {
    log.warn(`could not ask runner ${runnerId} for the whole run ${runId}`, err);
  }
}

function onDelta(runnerId: string, e: Raw): boolean {
  const runId = safeId(e.runId);
  const conversationId = safeId(e.conversationId);
  const messageId = safeId(e.messageId);
  if (!runId || !conversationId || !messageId || !ownChat(runnerId, conversationId)) return false;
  // The UI puts the blocks into that message of that run: neither may be something of another chat.
  const message = get<{ conversation_id: string }>("SELECT conversation_id FROM messages WHERE id = ?", messageId);
  const run = get<{ conversation_id: string }>("SELECT conversation_id FROM runs WHERE id = ?", runId);
  if ((message && message.conversation_id !== conversationId) || (run && run.conversation_id !== conversationId)) return false;
  const patch = Array.isArray(e.blocks) ? null : readPatch(e.patch, e.length);
  if (!Array.isArray(e.blocks) && !patch) return false;
  const delta: RunDelta = {
    type: "run.delta",
    runId,
    conversationId,
    messageId,
    ...(Array.isArray(e.blocks) ? { blocks: e.blocks.filter(isBlock) } : patch!),
    ...(typeof e.stream === "string" && e.stream.length <= 100 ? { stream: e.stream } : {}),
    ...(typeof e.seq === "number" && Number.isSafeInteger(e.seq) && e.seq >= 0 ? { seq: e.seq } : {}),
    ...(typeof e.textDelta === "string" ? { textDelta: e.textDelta } : {}),
  };
  const have = live.get(runId);
  const next = applyRunDelta(have && have.runnerId === runnerId && have.messageId === messageId ? have : null, delta);
  if (!next) {
    // Missed one: the UIs keep what they show until the whole list comes.
    askForWhole(runnerId, runId);
    return true;
  }
  live.set(runId, { ...next, runnerId, conversationId, messageId });
  resyncs.delete(runId);
  // Passed on as it came: patches to the UIs that apply them, the whole list (ws.ts, from `live`) to the others.
  bus.emit(delta);
  return true;
}

function onActivity(runnerId: string, e: Raw): boolean {
  const runId = safeId(e.runId);
  const label = text(e.label, LABEL_MAX);
  const run = runId ? ownRun(runnerId, runId) : null;
  if (!runId || label === null || !run) return false;
  const working = remoteRuns(runnerId).find((r) => r.runId === runId);
  if (working) setRemoteRun({ ...working, label });
  bus.emit({ type: "run.activity", runId, agentId: run.agent_id, label });
  return true;
}

function onQueue(runnerId: string, e: Raw): boolean {
  const conversationId = safeId(e.conversationId);
  if (!conversationId || !Array.isArray(e.queue) || !ownChat(runnerId, conversationId)) return false;
  bus.emit({ type: "queue.updated", conversationId, queue: readQueue(conversationId, e.queue) });
  return true;
}

function onMessage(runnerId: string, type: "message.created" | "message.updated", raw: unknown): boolean {
  // The copy of the primary's chats is for while it is away: screenshots stay there.
  const row = readMessage(runnerId === primaryRunnerId() && record(raw) ? liteMessage(raw as unknown as Message) : raw);
  if (!row || !writeMessage(runnerId, row)) return false;
  bus.emit({ type, message: getMessage(row.id) });
  return true;
}

function onConversation(runnerId: string, raw: unknown): boolean {
  const chat = readConversation(raw);
  if (!chat || !writeConversation(runnerId, chat)) return false;
  emitConversationUpdated(chat.id);
  return true;
}

function onConversationDeleted(runnerId: string, raw: unknown): boolean {
  const id = safeId(raw);
  if (!id || !ownChat(runnerId, id)) return false;
  tx(() => {
    sql("DELETE FROM messages WHERE conversation_id = ?", id);
    sql("DELETE FROM conversations WHERE id = ? AND runner_id = ?", id, runnerId);
  });
  for (const r of remoteRuns(runnerId)) if (r.conversationId === id) clearRemoteRun(r.runId);
  bus.emit({ type: "conversation.deleted", id });
  return true;
}

type MissingLoginRow = {
  id: string;
  agent_id: string | null;
  run_id: string | null;
  workspace_id: string | null;
  kind: MissingLoginKind;
  service: string;
  url: string;
  reason: string;
  status: MissingLoginStatus;
  credential_id: string | null;
  occurrences: number;
  created_at: string;
  updated_at: string;
};

const MISSING_LOGIN_COLUMNS = "id, agent_id, run_id, workspace_id, kind, service, url, reason, status, credential_id, occurrences, created_at, updated_at";

/**
 * A login an agent missed on the runner goes into this computer's inbox. A report is the runner's when the run it came
 * from is: that is checked for the report itself and, before an existing row is changed, for the row. Which login
 * resolved it is decided here, so `credential_id` is never taken from the runner.
 */
function onMissingLogin(runnerId: string, raw: unknown): boolean {
  const item = record(raw);
  const id = safeId(item?.id);
  const runId = safeId(item?.runId);
  const service = text(item?.service, 200)?.trim();
  const updatedAt = isoDate(item?.updatedAt);
  const run = runId ? ownRun(runnerId, runId) : null;
  if (!item || !id || !runId || !service || !updatedAt || !run) return false;
  const stored = get<{ run_id: string | null }>("SELECT run_id FROM missing_logins WHERE id = ?", id);
  if (stored && !(stored.run_id && ownRun(runnerId, stored.run_id))) return false;
  const fields = {
    agent_id: run.agent_id,
    run_id: runId,
    workspace_id: safeId(item.workspaceId),
    kind: oneOf(item.kind, LOGIN_KINDS) ?? "other",
    service,
    url: text(item.url, 2000) ?? "",
    reason: text(item.reason, 2000) ?? "",
    status: oneOf(item.status, LOGIN_STATUSES) ?? "open",
    occurrences: Math.max(1, Math.floor(finite(item.occurrences) ?? 1)),
    updated_at: updatedAt,
  };
  if (stored) update("missing_logins", id, fields);
  else insert("missing_logins", { id, ...fields, credential_id: null, created_at: isoDate(item.createdAt) ?? updatedAt });
  const r = get<MissingLoginRow>(`SELECT ${MISSING_LOGIN_COLUMNS} FROM missing_logins WHERE id = ?`, id)!;
  const local: MissingLogin = {
    id: r.id,
    agentId: r.agent_id,
    runId: r.run_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    service: r.service,
    url: r.url,
    reason: r.reason,
    status: r.status,
    credentialId: r.credential_id,
    occurrences: r.occurrences,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  bus.emit({ type: stored ? "missing-login.updated" : "missing-login.created", item: local });
  return true;
}

/** Stored and shown once per id; whether it was read is this computer's. */
function onNotification(raw: unknown): boolean {
  const n = record(raw);
  const id = safeId(n?.id);
  const title = text(n?.title)?.trim();
  if (!n || !id || !title || get<{ id: string }>("SELECT id FROM notifications WHERE id = ?", id)) return false;
  const notification: AppNotification = {
    id,
    kind: oneOf(n.kind, NOTIFICATION_KINDS) ?? "info",
    title: truncate(title, NOTIFICATION_TITLE_MAX),
    body: truncate(text(n.body) ?? "", NOTIFICATION_BODY_MAX),
    link: typeof n.link === "string" && APP_LINK.test(n.link) ? n.link : null,
    read: false,
    createdAt: isoDate(n.createdAt) ?? now(),
  };
  insert("notifications", {
    id,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    read: 0,
    created_at: notification.createdAt,
  });
  bus.emit({ type: "notification", notification });
  return true;
}

/** A chat's browser tab on the runner. Frames of the runner's other browsing are nobody's to watch here. */
function onBrowserFrame(runnerId: string, e: Raw): boolean {
  const profileId = safeId(e.profileId);
  const conversationId = safeId(e.conversationId);
  const width = finite(e.width);
  const height = finite(e.height);
  if (!profileId || !conversationId || typeof e.data !== "string" || width === null || height === null || !ownChat(runnerId, conversationId)) return false;
  bus.emit({ type: "browser.frame", profileId, conversationId, data: e.data, url: text(e.url, 4000) ?? "", title: text(e.title, 500) ?? "", width, height });
  return true;
}

/** The runner's screen: its views are named `runner:<id>:<view>` here, so they never pass for a view of this computer. */
function onComputer(runnerId: string, type: "computer.frame" | "computer.action", e: Raw): boolean {
  if (typeof e.view !== "string" || e.view.length > 300 || !VIEW.test(e.view)) return false;
  const view = runnerView(runnerId, e.view);
  if (type === "computer.action") {
    const runId = safeId(e.runId);
    const action = text(e.action, LABEL_MAX);
    const x = finite(e.x);
    const y = finite(e.y);
    if (!runId || action === null) return false;
    bus.emit({ type, view, runId, action, ...(x !== null ? { x } : {}), ...(y !== null ? { y } : {}) });
    return true;
  }
  const width = finite(e.width);
  const height = finite(e.height);
  if (typeof e.data !== "string" || width === null || height === null) return false;
  const mime = e.mime === "image/png" ? "image/png" : "image/jpeg";
  const error = text(e.error, 1000);
  bus.emit({ type, view, data: e.data, mime, width, height, label: text(e.label, LABEL_MAX) ?? "", ...(error !== null ? { error } : {}) });
  return true;
}

const QUESTION_KINDS = ["question", "approval"] as const;
const QUESTION_STATUSES = ["open", "answered", "approved", "declined", "withdrawn"] as const;
const ANSWER_VIA = ["app", "phone", "task", "slack", "telegram", "teams", "call"] as const;

/**
 * What an agent asked in a runner's chat: kept here so the human answers it from this computer's inbox and My tasks.
 * The answer goes to the runner, where the run waits (routing.ts); the runner's next update settles the copy.
 */
function onQuestion(runnerId: string, type: "question.created" | "question.updated", raw: unknown): boolean {
  const q = record(raw);
  const id = safeId(q?.id);
  const runId = safeId(q?.runId);
  const conversationId = safeId(q?.conversationId);
  const messageId = safeId(q?.messageId);
  const kind = oneOf(q?.kind, QUESTION_KINDS);
  const status = oneOf(q?.status, QUESTION_STATUSES);
  const createdAt = isoDate(q?.createdAt);
  const updatedAt = isoDate(q?.updatedAt);
  const title = text(q?.title, 500);
  const chat = conversationId ? ownChat(runnerId, conversationId) : null;
  if (!q || !id || !runId || !conversationId || !messageId || !kind || !status || !createdAt || !updatedAt || title === null || !chat) return false;
  const stored = get<{ conversation_id: string }>("SELECT conversation_id FROM questions WHERE id = ?", id);
  if (stored && stored.conversation_id !== conversationId) return false;
  const answer = record(q.answer);
  const options = list(q.options).flatMap((o) => {
    const opt = record(o);
    const oid = text(opt?.id, 20);
    const label = text(opt?.label, 500);
    return opt && oid && label !== null
      ? [{ id: oid, label, ...(typeof opt.description === "string" ? { description: text(opt.description, 2000) } : {}), ...(opt.recommended === true ? { recommended: true } : {}) }]
      : [];
  });
  const fields = {
    kind,
    agent_id: chat.agent_id,
    run_id: runId,
    conversation_id: conversationId,
    message_id: messageId,
    task_id: null,
    routine_id: null,
    workspace_id: safeId(q.workspaceId),
    title,
    body: text(q.body, 20_000) ?? "",
    affects: text(q.affects, 4000) ?? "",
    options: JSON.stringify(options),
    status,
    option_id: answer ? text(answer.optionId, 20) : null,
    answer: answer ? text(answer.text, 20_000) : null,
    answer_attachments: JSON.stringify(answer ? readAttachments(answer.attachments) : []),
    answered_via: answer ? oneOf(answer.via, ANSWER_VIA) : null,
    answered_at: answer ? isoDate(answer.at) : null,
    closed_reason: text(q.closedReason, 2000),
    updated_at: updatedAt,
  };
  if (stored) update("questions", id, fields);
  else {
    // A run waits for one question at a time: an older open one of the same run was settled there meanwhile.
    if (status === "open") sql("UPDATE questions SET status = 'withdrawn', updated_at = ? WHERE run_id = ? AND status = 'open' AND id != ?", updatedAt, runId, id);
    insert("questions", { id, ...fields, created_at: createdAt });
  }
  bus.emit({ type: stored ? "question.updated" : type, question: getQuestion(id) });
  bus.changed("questions");
  return true;
}

function apply(runnerId: string, raw: unknown): boolean {
  const e = record(raw);
  if (!e || !runnerId) return false;
  const type = e.type;
  switch (type) {
    case "run.started":
    case "run.paused":
    case "run.finished":
      return onRun(runnerId, type, e.run);
    case "run.delta":
      return onDelta(runnerId, e);
    case "run.activity":
      return onActivity(runnerId, e);
    case "queue.updated":
      return onQueue(runnerId, e);
    case "message.created":
    case "message.updated":
      return onMessage(runnerId, type, e.message);
    case "conversation.updated":
      return onConversation(runnerId, e.conversation);
    case "conversation.deleted":
      return onConversationDeleted(runnerId, e.id);
    case "missing-login.created":
    case "missing-login.updated":
      return onMissingLogin(runnerId, e.item);
    case "question.created":
    case "question.updated":
      return onQuestion(runnerId, type, e.question);
    case "notification":
      return onNotification(e.notification);
    case "browser.frame":
      return onBrowserFrame(runnerId, e);
    case "computer.frame":
    case "computer.action":
      return onComputer(runnerId, type, e);
    default:
      // Agents, automations, tasks, the vault, VMs, …: the runner's copy of this computer's own setup.
      return false;
  }
}

/**
 * Take one event a runner sent over the link: store what it says about the runner's own chats and pass it on to the
 * local bus. Anything else is dropped. Never throws — a bad event must not take the link down.
 */
export function applyRunnerEvent(runnerId: string, event: ServerEvent): void {
  try {
    if (!apply(runnerId, event)) log.debug("dropped an event from a runner", { runnerId, type: text(record(event)?.type, 60) });
  } catch (err) {
    log.warn(`could not apply an event from runner ${runnerId}`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Answers from the runner                                             */
/* ------------------------------------------------------------------ */

/** The runner answered with a chat this computer won't keep: unreadable, for an agent that isn't here, or someone else's. */
function refused(): HttpError {
  return new HttpError(502, "Couldn't copy that chat from the runner", "runner_chat_refused");
}

/** The chat a runner just started (its answer to POST /api/chat) becomes a chat here. Returns the local view. */
export function adoptChat(runnerId: string, result: { conversation: Conversation; message?: Message; run?: Run }): Conversation {
  const chat = readConversation(result.conversation);
  if (!chat || !writeConversation(runnerId, chat)) throw refused();
  // The events of the start usually came first; whatever they left out is told now.
  const message = readMessage(result.message);
  if (message && message.conversation_id === chat.id && writeMessage(runnerId, message) === "inserted") {
    bus.emit({ type: "message.created", message: getMessage(message.id) });
  }
  const run = readRun(result.run);
  const wrote = run && run.conversation_id === chat.id ? writeRun(runnerId, run) : null;
  if (run && wrote && wrote.before === null && !TERMINAL.has(run.status)) emitRun(runnerId, run.status === "paused" ? "run.paused" : "run.started", run.id);
  emitConversationUpdated(chat.id);
  return getConversationSummary(chat.id);
}

/** What a changed copy of a run means for those who watch runs. A run that is new here and already over is history: nothing. */
function runEventFor(before: RunStatus | null, after: RunStatus): RunEvent | null {
  if (TERMINAL.has(after)) return before && !TERMINAL.has(before) ? "run.finished" : null;
  if (before === after) return null;
  return after === "paused" ? "run.paused" : "run.started";
}

/**
 * After the runner described one chat: forget the runs it no longer counts as working there, and know the one it names.
 * It names the running run before a queued one, so any other run thought to be running has ended unnoticed.
 */
function followActive(runnerId: string, chat: Chat, activeRunId: string | null): void {
  for (const r of remoteRuns(runnerId)) {
    if (r.conversationId !== chat.id) continue;
    const gone = r.status === "paused" ? chat.state.paused?.runId !== r.runId : activeRunId === null || (r.status === "running" && r.runId !== activeRunId);
    if (gone) clearRemoteRun(r.runId);
  }
  if (!activeRunId || remoteRuns(runnerId).some((r) => r.runId === activeRunId)) return;
  const stored = get<{ conversation_id: string; status: RunStatus }>("SELECT conversation_id, status FROM runs WHERE id = ?", activeRunId);
  if (stored && (stored.conversation_id !== chat.id || TERMINAL.has(stored.status))) return;
  const agentId = ownChat(runnerId, chat.id)?.agent_id;
  if (agentId) setRemoteRun({ runId: activeRunId, conversationId: chat.id, agentId, runnerId, status: stored?.status === "queued" ? "queued" : "running" });
}

/** `was`: the chat's local view to compare with (undefined = as it is now, before anything is written). */
function reconcile(runnerId: string, remote: unknown, runs: unknown, was?: string | null): ConversationWithMessages {
  const chat = readConversation(remote);
  // An answer without a message list is not a chat without messages: the copy must not be emptied over it.
  if (!chat || !Array.isArray((remote as Raw).messages)) throw refused();
  const before = was === undefined ? viewOf(chat.id) : was;
  const messages = tx(() => (writeConversation(runnerId, chat) ? writeMessages(chat.id, (remote as Raw).messages, isDevice(runnerId)) : null));
  if (!messages) throw refused();

  const runEvents: { type: RunEvent; id: string }[] = [];
  for (const item of list(runs)) {
    const run = readRun(item);
    const wrote = run && run.conversation_id === chat.id ? writeRun(runnerId, run) : null;
    const type = run && wrote ? runEventFor(wrote.before, run.status) : null;
    if (run && type) runEvents.push({ type, id: run.id });
  }
  const activeRunId = safeId((remote as Raw).activeRunId);
  followActive(runnerId, chat, activeRunId);

  // Only what changed is told: the UI asks for the chat again on every one of these.
  for (const id of messages.created) bus.emit({ type: "message.created", message: getMessage(id) });
  for (const id of messages.updated) bus.emit({ type: "message.updated", message: getMessage(id) });
  for (const e of runEvents) emitRun(runnerId, e.type, e.id);
  if (messages.removed > 0 || viewOf(chat.id) !== before) emitConversationUpdated(chat.id);

  return { ...getConversation(chat.id), activeRunId, queue: readQueue(chat.id, (remote as Raw).queue) };
}

/**
 * Bring the copy of one chat in line with the runner's answer (GET /api/conversations/:id, and its runs when given):
 * the chat, all its messages — local ones the runner no longer has go — and its runs. Returns the local view with the
 * runner's active run and queue, which live there only.
 */
export function reconcileConversation(runnerId: string, remote: ConversationWithMessages, runs?: Run[]): ConversationWithMessages {
  return reconcile(runnerId, remote, runs);
}

/** Does the copy of this chat need its messages and runs fetched again? Asked before the runner's summary is written. */
function behind(runnerId: string, chat: Chat): boolean {
  const row = get<{ runner_id: string | null; updated_at: string; last_message_at: string | null }>(
    "SELECT runner_id, updated_at, last_message_at FROM conversations WHERE id = ?",
    chat.id,
  );
  if (!row) return true;
  if (row.runner_id !== runnerId) return false;
  const local = getConversationSummary(chat.id);
  return (
    row.updated_at !== chat.columns.updated_at ||
    row.last_message_at !== chat.columns.last_message_at ||
    chat.state.running ||
    local.running === true ||
    (local.paused?.runId ?? null) !== (chat.state.paused?.runId ?? null) ||
    get<{ id: string }>("SELECT id FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running') LIMIT 1", chat.id) !== null
  );
}

function offline(err: unknown): boolean {
  return err instanceof HttpError && err.code === "runner_offline";
}

/**
 * Chats whose messages broke the link while they came (older runners drop frames of an answer that large): the
 * next catch-ups leave them out for a while, so one long chat can't keep its runner offline and out of reach of the
 * update that fixes it. Its live events still arrive.
 */
const heavy = new Map<string, { drops: number; until: number }>();
const HEAVY_AFTER_DROPS = 2;
const HEAVY_SKIP_MS = 30 * 60_000;

function skipHeavy(runnerId: string, chatId: string): boolean {
  const entry = heavy.get(`${runnerId}:${chatId}`);
  return !!entry && entry.drops >= HEAVY_AFTER_DROPS && Date.now() < entry.until;
}

function droppedWhileFetching(runnerId: string, chatId: string): void {
  const key = `${runnerId}:${chatId}`;
  const drops = (heavy.get(key)?.drops ?? 0) + 1;
  heavy.set(key, { drops, until: Date.now() + HEAVY_SKIP_MS });
  if (drops === HEAVY_AFTER_DROPS) log.warn(`the messages of conversation ${chatId} keep breaking the link to runner ${runnerId}; catch-ups leave them out for now`);
}

/** The runner runs another Godmode now: what broke the link before may not anymore. */
export function forgetHeavyChats(runnerId: string): void {
  for (const key of heavy.keys()) if (key.startsWith(`${runnerId}:`)) heavy.delete(key);
}

/**
 * After every connect: what happened on the runner while nobody listened. Its chats (active and archived) are adopted
 * or updated; those whose copy is behind get their messages and runs fetched; the registry of working runs is rebuilt
 * from the runner's answer. Chats the runner no longer has stay as they are.
 */
export async function catchUp(runnerId: string, api: RunnerApi, opts: CatchUpOptions = {}): Promise<{ conversations: number; refreshed: number }> {
  const lists = [await api.json<unknown>("GET", "/api/conversations?limit=500"), await api.json<unknown>("GET", "/api/conversations?limit=500&archived=1")];
  const since = opts.messagesSince ? Date.parse(opts.messagesSince) : null;
  let conversations = 0;
  let refreshed = 0;
  for (const item of lists.flatMap(list)) {
    const chat = readConversation(item);
    if (!chat) continue;
    const stale = behind(runnerId, chat);
    const before = viewOf(chat.id);
    if (!writeConversation(runnerId, chat)) continue;
    conversations++;
    // Old and quiet: the copy keeps the chat itself, its messages come once it moves on.
    const quiet = since !== null && !chat.state.running && !chat.state.paused && Date.parse(chat.columns.last_message_at ?? chat.columns.updated_at) < since;
    if (stale && !quiet && !skipHeavy(runnerId, chat.id)) {
      try {
        const path = encodeURIComponent(chat.id);
        const detail = await api.json<unknown>("GET", `/api/conversations/${path}${opts.lite ? "?lite=1" : ""}`);
        const runs = await api.json<unknown>("GET", `/api/runs?conversationId=${path}&limit=500`);
        if (record(detail)?.id !== chat.id) throw refused();
        heavy.delete(`${runnerId}:${chat.id}`);
        reconcile(runnerId, detail, runs, before);
        refreshed++;
        continue;
      } catch (err) {
        if (offline(err)) {
          droppedWhileFetching(runnerId, chat.id);
          throw err;
        }
        log.warn(`could not catch up on conversation ${chat.id} of runner ${runnerId}`, err);
      }
    }
    if (viewOf(chat.id) !== before) emitConversationUpdated(chat.id);
  }

  const working = await api.json<unknown>("GET", "/api/runs?status=queued,running,paused&limit=500");
  clearRunner(runnerId);
  // Newest first in the answer; told oldest first, the order they started in.
  for (const item of list(working).reverse()) {
    const run = readRun(item);
    if (!run || TERMINAL.has(run.status) || !writeRun(runnerId, run)) continue;
    emitRun(runnerId, run.status === "paused" ? "run.paused" : "run.started", run.id);
  }
  log.info("caught up with a runner", { runnerId, conversations, refreshed, working: remoteRuns(runnerId).length });
  return { conversations, refreshed };
}

export interface CatchUpOptions {
  /** Messages without screenshots and with tool output cut (a secondary's copy of its primary's chats). */
  lite?: boolean;
  /** Only chats with messages since then get their messages; older ones keep the chat alone. */
  messagesSince?: string;
}

/** One chat of the runner, fetched now (a change of the shared data points at it). */
export async function fetchConversation(runnerId: string, api: RunnerApi, conversationId: string, opts: CatchUpOptions = {}): Promise<boolean> {
  const path = encodeURIComponent(conversationId);
  try {
    const detail = await api.json<unknown>("GET", `/api/conversations/${path}${opts.lite ? "?lite=1" : ""}`);
    if (record(detail)?.id !== conversationId) return false;
    const runs = await api.json<unknown>("GET", `/api/runs?conversationId=${path}&limit=500`);
    reconcile(runnerId, detail, runs);
    return true;
  } catch (err) {
    log.info(`could not fetch conversation ${conversationId} of runner ${runnerId}`, { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** A chat of this runner moved to this computer: nothing of it works there for this computer anymore. */
export function chatMovedHere(runnerId: string, conversationId: string): void {
  for (const [runId, r] of live) if (r.conversationId === conversationId) forgetLive(runId);
  for (const r of remoteRuns(runnerId)) if (r.conversationId === conversationId) clearRemoteRun(r.runId);
}

/** The link to a runner dropped: nothing is known to work there anymore. The copies keep what the runner said last. */
export function runnerDisconnected(runnerId: string): void {
  for (const [runId, r] of live) if (r.runnerId === runnerId) forgetLive(runId);
  clearRunner(runnerId);
}

/**
 * A chat another computer of the group hands over becomes this computer's own (remote/devices.ts): read like a runner's
 * chat, field by field, and stored without a runner. Runs that were still open there end here; the agent continues in
 * a new turn. A copy this computer kept of the chat (it mirrored it) is replaced.
 */
export function importChat(conversation: unknown, messages: unknown, runs: unknown): { id: string; agentId: string } {
  const chat = readConversation(conversation);
  if (!chat) throw new HttpError(400, "That chat couldn't be read", "bad_request");
  if (!get<{ id: string }>("SELECT id FROM agents WHERE id = ?", chat.agentId)) {
    throw new HttpError(409, "This computer doesn't have the chat's agent yet. Wait until the setup is copied, then try again.", "agent_missing");
  }
  const stored = get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", chat.id);
  if (stored && stored.runner_id === null) throw new HttpError(409, "This chat already works on this computer.", "chat_here");
  const ts = now();
  tx(() => {
    if (stored) {
      sql("DELETE FROM messages WHERE conversation_id = ?", chat.id);
      sql("DELETE FROM conversations WHERE id = ?", chat.id);
    }
    for (const r of remoteRuns()) if (r.conversationId === chat.id) clearRemoteRun(r.runId);
    insert("conversations", {
      id: chat.id,
      agent_id: chat.agentId,
      origin: chat.origin,
      working_directory: null,
      computer_target: null,
      runner_id: null,
      pinned: 0,
      archived: chat.archived ? 1 : 0,
      created_at: chat.createdAt,
      ...chat.columns,
      vm_id: null,
      ssh_server_ids: "[]",
      runner_state: null,
    });
    const seen = new Set<string>();
    for (const item of list(messages)) {
      const row = readMessage(item);
      if (!row || row.conversation_id !== chat.id || seen.has(row.id) || get<{ id: string }>("SELECT id FROM messages WHERE id = ?", row.id)) continue;
      seen.add(row.id);
      insert("messages", row);
    }
    for (const item of list(runs)) {
      const row = readRun(item);
      if (!row || row.conversation_id !== chat.id || row.agent_id !== chat.agentId) continue;
      const open = !TERMINAL.has(row.status);
      const next: RunRow = { ...row, parent_run_id: null, ...(open ? { status: "failed" as const, error: "Ended: the chat moved to another computer", finished_at: ts } : {}) };
      if (get<{ id: string }>("SELECT id FROM runs WHERE id = ?", row.id)) {
        const { id, conversation_id: _chat, ...rest } = next;
        update("runs", id, rest);
      } else insert("runs", next);
    }
  });
  for (const [runId, r] of live) if (r.conversationId === chat.id) forgetLive(runId);
  emitConversationUpdated(chat.id);
  bus.changed("runs");
  return { id: chat.id, agentId: chat.agentId };
}
