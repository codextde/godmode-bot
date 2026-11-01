import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Attachment } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AttachmentChip } from "./attachments";
import { downloadCoreFile, useCoreFileUrl } from "./core-file";
import { Lightbox } from "./lightbox";

type Shown = Pick<Attachment, "name" | "mime" | "size"> & { path?: string };

const PICTURE = /^image\/(png|jpe?g|gif|webp)$/i;

export function attachmentImageUrl(conversationId: string, path: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachment?path=${encodeURIComponent(path)}`;
}

export function isShownPicture(file: Shown, conversationId: string | null): file is Shown & { path: string } {
  return !!conversationId && !!file.path && PICTURE.test(file.mime);
}

export function AttachmentImages({ files, conversationId, className }: { files: (Shown & { path: string })[]; conversationId: string; className?: string }) {
  const single = files.length === 1;
  return (
    <div className={cn("flex flex-wrap justify-end gap-1.5", className)}>
      {files.map((f, i) => (
        <AttachmentImage key={`${f.path}-${i}`} file={f} url={attachmentImageUrl(conversationId, f.path)} single={single} />
      ))}
    </div>
  );
}

function AttachmentImage({ file, url, single }: { file: Shown; url: string; single: boolean }) {
  const { t } = useTranslation("chat");
  const blob = useCoreFileUrl(url, true);
  const [zoom, setZoom] = useState(false);
  if (blob.failed) return <AttachmentChip name={file.name} mime={file.mime} size={file.size} />;
  const box = single ? "max-h-72 max-w-80" : "size-32";
  if (!blob.src) return <span aria-label={file.name} className={cn("block animate-pulse rounded-xl border bg-muted", single ? "h-48 w-64" : "size-32")} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label={t("files.enlarge", { name: file.name })}
        title={file.name}
        className="block cursor-zoom-in overflow-hidden rounded-xl border border-foreground/[0.06] bg-muted/30 shadow-xs transition full-motion:hover:shadow-card focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <img src={blob.src} alt={file.name} className={cn("block", box, single ? "w-auto object-contain" : "object-cover")} />
      </button>
      <Lightbox
        src={blob.src}
        alt={file.name}
        open={zoom}
        onOpenChange={setZoom}
        footer={
          <div className="flex min-w-0 items-center gap-2 pr-1 pl-2">
            <span className="truncate text-[13px] text-muted-foreground">{file.name}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-7 shrink-0 gap-1.5 px-2.5 text-xs" onClick={() => void downloadCoreFile(url, file.name)}>
              <Download className="size-3.5" /> {t("files.save")}
            </Button>
          </div>
        }
      />
    </>
  );
}
