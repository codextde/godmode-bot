import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Attachment, Conversation, Message, MessageBlock, SharedChatPreview } from "@godmode/shared";
import { CHAT_SHARE_CODE_PREFIX } from "@godmode/shared";
import { insert, run as sql, tx } from "../db";
import { badRequest, newId, now } from "../util";
import { getAgent } from "../agents/service";
import { maskSecrets } from "../vault/vault";
import { readHandover, writeSession } from "../remote/handover";
import { audit } from "./audit";
import { createConversation, emitConversationUpdated, getConversationSummary, listMessages, safeFileName, saveAttachments } from "./conversations";

const FORMAT = "godmode.chat";
const VERSION = 1;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_TOTAL = 100 * 1024 * 1024;
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_MESSAGES = 20_000;

interface SharedFile {
  name: string;
  mime: string;
  data: string;
}

interface SharedMessage {
  role: Message["role"];
  source?: Message["source"];
  content: string;
  blocks: MessageBlock[];
  attachments: { name: string; mime: string; size: number; file: number | null }[];
  createdAt: string;
}

export interface SharedChat {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  chat: { title: string; agentName: string; model: string | null; effort: string | null; createdAt: string };
  messages: SharedMessage[];
  files: SharedFile[];
  session: { id: string; jsonl: string } | null;
}

export interface ChatExport {
  fileName: string;
  bytes: Buffer;
  messages: number;
  withContext: boolean;
}

function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  return value;
}

function readAttachment(repoPath: string, a: Attachment): Buffer | null {
  const uploads = join(normalize(repoPath), "workspace", "uploads") + sep;
  const path = normalize(join(repoPath, a.path));
  if (!path.startsWith(uploads)) return null;
  try {
    if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function buildSharedChat(conversationId: string, opts: { context: boolean; files: boolean }): SharedChat {
  const conv = getConversationSummary(conversationId);
  const agent = getAgent(conv.agentId);
  const files: SharedFile[] = [];
  let total = 0;
  const messages: SharedMessage[] = listMessages(conversationId).map((m) => ({
    role: m.role,
    ...(m.source ? { source: m.source } : {}),
    content: maskSecrets(m.content),
    blocks: maskDeep(m.blocks),
    attachments: m.attachments.map((a) => {
      const bytes = opts.files && !conv.runnerId ? readAttachment(agent.repoPath, a) : null;
      if (!bytes || total + bytes.length > MAX_FILES_TOTAL) return { name: a.name, mime: a.mime, size: a.size, file: null };
      total += bytes.length;
      files.push({ name: a.name, mime: a.mime, data: bytes.toString("base64") });
      return { name: a.name, mime: a.mime, size: a.size, file: files.length - 1 };
    }),
    createdAt: m.createdAt,
  }));
  let session: SharedChat["session"] = null;
  if (opts.context && !conv.runnerId) {
    const h = readHandover(conversationId);
    if (h.sessionId && h.session) session = { id: h.sessionId, jsonl: maskSecrets(h.session) };
  }
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now(),
    chat: { title: conv.title, agentName: agent.name, model: conv.model ?? null, effort: conv.effort ?? null, createdAt: conv.createdAt },
    messages,
    files,
    session,
  };
}

function fileNameFor(title: string): string {
  const stem = safeFileName(title).replace(/\.[^.]*$/, "").slice(0, 80) || "chat";
  return `${stem}.godmode-chat`;
}

export function exportChat(conversationId: string, opts: { context: boolean; files: boolean }): ChatExport {
  const shared = buildSharedChat(conversationId, opts);
  audit("user", "chat.export", conversationId, { messages: shared.messages.length, context: !!shared.session });
  return {
    fileName: fileNameFor(shared.chat.title),
    bytes: gzipSync(Buffer.from(JSON.stringify(shared), "utf8"), { level: 9 }),
    messages: shared.messages.length,
    withContext: !!shared.session,
  };
}

export function shareCode(conversationId: string): { code: string; messages: number; withContext: boolean } {
  const { bytes, messages, withContext } = exportChat(conversationId, { context: true, files: false });
  return { code: `${CHAT_SHARE_CODE_PREFIX}${bytes.toString("base64url")}`, messages, withContext };
}

function decode(data: string): Buffer {
  const text = data.trim();
  let raw: Buffer;
  if (text.startsWith(CHAT_SHARE_CODE_PREFIX)) raw = Buffer.from(text.slice(CHAT_SHARE_CODE_PREFIX.length).replace(/\s+/g, ""), "base64url");
  else if (text.startsWith("{")) return Buffer.from(text, "utf8");
  else raw = Buffer.from(text.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, ""), "base64");
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      return gunzipSync(raw, { maxOutputLength: MAX_IMPORT_BYTES });
    } catch {
      throw badRequest("That share file is damaged or too large.");
    }
  }
  return raw;
}

const ROLES = new Set<Message["role"]>(["user", "assistant", "system"]);
const SOURCES = new Set(["automation", "delegation", "task", "offer"]);

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function isoOr(v: unknown, fallback: string): string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback;
}

