import { Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type {
  AgentFileEntry,
  AgentFileInfo,
  AgentFileMoveResult,
  AgentFileRestoreResult,
  AgentFileSearchHit, AgentNote,
  AgentFilesDeleteResult,
  AgentFilesOverview,
  DeletedAgentFile,
  FileReview,
} from "@godmode/shared";
import type { IconName } from "@/components/icon";
import { ApiError, pictureBases, request } from "./api";
import { t } from "./i18n";
import { queryClient } from "./query";
import { useSession } from "./session";

/**
 * An agent's folder: listed, searched, read as text, pictures and PDFs as they are. A phone with full access also
 * writes, creates, moves and deletes (into the agent's bin) like the desktop; the computer refuses paths that leave the
 * folder and Godmode's own files.
 */
const q = encodeURIComponent;

export const filesApi = {
  overview: () => request<AgentFilesOverview[]>("GET", "/api/files/overview"),
  list: (agentId: string, path: string) => request<AgentFileEntry[]>("GET", `/api/agents/${agentId}/files?path=${q(path)}`),
  read: (agentId: string, path: string) => request<{ path: string; content: string }>("GET", `/api/agents/${agentId}/file?path=${q(path)}`),
  search: (agentId: string, query: string) => request<AgentFileSearchHit[]>("GET", `/api/agents/${agentId}/files/search?q=${q(query)}`),
  notes: (agentId: string) => request<AgentNote[]>("GET", `/api/agents/${agentId}/files/notes`),
  /** `create`: only when nothing has the name yet (the computer says so instead of overwriting). */
  write: (agentId: string, path: string, content: string, create?: boolean) =>
    request<{ ok: true }>("PUT", `/api/agents/${agentId}/file`, { path, content, ...(create ? { create } : {}) }),
  createFolder: (agentId: string, path: string) => request<{ path: string }>("POST", `/api/agents/${agentId}/files/folder`, { path }),
  move: (agentId: string, from: string, to: string) => request<AgentFileMoveResult>("POST", `/api/agents/${agentId}/files/move`, { from, to }),
  inspect: (agentId: string, paths: string[]) => request<AgentFileInfo[]>("POST", `/api/agents/${agentId}/files/inspect`, { paths }),
  delete: (agentId: string, paths: string[]) => request<AgentFilesDeleteResult>("POST", `/api/agents/${agentId}/files/delete`, { paths }),
  deleted: (agentId: string) => request<DeletedAgentFile[]>("GET", `/api/agents/${agentId}/files/deleted`),
  restore: (agentId: string, entryId: string) => request<AgentFileRestoreResult>("POST", `/api/agents/${agentId}/files/deleted/${q(entryId)}/restore`),
  purge: (agentId: string, entryId: string) => request<{ removed: number; bytes: number }>("DELETE", `/api/agents/${agentId}/files/deleted/${q(entryId)}`),
  emptyBin: (agentId: string) => request<{ removed: number; bytes: number }>("DELETE", `/api/agents/${agentId}/files/deleted`),
  review: (agentId: string, fresh = false) => request<FileReview>("GET", `/api/agents/${agentId}/files/review${fresh ? "?fresh=1" : ""}`),
};

export const fk = {
  all: ["agent-files"],
  overview: ["agent-files", "overview"],
  agent: (agentId: string) => ["agent-files", agentId],
  list: (agentId: string, path: string) => ["agent-files", agentId, "list", path],
  file: (agentId: string, path: string) => ["agent-files", agentId, "file", path],
  search: (agentId: string, query: string) => ["agent-files", agentId, "search", query],
  notes: (agentId: string) => ["agent-files", agentId, "notes"],
  bin: (agentId: string) => ["agent-files", agentId, "bin"],
  review: (agentId: string) => ["agent-files", agentId, "review"],
  inspect: (agentId: string, paths: string[]) => ["agent-files", agentId, "inspect", ...paths],
} as const;

/** After a change everything shown of the agent's folder is stale: lists, files, the bin, the review, its memory. */
export function refreshFiles(agentId: string) {
  void queryClient.invalidateQueries({ queryKey: fk.agent(agentId) });
  void queryClient.invalidateQueries({ queryKey: fk.overview });
  void queryClient.invalidateQueries({ queryKey: ["agents", agentId] });
}

export type FileChange =
  | { agentId: string; moves: { from: string; to: string }[] }
  | { agentId: string; deleted: string[] }
  | { agentId: string; created: string; kind: "note" | "folder" };

const changeListeners = new Set<(change: FileChange) => void>();

/** What a sheet changed, for the screens showing the agent's folder (an open file follows its move, a new note opens). */
export function onFileChange(listener: (change: FileChange) => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

export function fileChanged(change: FileChange) {
  for (const listener of changeListeners) listener(change);
}

/** Where `path` is after the moves (itself or inside a moved folder); null when none touched it. */
export function movedPath(path: string, moves: { from: string; to: string }[]): string | null {
  for (const m of moves) {
    if (path === m.from) return m.to;
    if (path.startsWith(`${m.from}/`)) return `${m.to}${path.slice(m.from.length)}`;
  }
  return null;
}

/** Whether `path` was deleted (itself or a folder it lies in). */
export function wasDeleted(path: string, deleted: string[]): boolean {
  return deleted.some((d) => path === d || path.startsWith(`${d}/`));
}

/** Godmode's own files and folders: they stay where they are (the computer refuses too). */
const FIXED = new Set(["CLAUDE.md", "MEMORY.md", ".gitignore", "workspace", "memory", "workspace/tmp", "workspace/uploads", "conversations", "runs", "state"]);

export function isLocked(path: string): boolean {
  return FIXED.has(path) || /^(conversations|runs|state)\//.test(path) || /^(memory|workspace|conversations|runs|state)\/\.gitkeep$/.test(path);
}

/** tmp/ is cleared without the bin, uploads/ holds the human's attachments: nothing is made or moved there. */
export function reservedPlace(path: string): boolean {
  const lower = path.toLowerCase();
  return ["workspace/tmp", "workspace/uploads"].some((r) => lower === r || lower.startsWith(`${r}/`));
}

/** Where new entries may go and entries may be moved: inside workspace/ or memory/, not tmp/ or uploads/. */
export function placeable(path: string): boolean {
  return (path.startsWith("workspace/") || path.startsWith("memory/") || path === "workspace" || path === "memory") && !reservedPlace(path);
}

/** MEMORY.md and memory/**: a running dream owns them (the computer refuses edits meanwhile). */
export function isMemoryPath(path: string): boolean {
  return path === "MEMORY.md" || path.startsWith("memory/");
}

/** Files larger than this are shown, not edited (like the desktop). */
export const MAX_EDITABLE = 512 * 1024;

/** Why a file can't be edited (null = it can). */
export function readOnlyReason(path: string, size: number): string | null {
  if (path === "CLAUDE.md") return t("files:editor.readOnly.claude");
  if (path.startsWith("state/")) return t("files:editor.readOnly.state");
  if (path.startsWith("runs/")) return t("files:editor.readOnly.runs");
  if (path.startsWith("conversations/")) return t("files:editor.readOnly.conversations");
  if (size > MAX_EDITABLE) return t("files:editor.readOnly.tooLarge");
  return null;
}

/** Of what names a path, what Godmode can't rewrite on a move: the agent's instructions, automations and follow-ups. */
export function pinsAmong(names: string[]): string[] {
  return names.filter((n) => /^(the instructions|the automation |a follow-up)/.test(n));
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The file a new note becomes: "plan" is plan.md. */
export function noteFile(name: string): string {
  const n = name.trim();
  return /\.(md|markdown|txt)$/i.test(n) ? n : `${n}.md`;
}

export type NameKind = "rename" | "note" | "folder";

/** Why a name can't be used in its folder (null = it can); `current` is the entry's own name when renaming. */
export function nameProblem(name: string, taken: Set<string>, kind: NameKind, current?: string): string | null {
  const n = name.trim();
  if (!n) return t("files:name.errors.empty");
  if (n.includes("/") || n.includes("\\")) return t("files:name.errors.slash");
  if (n === "." || n === ".." || n.startsWith(".")) return t("files:name.errors.dot");
  if (n.length > 200) return t("files:name.errors.tooLong");
  const final = kind === "note" ? noteFile(n) : n;
  // A new spelling of its own name (Notes.md, notes.md) is fine.
  if (current && final.toLowerCase() === current.toLowerCase()) return null;
  if (taken.has(final.toLowerCase())) return t("files:name.errors.taken", { name: final });
  return null;
}

/** "3 items", "1 file": counts as the desktop words them. */
export function countOf(n: number, noun: "item" | "file" | "thing"): string {
  return t(`files:count.${noun}`, { count: n, n });
}

/** Where a picture or PDF of the folder loads from (relative to the computer's address). */
export function rawPath(agentId: string, path: string): string {
  return `/api/agents/${agentId}/files/raw?path=${q(path)}`;
}

export type FileKind = "folder" | "image" | "pdf" | "markdown" | "code" | "text" | "data" | "archive" | "media" | "other";

const KINDS: [RegExp, FileKind][] = [
  [/\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i, "image"],
  [/\.pdf$/i, "pdf"],
  [/\.(md|markdown|mdx)$/i, "markdown"],
  [/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|zsh|bash|sql|html|css|scss|vue|svelte|lua|r|pl|toml|ya?ml|ini|conf|xml|svg|dockerfile|makefile)$/i, "code"],
  [/\.(json|jsonl|csv|tsv|ndjson)$/i, "data"],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg)$/i, "archive"],
  [/\.(mp3|m4a|wav|aac|flac|ogg|mp4|mov|m4v|webm|mkv|avi)$/i, "media"],
  [/\.(txt|log|text|rtf)$/i, "text"],
];

