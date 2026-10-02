/**
 * Files added to task descriptions (screenshots, PDFs, specs…), as in Multica or Linear: the board uploads a file, gets
 * its url and puts it into the description's Markdown. When the agent starts, every file the description links is
 * copied into the agent's repository (next to chat uploads) and the prompt points at those copies, so Claude Code reads
 * them — images and PDFs included. The other way round, screenshots the agent names in its result become files of the
 * task too, so the board shows them.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, Attachment, TaskAttachment } from "@godmode/shared";
import { MAX_TASK_ATTACHMENT_BYTES, TASK_ATTACHMENT_URL, taskAttachmentIds, taskAttachmentMarkdown, taskAttachmentUrl } from "@godmode/shared";
import { config } from "../config";
import { all, get, insert, run as sql } from "../db";
import { realRoots, sniffType, within } from "../integrations/apiToolRequest";
import { logger } from "../log";
import { badRequest, newId, notFound, now } from "../util";
import { safeFileName } from "../services/conversations";

const log = logger("tasks");

/** Uploads no task claimed within this time are removed. */
const UNCLAIMED_TTL_MS = 24 * 60 * 60_000;

interface AttachmentRow {
  id: string;
  task_id: string | null;
  name: string;
  mime: string;
  size: number;
  created_at: string;
}

function toModel(r: AttachmentRow): TaskAttachment {
  return { id: r.id, name: r.name, mime: r.mime, size: r.size, url: taskAttachmentUrl(r.id, r.name) };
}

function dir(id: string): string {
  return join(config().attachmentsDir, "tasks", id);
}

function filePath(r: Pick<AttachmentRow, "id" | "name">): string {
  return join(dir(r.id), r.name);
}

export function saveTaskAttachment(file: { name: string; mime: string; data: Uint8Array }, taskId: string | null = null): TaskAttachment {
  if (file.data.byteLength === 0) throw badRequest("The file is empty");
  if (file.data.byteLength > MAX_TASK_ATTACHMENT_BYTES) throw badRequest(`File too large (max ${MAX_TASK_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
  const row: AttachmentRow = {
    id: newId("tat"),
    task_id: taskId,
    name: safeFileName(file.name),
    mime: (file.mime || "application/octet-stream").slice(0, 255),
    size: file.data.byteLength,
    created_at: now(),
  };
  mkdirSync(dir(row.id), { recursive: true });
  writeFileSync(filePath(row), file.data);
  insert("task_attachments", { ...row });
  return toModel(row);
}

/** The stored file, for the board to show or download it. */
export function readTaskAttachment(id: string): { attachment: TaskAttachment; data: Buffer } {
  const r = get<AttachmentRow>("SELECT * FROM task_attachments WHERE id = ?", id);
  if (!r || !existsSync(filePath(r))) throw notFound("Attachment");
  return { attachment: toModel(r), data: readFileSync(filePath(r)) };
}

/** A task's description links these uploads now: they belong to it (and go when it's deleted). */
export function claimTaskAttachments(taskId: string, description: string): void {
  const ids = taskAttachmentIds(description);
  if (!ids.length) return;
  sql(`UPDATE task_attachments SET task_id = ? WHERE task_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`, taskId, ...ids);
}

function remove(rows: AttachmentRow[]) {
  for (const r of rows) {
    sql("DELETE FROM task_attachments WHERE id = ?", r.id);
    try {
      rmSync(dir(r.id), { recursive: true, force: true });
    } catch (err) {
      log.warn(`could not remove the attachment ${r.id}`, err);
    }
  }
}

/** A task is gone: its files go too — unless another task's description links them (copied over), which gets them. */
export function removeTaskAttachments(taskId: string): void {
  const orphans: AttachmentRow[] = [];
  for (const r of all<AttachmentRow>("SELECT * FROM task_attachments WHERE task_id = ?", taskId)) {
    const heir = get<{ id: string }>("SELECT id FROM tasks WHERE id != ? AND instr(description, ?) > 0 LIMIT 1", taskId, `/${r.id}/`);
    if (heir) sql("UPDATE task_attachments SET task_id = ? WHERE id = ?", heir.id, r.id);
    else orphans.push(r);
  }
  remove(orphans);
}

/** Uploads of tasks that were never created (a dialog closed without saving), and of tasks gone meanwhile. */
export function sweepTaskAttachments(): void {
  const cutoff = new Date(Date.now() - UNCLAIMED_TTL_MS).toISOString();
  remove(
    all<AttachmentRow>(
      "SELECT * FROM task_attachments WHERE (task_id IS NULL AND created_at < ?) OR (task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks))",
      cutoff,
    ),
  );
}

export interface StagedAttachments {
  /** Copies in the agent's repository, for the conversation's message. */
  files: Attachment[];
  /** Absolute path of each copy, by attachment id. */
  paths: Map<string, string>;
  /** Linked files that don't exist (anymore). */
  missing: string[];
}

/**
 * Copy the files a description links into `<agent repo>/workspace/uploads/task-<number>/`: the agent's repository is
 * always within its reach (its cwd or an --add-dir), wherever the task works.
 */
export function stageTaskAttachments(agent: Agent, taskNumber: number, description: string): StagedAttachments {
  const staged: StagedAttachments = { files: [], paths: new Map(), missing: [] };
  const links = new Map<string, string>();
  for (const m of description.matchAll(TASK_ATTACHMENT_URL)) if (!links.has(m[1]!)) links.set(m[1]!, m[0]);
  if (!links.size) return staged;
  // A file that can't be copied is reported like a missing one; the task still starts.
  const fail = (name: string, err?: unknown) => {
    if (err) log.warn(`could not copy the attachment ${name} for task #${taskNumber}`, err);
    staged.missing.push(name);
  };
  const rel = `workspace/uploads/task-${taskNumber}`;
  const target = join(agent.repoPath, rel);
  const used = new Set<string>();
  for (const [id, url] of links) {
    const r = get<AttachmentRow>("SELECT * FROM task_attachments WHERE id = ?", id);
    if (!r || !existsSync(filePath(r))) {
      fail(r?.name ?? decodeName(url));
      continue;
    }
    // Same names (two "image.png" pastes) get their own copies.
    const ext = extname(r.name);
    const stem = r.name.slice(0, r.name.length - ext.length);
    let name = r.name;
    for (let i = 1; used.has(name.toLowerCase()); i++) name = `${stem}-${i}${ext}`;
    try {
      mkdirSync(target, { recursive: true });
      copyFileSync(filePath(r), join(target, name));
    } catch (err) {
      fail(r.name, err);
      continue;
    }
    used.add(name.toLowerCase());
    staged.files.push({ name, mime: r.mime, path: `${rel}/${name}`, size: r.size });
    staged.paths.set(id, join(target, name));
  }
  return staged;
}

