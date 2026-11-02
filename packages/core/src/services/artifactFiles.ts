/**
 * Files an agent attaches to an artifact: images the human has to approve, screenshots, videos, PDFs. The sandboxed page
 * can't read this computer, so they are copied next to the artifact (a cheap clone where the disk can) and served under
 * a secret per artifact, for that page and the app's viewer. Only file types that are made to be looked at get in.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import type { ArtifactFile } from "@godmode/shared";
import { MAX_ARTIFACT_FILES, MAX_ARTIFACT_FILES_BYTES, MAX_ARTIFACT_FILE_BYTES, SECRET_NAME, artifactFileKind } from "@godmode/shared";
import { config } from "../config";
import { all, get, run as sql } from "../db";
import { bus } from "../events/bus";
import { badRequest, notFound, now } from "../util";
import { openInDefaultApp, revealInFileManager } from "./chatFiles";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const MAX_RANGE_BYTES = 8 * 1024 * 1024;

interface FileRow {
  artifact_id: string;
  name: string;
  mime: string;
  size: number;
  source_path: string;
  updated_at: string;
}

const toFile = (r: FileRow): ArtifactFile => ({ name: r.name, mime: r.mime, kind: artifactFileKind(r.mime), size: r.size, updatedAt: r.updated_at });

const dirOf = (artifactId: string) => join(config().dataDir, "artifact-files", artifactId);

export function listArtifactFiles(artifactId: string): ArtifactFile[] {
  return all<FileRow>("SELECT * FROM artifact_files WHERE artifact_id = ? ORDER BY name COLLATE NOCASE", artifactId).map(toFile);
}

export function removeArtifactFilesDir(artifactId: string): void {
  rmSync(dirOf(artifactId), { recursive: true, force: true });
}

export interface PreparedFile {
  path: string;
  size: number;
}

export interface PreparedFiles {
  found: PreparedFile[];
  /** What was left out and why, for the agent. */
  skipped: string[];
}

const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function usable(path: string, size: number, skipped: string[]): PreparedFile | null {
  const name = basename(path);
  if (SECRET_NAME.test(name)) skipped.push(`${name}: looks like a secret`);
  else if (!MIME[extname(name).toLowerCase()]) skipped.push(`${name}: this file type can't be attached`);
  else if (size > MAX_ARTIFACT_FILE_BYTES) skipped.push(`${name}: bigger than ${MAX_ARTIFACT_FILE_BYTES / 1024 / 1024} MB`);
  else return { path, size };
  return null;
}

/** Find what the agent named, before anything is saved: a wrong path fails the call instead of leaving half an artifact. */
export function prepareArtifactFiles(paths: string[]): PreparedFiles {
  const found: PreparedFile[] = [];
  const skipped: string[] = [];
  for (const raw of paths) {
    let path = raw.trim().replace(/^file:\/\//, "");
    if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
    if (!isAbsolute(path)) throw badRequest(`${raw}: files must be absolute paths on this computer`);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) throw badRequest(`There is no file ${path} on this computer`);
    if (stat.isDirectory()) {
      const inside: PreparedFile[] = [];
      for (const name of readdirSync(path).sort(byName.compare)) {
        if (name.startsWith(".") || !MIME[extname(name).toLowerCase()]) continue;
        const child = join(path, name);
        const s = statSync(child, { throwIfNoEntry: false });
        if (!s?.isFile()) continue;
        const ok = usable(child, s.size, skipped);
        if (ok) inside.push(ok);
      }
      if (!inside.length) throw badRequest(`The folder ${path} has no file that can be attached (images, videos, audio, PDF, text, Office)`);
      found.push(...inside);
    } else if (stat.isFile()) {
      const ok = usable(path, stat.size, skipped);
      if (ok) found.push(ok);
    }
  }
  return { found: [...new Map(found.map((f) => [f.path, f])).values()], skipped };
}

function freeName(path: string, taken: Map<string, string>): string {
  const clean = basename(path).normalize("NFC").replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/^[.-]+/, "") || "file";
  const ext = extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  for (let i = 1; ; i++) {
    const name = i === 1 ? clean : `${stem}-${i}${ext}`;
    const owner = taken.get(name);
    if (owner === undefined || owner === path) return name;
  }
}