export function fileKind(entry: Pick<AgentFileEntry, "path" | "type">): FileKind {
  if (entry.type === "dir") return "folder";
  return KINDS.find(([re]) => re.test(entry.path))?.[1] ?? "other";
}

export const KIND_ICON: Record<FileKind, IconName> = {
  folder: "folder",
  image: "photo",
  pdf: "doc",
  markdown: "note",
  code: "terminal",
  text: "text",
  data: "table",
  archive: "archiveFile",
  media: "film",
  other: "doc",
};

/** Pictures and PDFs open as they are; everything else is tried as text (the computer says when it isn't). */
export const viewable = (kind: FileKind) => kind === "image" || kind === "pdf";

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const root = () => new Directory(Paths.cache, "agent-files");

/** A viewer's own folder in the cache (`slot`), so one screen leaving never takes another's files along. */
function folder(slot: string): Directory {
  const dir = new Directory(root(), slot.replace(/[^\w-]/g, "_"));
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * A picture or PDF of the folder in the app's cache (for the PDF viewer and sharing), fetched with this phone's key from
 * each of the computer's addresses in turn. Gone again with `forgetLocalCopies(slot)`.
 */
export async function localCopy(agentId: string, path: string, slot: string): Promise<File> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  const target = new File(folder(slot), nameOf(path));
  let last: unknown = null;
  for (const base of pictureBases(connection)) {
    try {
      return await File.downloadFileAsync(base + rawPath(agentId, path), target, { headers: { authorization: `Bearer ${connection.token}` }, idempotent: true });
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new ApiError(0, t("system:api.offline"), "offline");
}

/** A passing file in the folder swept at launch: gone even when the app closed before it was removed. */
export const tempCopy = (slot: string, name: string) => new File(folder(slot), name);

/** A text file written to the cache under its own name, so it is shared as a file. */
export function localTextCopy(slot: string, path: string, content: string): File {
  const file = new File(folder(slot), nameOf(path));
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  return file;
}

/** The agents' files leave the phone once they were looked at (one viewer's, or all of them). */
export function forgetLocalCopies(slot?: string) {
  try {
    const dir = slot ? new Directory(root(), slot.replace(/[^\w-]/g, "_")) : root();
    if (dir.exists) dir.delete();
  } catch {
    /* nothing kept */
  }
}

/** The share sheet with the file itself (iOS), or its text (Android, which shares no local files without a provider). */
export async function shareFile(file: File, text?: string): Promise<void> {
  if (process.env.EXPO_OS === "ios") await Share.share({ url: file.uri });
  else await Share.share({ message: text ?? file.name, title: file.name });
}

/** The headings of a Markdown text (levels 1 to 3), with their lines; what is in a code fence isn't one. */
export function memorySections(text: string): { level: number; title: string; line: number }[] {
  const out: { level: number; title: string; line: number }[] = [];
  let fence = false;
  text.split("\n").forEach((raw, line) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ level: m[1]!.length, title: m[2]!.replace(/[*_`]/g, ""), line });
  });
  return out;
}

/** Relative links to memory/ notes that don't exist. */
export function brokenMemoryLinks(text: string, topics: string[]): string[] {
  const known = new Set(topics);
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(\s*(?:\.\/)?(memory\/[^)\s#?]+)/g)) {
    let path = m[1]!;
    try {
      path = decodeURI(path);
    } catch {
      // Stays as written.
    }
    if (!known.has(path)) out.add(path);
  }
  return [...out];
}