function decodeName(url: string): string {
  const encoded = url.slice(url.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** A Markdown link to an attachment: `![shot.png](url)` or `[spec.pdf](url)` (group 2: the label). */
const ATTACHMENT_LINK = new RegExp(String.raw`(!?)\[((?:\\.|[^\]\\])*)\]\(` + `(${TASK_ATTACHMENT_URL.source})` + String.raw`\)`, "g");

/** Each attachment link as a 📎 and the file's name: the conversation shows the files attached to the message. */
export function withFileNames(description: string): string {
  return description.replace(ATTACHMENT_LINK, (_link, _bang, label: string) => `📎 ${label.replace(/\\(.)/g, "$1") || "file"}`);
}

/** The description with every linked attachment pointing at its local copy (what Claude reads). */
export function withLocalPaths(description: string, paths: Map<string, string>): string {
  if (!paths.size) return description;
  // By id: every link to a file points at its copy, whatever name its url carries.
  return description.replace(TASK_ATTACHMENT_URL, (url, id: string) => {
    const path = paths.get(id);
    // Markdown link targets can't hold spaces: <…> can.
    return path ? (/[\s()]/.test(path) ? `<${path}>` : path) : url;
  });
}

/* ------------------------------------------------------------------ */
/* Pictures in the agent's result                                      */
/* ------------------------------------------------------------------ */

/** Images the board can show; other files stay paths. */
export const SHOWN_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const MAX_RESULT_IMAGES = 20;

const LOCAL_START = String.raw`(?:file:\/\/|~)?(?:[A-Za-z]:)?[\\/]`;
const IMAGE_EXT = String.raw`\.(?:png|jpe?g|gif|webp|avif|bmp)`;
const LOCAL_IMAGE = new RegExp(String.raw`^${LOCAL_START}[^\n]*${IMAGE_EXT}$`, "i");

/**
 * Where a result names a file: a Markdown link or image (groups 1–3: `!`, label, target), inline code (4–5: backticks,
 * code) or a bare path (6). Links and code match whole, so a path inside them is never taken on its own.
 */
const RESULT_REF = new RegExp(
  [
    String.raw`(!?)\[((?:\\.|\[[^\]\n]*\]|[^[\]\\\n])*)\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)`,
    String.raw`(\`+)([^\`\n]+?)\4(?!\`)`,
    String.raw`(?<![^\s(])(?<!\]\()(${LOCAL_START}[^\s()<>\`"']*?${IMAGE_EXT})(?=[.,;:!?)]*(?:\s|$))`,
  ].join("|"),
  "gi",
);

/**
 * The image file an absolute path, `~/…` or file:// url names, when it lies in one of the folders — also once its links
 * are resolved. Nothing else is touched: no file elsewhere, no network path.
 */
function localImage(ref: string, folders: string[], realFolders: string[]): { named: string; real: string } | null {
  let path = ref.trim().replace(/^<(.*)>$/, "$1");
  if (!LOCAL_IMAGE.test(path)) return null;
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  } else if (path.startsWith("~")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || !within(resolve(path), folders)) return null;
  try {
    const real = realpathSync(path);
    return within(real, realFolders) ? { named: path, real } : null;
  } catch {
    return null;
  }
}

/** The file, if it really is an image the board can show (its first bytes say so). */
function readImage(path: string, name: string): { name: string; mime: string; data: Buffer } | null {
  let fd: number | null = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TASK_ATTACHMENT_BYTES) return null;
    fd = openSync(path, "r");
    const head = Buffer.alloc(32);
    const mime = sniffType(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
    return mime && SHOWN_IMAGE.test(mime) ? { name, mime, data: readFileSync(fd) } : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** `edit` applied to every line outside fenced code blocks. */
function outsideFences(markdown: string, edit: (line: string) => string): string {
  let fence: string | null = null;
  return markdown
    .split(/(?<=\n)/)
    .map((line) => {
      const [, marker, rest = ""] = /^\s*(`{3,}|~{3,})(.*)/.exec(line) ?? [];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) fence = null;
        return line;
      }
      // ```code``` within a line is inline code, not a fence.
      if (!marker || (marker[0] === "`" && rest.includes("`"))) return edit(line);
      fence = marker;
      return line;
    })
    .join("");
}

/**
 * The agent's result with the pictures it names by their path in its folders (the screenshots it took) shown: each is
 * copied into the task's files — the board can't open local paths, and temporary files may be gone by the time someone
 * looks — and the Markdown shows that copy. Other files, missing ones and code blocks stay as they are.
 */
export function withResultImages(taskId: string, result: string, folders: string[]): string {
  const roots = folders.map((f) => resolve(f));
  const realRootsOf = realRoots(roots);
  const saved = new Map<string, TaskAttachment | null>();
  let left = MAX_RESULT_IMAGES;
  const save = (ref: string): TaskAttachment | null => {
    const file = localImage(ref, roots, realRootsOf);
    if (!file) return null;
    if (!saved.has(file.real) && left > 0) {
      left--;
      const image = readImage(file.real, basename(file.named));
      let attachment: TaskAttachment | null = null;
      try {
        if (image) attachment = saveTaskAttachment(image, taskId);
      } catch (err) {
        log.warn(`could not keep the picture ${file.real} of task ${taskId}`, err);
      }
      saved.set(file.real, attachment);
    }
    return saved.get(file.real) ?? null;
  };
  return outsideFences(result, (line) =>
    line.replace(RESULT_REF, (ref, _bang, label: string | undefined, target: string | undefined, _ticks, code: string | undefined, bare: string | undefined) => {
      if (target !== undefined) {
        const image = save(target);
        if (!image) return ref;
        const own = label?.trim() && label.trim() !== target.trim() && !label.includes("](");
        return own ? `![${label}](${image.url})` : taskAttachmentMarkdown(image);
      }
      const image = save(code ?? bare ?? "");
      return image ? taskAttachmentMarkdown(image) : ref;
    }),
  );
}

/** Pictures an earlier result showed that the new one doesn't: they go, unless a description links them. */
export function removeStaleResultImages(taskId: string, previous: string | null, current: string | null): void {
  const kept = new Set(taskAttachmentIds(current ?? ""));
  const stale = taskAttachmentIds(previous ?? "").filter((id) => !kept.has(id));
  if (!stale.length) return;
  remove(
    all<AttachmentRow>(
      `SELECT * FROM task_attachments a WHERE task_id = ? AND id IN (${stale.map(() => "?").join(",")})
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE instr(description, '/' || a.id || '/') > 0)`,
      taskId,
      ...stale,
    ),
  );
}
