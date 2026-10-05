import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { File as FileGeneric, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileVideo, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Attachment } from "@godmode/shared";
import { MAX_MESSAGE_ATTACHMENT_BYTES } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** base64 without the data: prefix */
  data: string;
  /** Object URL for image thumbnails */
  previewUrl: string | null;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const totalBytes = (files: { size: number }[]) => files.reduce((sum, f) => sum + f.size, 0);

const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`;

export function fileIcon(mime: string, name = ""): LucideIcon {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime.includes("pdf") || mime.startsWith("text/") || ["md", "txt", "pdf", "doc", "docx"].includes(ext)) return FileText;
  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "gz", "tar", "7z"].includes(ext)) return FileArchive;
  if (mime.includes("sheet") || mime.includes("csv") || ["csv", "xls", "xlsx"].includes(ext)) return FileSpreadsheet;
  if (mime.includes("json") || mime.includes("javascript") || ["ts", "tsx", "js", "py", "json", "yaml", "yml", "sh"].includes(ext)) return FileCode2;
  return FileGeneric;
}

function readAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      const mime = file.type || url.slice(5, url.indexOf(";")) || "application/octet-stream";
      resolve({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || `pasted-${Date.now()}.${mime.split("/")[1] ?? "bin"}`,
        mime,
        size: file.size,
        data: comma >= 0 ? url.slice(comma + 1) : url,
        previewUrl: mime.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Reads the picked files that fit into a message that already carries `used` bytes. One notice says what was left out
 * and why, however many were picked.
 */
export async function readAttachments(files: File[], used: number, notify: (message: string) => void): Promise<PendingAttachment[]> {
  const big = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
  let room = MAX_MESSAGE_ATTACHMENT_BYTES - used;
  const fitting = files.filter((f) => {
    if (f.size > MAX_ATTACHMENT_BYTES || f.size > room) return false;
    room -= f.size;
    return true;
  });
  const over = files.length - big.length - fitting.length;
  const results = await Promise.allSettled(fitting.map(readAttachment));
  const failed = fitting.filter((_, i) => results[i]!.status === "rejected");
  const notes = [
    big.length === 1 ? `${big[0]!.name} is larger than ${mb(MAX_ATTACHMENT_BYTES)}.` : big.length ? `${big.length} files are larger than ${mb(MAX_ATTACHMENT_BYTES)}.` : "",
    over ? `${over} ${over === 1 ? "file" : "files"} didn't fit: a message carries up to ${mb(MAX_MESSAGE_ATTACHMENT_BYTES)}.` : "",
    failed.length === 1 ? `Could not read ${failed[0]!.name}.` : failed.length ? `Could not read ${failed.length} files.` : "",
  ].filter(Boolean);
  if (notes.length) notify(notes.join(" "));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** File chip — used in the composer (removable) and on sent messages. */
export function AttachmentChip({
  name,
  mime,
  size,
  previewUrl,
  onRemove,
  className,
}: {
  name: string;
  mime: string;
  size?: number;
  previewUrl?: string | null;
  onRemove?: () => void;
  className?: string;
}) {
  const Icon = fileIcon(mime, name);
  return (
    <div
      className={cn(
        "group/chip relative flex max-w-60 items-center gap-2 rounded-xl border bg-background/60 py-1.5 pr-2.5 pl-1.5 text-left shadow-xs",
        className,
      )}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium" title={name}>
          {name}
        </span>
        {size != null && size > 0 && <span className="block text-[10.5px] text-muted-foreground">{formatBytes(size)}</span>}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition group-hover/chip:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

const SUMMARY_FROM = 5;

/** Files waiting to be sent. Past a few rows they scroll, so the box keeps its size however many there are. */
export function AttachmentTray({
  files,
  onRemove,
  onClear,
  tall,
  className,
}: {
  files: PendingAttachment[];
  onRemove: (file: PendingAttachment) => void;
  onClear: () => void;
  tall?: boolean;
  className?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useRef(files.length);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = listRef.current;
    if (el && files.length > shown.current) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    shown.current = files.length;
  }, [files.length, reduce]);

  const total = totalBytes(files);
  return (
    <div className={className}>
      {files.length >= SUMMARY_FROM && (
        <div className="flex h-7 items-center justify-between gap-2 pl-1.5">
          <span className="truncate text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {files.length} files · {formatBytes(total)}
            {total > MAX_MESSAGE_ATTACHMENT_BYTES / 2 && ` of ${mb(MAX_MESSAGE_ATTACHMENT_BYTES)}`}
          </span>
          <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" onClick={onClear}>
            Remove all
          </Button>
        </div>
      )}
      <ul
        ref={listRef}
        aria-label="Attached files"
        className={cn(
          "scroll-fade-y grid scroll-py-6 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2 overflow-y-auto p-1.5",
          tall ? "max-h-48" : "max-h-[8.5rem]",
        )}
      >
        {files.map((f) => (
          <li key={f.id} className="min-w-0">
            <AttachmentChip name={f.name} mime={f.mime} size={f.size} previewUrl={f.previewUrl} onRemove={() => onRemove(f)} className="max-w-none" />
          </li>
        ))}
      </ul>
    </div>
  );
}

const FOLD_AFTER = 6;

/** The files of a sent message; past a handful the rest fold away, so one message can't fill the thread. */
export function AttachmentList({ files, className }: { files: Pick<Attachment, "name" | "mime" | "size">[]; className?: string }) {
  const [open, setOpen] = useState(false);
  // One hidden file would take the room of the button that reveals it.
  const folds = files.length > FOLD_AFTER + 1;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {(folds && !open ? files.slice(0, FOLD_AFTER) : files).map((a, i) => (
        <AttachmentChip key={`${a.name}-${i}`} name={a.name} mime={a.mime} size={a.size} />
      ))}
      {folds && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="min-h-[46px] rounded-xl border border-dashed px-3 text-xs font-medium text-muted-foreground tabular-nums transition-colors hover:border-foreground/25 hover:text-foreground"
        >
          {open ? "Show fewer" : `+${files.length - FOLD_AFTER} more`}
        </button>
      )}
    </div>
  );
}
