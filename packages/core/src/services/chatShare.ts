import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zlib } from "node:zlib";
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
const MAX_TOOL_OUTPUT = 8_000;
const BEST_COMPRESSION_UNDER = 8 * 1024 * 1024;
const SCREENSHOT_NOTE = "[screenshot not shared]";
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

export interface ShareOptions {
  context: boolean;
  files: boolean;
  screenshots: boolean;
}

export interface ChatShare {
  code: string;
  fileName: string;
  bytes: number;
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

export function buildSharedChat(conversationId: string, opts: ShareOptions): SharedChat {
  const conv = getConversationSummary(conversationId);
  const agent = getAgent(conv.agentId);
  const files: SharedFile[] = [];
  let total = 0;
  const messages: SharedMessage[] = listMessages(conversationId).map((m) => ({
    role: m.role,
    ...(m.source ? { source: m.source } : {}),
    content: maskSecrets(m.content),
    blocks: maskDeep(slimBlocks(m.blocks, opts.screenshots)),
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
    if (h.sessionId && h.session) session = { id: h.sessionId, jsonl: maskSecrets(slimSession(h.session, opts.screenshots)) };
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

export function shareChat(conversationId: string, opts: ShareOptions): ChatShare {
  const shared = buildSharedChat(conversationId, opts);
  const json = Buffer.from(JSON.stringify(shared), "utf8");
  const packed = brotliCompressSync(json, {
    params: {
      [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
      [zlib.BROTLI_PARAM_QUALITY]: json.length <= BEST_COMPRESSION_UNDER ? 11 : 9,
      [zlib.BROTLI_PARAM_LGWIN]: 24,
      [zlib.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });
  const code = `${CHAT_SHARE_CODE_PREFIX}${packed.toString("base64url")}`;
  audit("user", "chat.share", conversationId, { messages: shared.messages.length, context: !!shared.session, bytes: code.length });
  return { code, fileName: fileNameFor(shared.chat.title), bytes: code.length, messages: shared.messages.length, withContext: !!shared.session };
}

function decode(data: string, depth = 0): Buffer {
  const text = data.trim();
  if (text.startsWith(CHAT_SHARE_CODE_PREFIX)) {
    try {
      return brotliDecompressSync(Buffer.from(text.slice(CHAT_SHARE_CODE_PREFIX.length).replace(/\s+/g, ""), "base64url"), { maxOutputLength: MAX_IMPORT_BYTES });
    } catch {
      throw badRequest("That share code is damaged or too large.");
    }
  }
  if (depth > 0) return Buffer.from(text, "utf8");
  return decode(Buffer.from(text.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, ""), "base64").toString("utf8"), 1);
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
  const session =
    s.session && typeof s.session === "object" && typeof s.session.id === "string" && typeof s.session.jsonl === "string"
      ? { id: s.session.id, jsonl: s.session.jsonl }
      : null;
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
    const cwd = agent.workingDirectory ?? agent.repoPath;
    const jsonl = hydrateSession(shared.session.jsonl, sessionId, cwd);
    try {
      if (writeSession(cwd, sessionId, jsonl)) {
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

type Json = Record<string, unknown>;

const SESSION_TYPES = new Set(["user", "assistant", "summary"]);
const SESSION_FIELDS = ["type", "subtype", "uuid", "parentUuid", "logicalParentUuid", "isSidechain", "message", "timestamp", "isMeta", "isCompactSummary", "compactMetadata", "summary", "leafUuid", "content", "level"];

function cut(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const head = Math.floor(MAX_TOOL_OUTPUT * 0.75);
  const tail = MAX_TOOL_OUTPUT - head;
  return `${text.slice(0, head)}\n… [${text.length - MAX_TOOL_OUTPUT} characters not shared] …\n${text.slice(-tail)}`;
}

function slimContent(content: unknown, screenshots: boolean, inToolResult: boolean): unknown {
  if (typeof content === "string") return inToolResult ? cut(content) : content;
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const raw of content) {
    const part = raw as Json | null;
    if (!part || typeof part !== "object") continue;
    if (part.type === "thinking" || part.type === "redacted_thinking") continue;
    if (part.type === "image" && !screenshots) {
      out.push({ type: "text", text: SCREENSHOT_NOTE });
      continue;
    }
    if (part.type === "tool_result") {
      out.push({ ...part, content: slimContent(part.content, screenshots, true) });
      continue;
    }
    if (part.type === "text" && inToolResult && typeof part.text === "string") {
      out.push({ ...part, text: cut(part.text) });
      continue;
    }
    out.push(part);
  }
  return out;
}

export function slimSession(jsonl: string, screenshots: boolean): string {
  const parentOf = new Map<string, string | null>();
  const kept: Json[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const uuid = typeof entry.uuid === "string" ? entry.uuid : null;
    const parent = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
    const compact = entry.type === "system" && entry.subtype === "compact_boundary";
    let keep = SESSION_TYPES.has(String(entry.type)) || compact;
    let slim: Json | null = null;
    if (keep) {
      slim = Object.fromEntries(SESSION_FIELDS.filter((k) => k in entry).map((k) => [k, entry[k]]));
      const message = slim.message as Json | undefined;
      if (message && typeof message === "object") {
        const content = slimContent(message.content, screenshots, false);
        if (Array.isArray(content) && !content.length) keep = false;
        else slim.message = { ...message, content };
      }
    }
    if (uuid) parentOf.set(uuid, keep ? uuid : parent);
    if (keep && slim) kept.push(slim);
  }
  const resolve = (id: string | null): string | null => {
    const seen = new Set<string>();
    let cur = id;
    while (cur && parentOf.has(cur) && parentOf.get(cur) !== cur && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return cur && parentOf.get(cur) === cur ? cur : null;
  };
  return kept
    .map((e) => {
      if ("parentUuid" in e) e.parentUuid = resolve(typeof e.parentUuid === "string" ? e.parentUuid : null);
      if (typeof e.logicalParentUuid === "string") e.logicalParentUuid = resolve(e.logicalParentUuid);
      return JSON.stringify(e);
    })
    .join("\n");
}

export function hydrateSession(jsonl: string, sessionId: string, dir: string): string {
  let cwd = dir;
  try {
    cwd = realpathSync(dir);
  } catch {
    cwd = dir;
  }
  return (
    jsonl
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const e = JSON.parse(line) as Json;
        return JSON.stringify(e.type === "summary" ? e : { ...e, sessionId, cwd, userType: "external", isSidechain: e.isSidechain ?? false });
      })
      .join("\n") + "\n"
  );
}

export function slimBlocks(blocks: MessageBlock[], screenshots: boolean): MessageBlock[] {
  return blocks.map((b) => {
    if (b.type !== "tool_use") return b;
    const { image, imageUrl: _url, ...rest } = b;
    return {
      ...rest,
      ...(rest.result !== undefined ? { result: cut(rest.result) } : {}),
      ...(image && screenshots ? { image } : {}),
    };
  });
}
