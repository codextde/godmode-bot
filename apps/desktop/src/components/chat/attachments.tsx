import { File as FileGeneric, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileVideo, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
export const MAX_ATTACHMENTS = 10;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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

export function readAttachment(file: File): Promise<PendingAttachment> {
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
        <span className="block truncate text-xs font-medium">{name}</span>
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
