/**
 * Files added to task descriptions (screenshots, PDFs, specs…), as in Multica or Linear: the board uploads a file, gets
 * its url and puts it into the description's Markdown. When the agent starts, every file the description links is
 * copied into the agent's repository (next to chat uploads) and the prompt points at those copies, so Claude Code reads
 * them — images and PDFs included.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Agent, Attachment, TaskAttachment } from "@godmode/shared";
import { MAX_TASK_ATTACHMENT_BYTES, TASK_ATTACHMENT_URL, taskAttachmentIds, taskAttachmentUrl } from "@godmode/shared";
import { config } from "../config";
import { all, get, insert, run as sql } from "../db";
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

export function saveTaskAttachment(file: { name: string; mime: string; data: Uint8Array }): TaskAttachment {
  if (file.data.byteLength === 0) throw badRequest("The file is empty");
  if (file.data.byteLength > MAX_TASK_ATTACHMENT_BYTES) throw badRequest(`File too large (max ${MAX_TASK_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
  const row: AttachmentRow = {
    id: newId("tat"),
    task_id: null,
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