export function parseSharedChat(data: string): SharedChat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(data).toString("utf8"));
  } catch {
    throw badRequest("That isn't a Godmode chat. Pick a .godmode-chat file or paste a share code.");
  }
  const s = parsed as Partial<SharedChat> | null;
  if (!s || typeof s !== "object" || s.format !== FORMAT || !Array.isArray(s.messages)) {
    throw badRequest("That isn't a Godmode chat. Pick a .godmode-chat file or paste a share code.");
  }
  if (typeof s.version !== "number" || s.version > VERSION) throw badRequest("This chat was shared from a newer Godmode. Update Godmode to import it.");
  if (s.messages.length > MAX_MESSAGES) throw badRequest("That chat is too long to import.");
  const ts = now();
  const files = (Array.isArray(s.files) ? s.files : []).map((f) => ({
    name: str((f as SharedFile)?.name, 255) || "file",
    mime: str((f as SharedFile)?.mime, 255) || "application/octet-stream",
    data: str((f as SharedFile)?.data, MAX_IMPORT_BYTES),
  }));
  const messages: SharedMessage[] = [];
  for (const raw of s.messages as unknown[]) {
    const m = raw as Partial<SharedMessage> | null;
    if (!m || typeof m !== "object" || !ROLES.has(m.role as Message["role"])) continue;
    const blocks = (Array.isArray(m.blocks) ? m.blocks : []).filter((b): b is MessageBlock => !!b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string");
    const attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => ({
      name: str(a?.name, 255) || "file",
      mime: str(a?.mime, 255) || "application/octet-stream",
      size: typeof a?.size === "number" && a.size >= 0 ? a.size : 0,
      file: typeof a?.file === "number" && Number.isInteger(a.file) && a.file >= 0 && a.file < files.length ? a.file : null,
    }));
    messages.push({
      role: m.role as Message["role"],
      ...(m.role === "user" && typeof m.source === "string" && SOURCES.has(m.source) ? { source: m.source } : {}),
      content: str(m.content, 1_000_000),
      blocks,
      attachments,
      createdAt: isoOr(m.createdAt, ts),
    });
  }
  const chat = (s.chat ?? {}) as Partial<SharedChat["chat"]>;
  const session = s.session && typeof s.session === "object" && typeof s.session.id === "string" && typeof s.session.jsonl === "string" ? s.session : null;
  return {
    format: FORMAT,
    version: s.version,
    exportedAt: isoOr(s.exportedAt, ts),
    chat: {
      title: str(chat.title, 200).trim() || "Shared chat",
      agentName: str(chat.agentName, 200),
      model: typeof chat.model === "string" ? chat.model : null,
      effort: typeof chat.effort === "string" ? chat.effort : null,
      createdAt: isoOr(chat.createdAt, ts),
    },
    messages,
    files,
    session,
  };
}

export function previewSharedChat(data: string): SharedChatPreview {
  const s = parseSharedChat(data);
  return {
    title: s.chat.title,
    agentName: s.chat.agentName,
    exportedAt: s.exportedAt,
    messages: s.messages.length,
    files: s.files.length,
    withContext: !!s.session,
  };
}

function isSessionJsonl(text: string): boolean {
  return text.split("\n").every((line) => {
    if (!line.trim()) return true;
    try {
      const entry: unknown = JSON.parse(line);
      return !!entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { type?: unknown }).type === "string";
    } catch {
      return false;
    }
  });
}

export function importSharedChat(input: { data: string; agentId: string; workspaceId?: string | null; projectId?: string | null }): Conversation {
  const shared = parseSharedChat(input.data);
  const agent = getAgent(input.agentId);
  const conv = createConversation({ agentId: agent.id, title: shared.chat.title, workspaceId: input.workspaceId, projectId: input.projectId });
  const saved = new Map<number, Attachment>();
  for (const [i, f] of shared.files.entries()) {
    try {
      const [a] = saveAttachments(agent, [{ name: f.name, mime: f.mime, data: f.data }]);
      if (a) saved.set(i, a);
    } catch {
      continue;
    }
  }
  tx(() => {
    for (const m of shared.messages) {
      const attachments = m.attachments.flatMap((a) => (a.file !== null && saved.has(a.file) ? [saved.get(a.file)!] : []));
      insert("messages", {
        id: newId("msg"),
        conversation_id: conv.id,
        role: m.role,
        content: m.content,
        blocks: JSON.stringify(m.blocks),
        run_id: null,
        attachments: JSON.stringify(attachments),
        source: m.role === "user" ? (m.source ?? null) : null,
        created_at: m.createdAt,
      });
    }
    const ts = now();
    sql("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?", shared.messages.length ? ts : null, ts, conv.id);
  });
  let resumed = false;
  if (shared.session && isSessionJsonl(shared.session.jsonl)) {
    const sessionId = randomUUID();
    const jsonl = shared.session.jsonl.split(shared.session.id).join(sessionId);
    try {
      if (writeSession(agent.workingDirectory ?? agent.repoPath, sessionId, jsonl)) {
        sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", sessionId, conv.id);
        resumed = true;
      }
    } catch {
      resumed = false;
    }
  }
  if (!resumed && shared.messages.length) sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", randomUUID(), conv.id);
  audit("user", "chat.import", conv.id, { messages: shared.messages.length, context: resumed, from: shared.chat.agentName });
  emitConversationUpdated(conv.id);
  return getConversationSummary(conv.id);
}
