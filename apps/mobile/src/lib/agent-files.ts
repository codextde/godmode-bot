import { Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { AgentFileEntry, AgentFileSearchHit, AgentFilesOverview } from "@godmode/shared";
import type { IconName } from "@/components/icon";
import { ApiError, pictureBases, request } from "./api";
import { t } from "./i18n";
import { useSession } from "./session";

/**
 * An agent's folder, read-only: listed, searched, read as text, pictures and PDFs as they are. Moving, deleting and the
 * bin stay on the computer; the computer refuses paths that leave the folder and files that usually hold keys.
 */
const q = encodeURIComponent;

export const filesApi = {
  overview: () => request<AgentFilesOverview[]>("GET", "/api/files/overview"),
  list: (agentId: string, path: string) => request<AgentFileEntry[]>("GET", `/api/agents/${agentId}/files?path=${q(path)}`),
  read: (agentId: string, path: string) => request<{ path: string; content: string }>("GET", `/api/agents/${agentId}/file?path=${q(path)}`),
  search: (agentId: string, query: string) => request<AgentFileSearchHit[]>("GET", `/api/agents/${agentId}/files/search?q=${q(query)}`),
};

export const fk = {
  all: ["agent-files"],
  overview: ["agent-files", "overview"],
  list: (agentId: string, path: string) => ["agent-files", agentId, "list", path],
  file: (agentId: string, path: string) => ["agent-files", agentId, "file", path],
  search: (agentId: string, query: string) => ["agent-files", agentId, "search", query],
} as const;

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
