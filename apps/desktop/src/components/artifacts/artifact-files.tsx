import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Artifact, ArtifactFile } from "@godmode/shared";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, FolderOpen, Music, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { coreUrl } from "@/lib/core";
import { isMac, saveBlob } from "@/lib/desktop";
import { cn } from "@/lib/utils";

type WithFiles = Pick<Artifact, "id" | "files" | "filesBase" | "filesLocal">;

const urlOf = (artifact: WithFiles, name: string) => coreUrl(`${artifact.filesBase ?? ""}${encodeURIComponent(name)}`);

function sizeOf(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function KindIcon({ file, className }: { file: ArtifactFile; className?: string }) {
  const Icon = file.kind === "video" ? Video : file.kind === "audio" ? Music : FileText;
  return <Icon className={className} />;
}

/** Everything attached to the artifact, whatever its page shows. */
export function ArtifactFilesPane({ artifact, onView }: { artifact: WithFiles; onView: (name: string) => void }) {
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {artifact.files.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => onView(f.name)}
            className="group min-w-0 overflow-hidden rounded-xl border bg-card text-left shadow-card transition outline-none hover:border-foreground/15 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="grid aspect-[4/3] place-items-center overflow-hidden border-b bg-muted/40">
              {f.kind === "image" ? (
                <img src={urlOf(artifact, f.name)} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
              ) : (
                <KindIcon file={f} className="size-6 text-muted-foreground" />
              )}
            </span>
            <span className="block px-2.5 py-2">
              <span className="block truncate text-xs font-medium">{f.name}</span>
              <span className="block text-[11px] text-muted-foreground">{sizeOf(f.size)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Action({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A file at full size, over the whole app: the arrow keys go through the others, a click zooms a picture. */
export function ArtifactFileViewer({ artifact, name, onName }: { artifact: WithFiles; name: string | null; onName: (name: string | null) => void }) {
  const { t } = useTranslation("artifacts");
  const files = artifact.files;
  const index = files.findIndex((f) => f.name === name);
  const file = index >= 0 ? files[index]! : null;
  const [zoom, setZoom] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const isOpen = !!file;

  // Opened from inside the frame, the keyboard is still in there: arrows and Escape belong to the viewer now.
  useEffect(() => {
    if (!isOpen) return;
    const take = requestAnimationFrame(() => {
      window.focus();
      content.current?.focus();
    });
    return () => cancelAnimationFrame(take);
  }, [isOpen]);

  useEffect(() => {
    setZoom(false);
    strip.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index]);

  const go = useCallback(
    (delta: number) => {
      if (files.length < 2 || index < 0) return;
      onName(files[(index + delta + files.length) % files.length]!.name);
    },
    [files, index, onName],
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
    else return;
    e.preventDefault();
  };

  const fail = (err: unknown) => toast.error(t("files.actionError"), { description: errorMessage(err) });
  const open = useMutation({ mutationFn: (n: string) => api.artifacts.openFile(artifact.id, n), onError: fail });
  const reveal = useMutation({ mutationFn: (n: string) => api.artifacts.revealFile(artifact.id, n), onError: fail });
  const download = async (f: ArtifactFile) => {
    try {
      const res = await fetch(urlOf(artifact, f.name));
      if (!res.ok) throw new Error(res.statusText);
      await saveBlob(await res.blob(), f.name);
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={(v) => !v && onName(null)}>
      <DialogContent
        ref={content}
        aria-describedby={undefined}
        onKeyDown={onKey}
        className="flex h-[92vh] w-[94vw] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[94vw]"
      >
        {file && (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-12 pl-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-medium">{file.name}</DialogTitle>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {files.length > 1 && `${index + 1} / ${files.length} · `}
                {sizeOf(file.size)}
              </span>
              {artifact.filesLocal && (
                <>
                  <Action label={t("files.open")} onClick={() => open.mutate(file.name)} disabled={open.isPending}>
                    <ExternalLink />
                  </Action>
                  <Action label={isMac ? t("files.showInFinder") : t("files.showInFolder")} onClick={() => reveal.mutate(file.name)} disabled={reveal.isPending}>
                    <FolderOpen />
                  </Action>
                </>
              )}
              <Action label={t("files.download")} onClick={() => void download(file)}>
                <Download />
              </Action>
            </div>

            <div className="relative min-h-0 flex-1 bg-muted/30">
              <div className={cn("size-full", zoom ? "overflow-auto" : "flex items-center justify-center overflow-hidden p-3")}>
                {file.kind === "image" ? (
                  <img
                    key={file.name}
                    src={urlOf(artifact, file.name)}
                    alt={file.name}
                    onClick={() => setZoom((z) => !z)}
                    className={cn(zoom ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in rounded-lg object-contain")}
                  />
                ) : file.kind === "video" ? (
                  <video key={file.name} src={urlOf(artifact, file.name)} controls autoPlay className="max-h-full max-w-full rounded-lg" />
                ) : file.kind === "audio" ? (
                  <audio key={file.name} src={urlOf(artifact, file.name)} controls autoPlay className="w-full max-w-md" />
                ) : file.kind === "pdf" ? (
                  <iframe key={file.name} src={urlOf(artifact, file.name)} title={file.name} className="size-full rounded-lg border-0 bg-background" />
                ) : (
                  <div className="space-y-3 text-center">
                    <KindIcon file={file} className="mx-auto size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t("files.noPreview")}</p>
                    {artifact.filesLocal && (
                      <Button size="sm" variant="outline" onClick={() => open.mutate(file.name)}>
                        <ExternalLink /> {t("files.open")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {files.length > 1 && (
                <>
                  <Button variant="secondary" size="icon" aria-label={t("files.previous")} onClick={() => go(-1)} className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full shadow-card">
                    <ChevronLeft />
                  </Button>
                  <Button variant="secondary" size="icon" aria-label={t("files.next")} onClick={() => go(1)} className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full shadow-card">
                    <ChevronRight />
                  </Button>
                </>
              )}
            </div>

            {files.length > 1 && (
              <div ref={strip} className="flex shrink-0 gap-1.5 overflow-x-auto border-t p-2">
                {files.map((f, i) => (
                  <button
                    key={f.name}
                    type="button"
                    data-index={i}
                    aria-label={f.name}
                    aria-current={i === index}
                    onClick={() => onName(f.name)}
                    className={cn(
                      "grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40 outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      i === index ? "border-brand ring-2 ring-brand/25" : "opacity-70 hover:opacity-100",
                    )}
                  >
                    {f.kind === "image" ? (
                      <img src={urlOf(artifact, f.name)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                    ) : (
                      <KindIcon file={f} className="size-4 text-muted-foreground" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
