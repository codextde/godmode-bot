/**
 * Files and folders the messages of a chat name: the chat shows the pictures and opens the rest in the file manager.
 * Paths refer to the machine the core runs on. A relative one is looked up where the chat's agent works, and next to
 * the other files and folders the same message names ("the screenshots are in `workspace/shots/`: `01.png`, …").
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, ChatFile } from "@godmode/shared";
import { MAX_CHAT_FILE_REFS, MAX_TASK_ATTACHMENT_BYTES, chatImageUrl } from "@godmode/shared";
import { getAgent } from "../agents/service";
import { get } from "../db";
import { sniffType } from "../integrations/apiToolRequest";
import { SHOWN_IMAGE } from "../tasks/attachments";
import { HttpError, badRequest, notFound } from "../util";
import { chatSourcePaths } from "./projects";

type Kind = ChatFile["kind"];

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

/** Where the relative paths of a chat start: its folder, the agent's repository (and its `workspace/`), the workspace's folders. */
function chatFolders(conversationId: string): string[] {
  const conv = get<{ agent_id: string; working_directory: string | null }>("SELECT agent_id, working_directory FROM conversations WHERE id = ?", conversationId);
  if (!conv) throw notFound("Conversation");
  let agent: Agent | null = null;
  try {
    agent = getAgent(conv.agent_id);
  } catch {
    /* deleted meanwhile */
  }
  const folders = [
    conv.working_directory ?? agent?.workingDirectory,
    agent?.repoPath,
    agent && join(agent.repoPath, "workspace"),
    ...(agent ? chatSourcePaths(conversationId, agent) : []),
  ];
  return [...new Set(folders.filter((f): f is string => !!f))];
}

/** The path a reference means: `~` and file:// urls are understood, other urls and network paths aren't followed. */
function pathOf(ref: string): string | null {
  let path = ref.trim().replace(/^<(.*)>$/, "$1");
  if (!path || path.length > 1024 || path.includes("\0")) return null;
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  else if (path === "~" || /^~[\\/]/.test(path)) path = join(homedir(), path.slice(2));
  return /^[\\/]{2}/.test(path) ? null : path;
}

function kindOf(path: string): Kind | null {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "folder" : stat.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/** The file or folder `path` names: as it is when absolute, else in the first of the folders that has it. */
function locate(path: string, folders: string[]): { path: string; kind: Kind } | null {
  // `src/app.ts:42` points into a file.
  const plain = path.replace(/(?::\d+){1,2}$/, "");
  for (const name of plain === path ? [path] : [path, plain]) {
    for (const candidate of isAbsolute(name) ? [name] : folders.map((f) => join(f, name))) {
      const kind = kindOf(candidate);
      if (kind) return { path: resolve(candidate), kind };
    }
  }
  return null;
}

/** A picture the chat can show, by its first bytes — never by its name alone. */
function openImage(path: string, withData: boolean): { mime: string; version: number; data: Buffer | null } | null {
  // Opening a named pipe would wait for its writer, and the whole core with it.
  if (kindOf(path) !== "file") return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TASK_ATTACHMENT_BYTES) return null;
    const head = Buffer.alloc(32);
    const mime = sniffType(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
    if (!mime || !SHOWN_IMAGE.test(mime)) return null;
    return { mime, version: stat.mtimeMs, data: withData ? readFileSync(fd) : null };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function describe(ref: string, found: { path: string; kind: Kind }): ChatFile {
  const image = found.kind === "file" && IMAGE_NAME.test(found.path) ? openImage(found.path, false) : null;
  return { ref, ...found, name: basename(found.path) || found.path, image: image && chatImageUrl(found.path, image.version) };
}

/** The references of one message that exist, in their order. */
function resolveMessage(refs: string[], folders: string[]): ChatFile[] {
  const found = new Map<string, ChatFile>();
  // Folders the message itself points at, the latest first.
  let near: string[] = [];
  const later: [ref: string, path: string][] = [];
  for (const ref of [...new Set(refs)].slice(0, MAX_CHAT_FILE_REFS)) {
    const path = pathOf(ref);
    if (!path) continue;
    // A bare name most likely lies in the folder named just before it; a longer path starts where the agent works.
    const name = !isAbsolute(path) && !/[\\/]/.test(path.replace(/[\\/]+$/, ""));
    const hit = locate(path, name ? [...near, ...folders] : [...folders, ...near]);
    if (!hit) {
      if (!isAbsolute(path)) later.push([ref, path]);
      continue;
    }
    found.set(ref, describe(ref, hit));
    const folder = hit.kind === "folder" ? hit.path : dirname(hit.path);
    near = [folder, ...near.filter((f) => f !== folder)];
  }
  // "`01.png` and `02.png` are in `workspace/shots/`": the folder came after its files.
  for (const [ref, path] of later) {
    const hit = locate(path, near);
    if (hit) found.set(ref, describe(ref, hit));
  }
  return [...new Set(refs)].flatMap((ref) => found.get(ref) ?? []);
}

/** For every message of a chat (its references as a list), the files and folders that exist. */
export function resolveChatFiles(conversationId: string, messages: string[][]): ChatFile[][] {
  const folders = chatFolders(conversationId);
  return messages.map((refs) => resolveMessage(refs, folders));
}

function absolute(input: string): string {
  const path = pathOf(input);
  if (!path || !isAbsolute(path)) throw badRequest("Use an absolute path");
  return resolve(path);
}

/** A picture on this computer, for the chat that names it. Anything that isn't a picture stays unread. */
export function readChatImage(input: string): { mime: string; data: Buffer } {
  const image = openImage(absolute(input), true);
  if (!image?.data) throw notFound("Picture");
  return { mime: image.mime, data: image.data };
}

type Launch = (command: string[]) => void;

const spawnDetached: Launch = (command) => {
  Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
};
let launch = spawnDetached;

export function __setFileManagerForTests(fn: Launch | null): void {
  launch = fn ?? spawnDetached;
}

/**
 * A file is selected in its folder, a folder is opened. Nothing is ever run: a folder that could be an app bundle — by
 * its own name or the one a link leads to (`real`) — is selected, too.
 */
export function fileManagerCommand(path: string, kind: Kind, platform: NodeJS.Platform = process.platform, real = path): string[] {
  const open = kind === "folder" && !extname(path) && !extname(real);
  if (platform === "darwin") return open ? ["open", path] : ["open", "-R", path];
  if (platform === "win32") return ["explorer.exe", open ? path : `/select,${path}`];
  return ["xdg-open", kind === "folder" ? path : dirname(path)];
}

/** Show a file or folder in the file manager of the machine the core runs on. */
export function revealInFileManager(input: string): void {
  const path = absolute(input);
  const kind = kindOf(path);
  if (!kind) throw notFound("File");
  try {
    launch(fileManagerCommand(path, kind, process.platform, realpathSync(path)));
  } catch {
    throw new HttpError(500, "Couldn't open the file manager", "file_manager");
  }
}