/** Copy prepared files in. The same source again replaces its copy, so an agent can fix an image and attach it again. */
export function attachArtifactFiles(artifactId: string, prepared: PreparedFiles): { attached: ArtifactFile[]; skipped: string[] } {
  const skipped = [...prepared.skipped];
  const rows = all<FileRow>("SELECT * FROM artifact_files WHERE artifact_id = ?", artifactId);
  const taken = new Map(rows.map((r) => [r.name, r.source_path]));
  const sizes = new Map(rows.map((r) => [r.name, r.size]));
  const dir = dirOf(artifactId);
  mkdirSync(dir, { recursive: true });
  const attached: string[] = [];
  for (const file of prepared.found) {
    const name = freeName(file.path, taken);
    const total = [...sizes.entries()].reduce((sum, [n, s]) => (n === name ? sum : sum + s), 0);
    if (!sizes.has(name) && sizes.size >= MAX_ARTIFACT_FILES) {
      skipped.push(`${basename(file.path)}: an artifact holds at most ${MAX_ARTIFACT_FILES} files`);
      continue;
    }
    if (total + file.size > MAX_ARTIFACT_FILES_BYTES) {
      skipped.push(`${basename(file.path)}: an artifact holds at most ${MAX_ARTIFACT_FILES_BYTES / 1024 / 1024 / 1024} GB`);
      continue;
    }
    const temp = join(dir, `.incoming-${randomBytes(6).toString("hex")}`);
    try {
      copyFileSync(file.path, temp, constants.COPYFILE_FICLONE);
      const { size } = statSync(temp);
      renameSync(temp, join(dir, name));
      sql(
        `INSERT INTO artifact_files (artifact_id, name, mime, size, source_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (artifact_id, name) DO UPDATE SET mime = excluded.mime, size = excluded.size, source_path = excluded.source_path, updated_at = excluded.updated_at`,
        artifactId,
        name,
        MIME[extname(name).toLowerCase()]!,
        size,
        file.path,
        now(),
      );
      taken.set(name, file.path);
      sizes.set(name, size);
      attached.push(name);
    } catch (err) {
      rmSync(temp, { force: true });
      skipped.push(`${basename(file.path)}: ${err instanceof Error ? err.message : "couldn't be copied"}`);
    }
  }
  if (attached.length) {
    sql("UPDATE artifacts SET files_key = CASE WHEN files_key = '' THEN ? ELSE files_key END, updated_at = ? WHERE id = ?", randomBytes(24).toString("hex"), now(), artifactId);
    bus.changed("artifacts");
  }
  const names = new Set(attached);
  return { attached: listArtifactFiles(artifactId).filter((f) => names.has(f.name)), skipped };
}

/** Take files out by name; returns the names that weren't there. */
export function removeArtifactFiles(artifactId: string, names: string[]): string[] {
  const unknown: string[] = [];
  for (const name of names) {
    const row = get<FileRow>("SELECT * FROM artifact_files WHERE artifact_id = ? AND name = ?", artifactId, name);
    if (!row) {
      unknown.push(name);
      continue;
    }
    sql("DELETE FROM artifact_files WHERE artifact_id = ? AND name = ?", artifactId, name);
    rmSync(join(dirOf(artifactId), row.name), { force: true });
  }
  if (unknown.length < names.length) bus.changed("artifacts");
  return unknown;
}

function rowOf(artifactId: string, name: string): FileRow {
  const row = get<FileRow>("SELECT * FROM artifact_files WHERE artifact_id = ? AND name = ?", artifactId, name);
  if (!row) throw notFound("File");
  return row;
}

/** The human opens a file in its default app. Only attached copies, and those are never programs (see MIME). */
export function openArtifactFile(artifactId: string, name: string): void {
  const row = rowOf(artifactId, name);
  const path = join(dirOf(artifactId), row.name);
  if (!existsSync(path)) throw notFound("File");
  openInDefaultApp(path);
}

/** The human wants to see the file where it came from; the copy when the original moved. */
export function revealArtifactFile(artifactId: string, name: string): void {
  const row = rowOf(artifactId, name);
  revealInFileManager(row.source_path && existsSync(row.source_path) ? row.source_path : join(dirOf(artifactId), row.name));
}

/** What a page or the viewer loads: the secret in the URL is the credential, as it can't send the app's login. */
export async function serveArtifactFile(key: string, name: string, headers: { range?: string; ifNoneMatch?: string }): Promise<Response> {
  const row = key
    ? get<FileRow>("SELECT f.* FROM artifact_files f JOIN artifacts a ON a.id = f.artifact_id WHERE a.files_key = ? AND f.name = ?", key, name)
    : undefined;
  const path = row ? join(dirOf(row.artifact_id), row.name) : "";
  const stat = row ? statSync(path, { throwIfNoEntry: false }) : undefined;
  if (!row || !stat) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });

  const kind = artifactFileKind(row.mime);
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const out: Record<string, string> = {
    "content-type": row.mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-cache",
    "accept-ranges": "bytes",
    "referrer-policy": "no-referrer",
    etag,
  };
  // A PDF needs the browser's viewer, which a sandbox would refuse; nothing else may run anything, an SVG least of all.
  if (kind !== "pdf") out["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'";
  if (kind === "file" && !row.mime.startsWith("text/")) out["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`;
  if (headers.ifNoneMatch === etag) return new Response(null, { status: 304, headers: out });

  const file = Bun.file(path);
  const range = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const wanted = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > wanted || start >= stat.size) return new Response(null, { status: 416, headers: { ...out, "content-range": `bytes */${stat.size}` } });
    // A player asks for "the rest" and comes back for more; a sliced file as the body comes out too long here, so these are read.
    const end = Math.min(wanted, start + MAX_RANGE_BYTES - 1);
    return new Response(await file.slice(start, end + 1).arrayBuffer(), {
      status: 206,
      headers: { ...out, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${stat.size}` },
    });
  }
  return new Response(file, { status: 200, headers: { ...out, "content-length": String(stat.size) } });
}
