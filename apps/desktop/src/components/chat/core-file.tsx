import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ImageOff, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { TASK_ATTACHMENT_PATH } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { fetchBlob } from "@/lib/api";
import { saveBlob } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { fileIcon } from "./attachments";
import { Lightbox } from "./lightbox";

/**
 * Files the core serves itself (task attachments): they need the app's login, so they're fetched, not linked. Only
 * those: Markdown from agents must not make the app call other API routes with its token.
 */
export function isCoreFile(url: string | undefined): boolean {
  return !!url && url.startsWith(TASK_ATTACHMENT_PATH) && !url.includes("..");
}

function fileName(url: string): string {
  const last = url.split("?")[0]!.split("/").pop() ?? "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The file as an object url while mounted (the blob itself is cached per url). */
export function useCoreFileUrl(url: string | undefined): { src: string | null; failed: boolean } {
  const file = useQuery({
    queryKey: ["core-file", url],
    queryFn: () => fetchBlob(url as string),
    enabled: isCoreFile(url),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file.data) return;
    const objectUrl = URL.createObjectURL(file.data);
    setSrc(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [file.data]);
  return { src, failed: file.isError };
}

/** A picture the core serves: click shows it at full size, to save it from there. */
export function CoreImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const file = useCoreFileUrl(src);
  const [zoom, setZoom] = useState(false);
  const name = alt || fileName(src);
  if (file.failed) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground", className)}>
        <ImageOff className="size-3.5" /> {name} isn't available anymore
      </span>
    );
  }
  if (!file.src) return <span aria-label={alt} className={cn("inline-block h-40 w-64 max-w-full animate-pulse rounded-lg border bg-muted align-top", className)} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label={`Enlarge ${name}`}
        className={cn(
          "group/img relative my-0.5 inline-block max-w-full cursor-zoom-in overflow-hidden rounded-lg border bg-muted/30 align-top shadow-card transition hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          className,
        )}
      >
        <img src={file.src} alt={alt ?? ""} className="block max-h-96 w-auto max-w-full object-contain" />
        <span
          aria-hidden
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-md border bg-background/85 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition group-hover/img:opacity-100 group-focus-visible/img:opacity-100"
        >
          <Maximize2 className="size-3.5" />
        </span>
      </button>
      <Lightbox
        src={file.src}
        alt={name}
        open={zoom}
        onOpenChange={setZoom}
        footer={
          <div className="flex min-w-0 items-center gap-2 pr-1 pl-2">
            <span className="truncate text-[13px] text-muted-foreground">{name}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-7 shrink-0 gap-1.5 px-2.5 text-xs" onClick={() => void downloadCoreFile(src)}>
              <Download className="size-3.5" /> Save
            </Button>
          </div>
        }
      />
    </>
  );
}

export async function downloadCoreFile(url: string, name = fileName(url)) {
  try {
    await saveBlob(await fetchBlob(url), name);
  } catch (err) {
    toast.error(`Could not download ${name}`, { description: err instanceof Error ? err.message : String(err) });
  }
}

/** A linked file (PDF, document…) as a card: click saves it. */
export function CoreFileLink({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  const name = fileName(href);
  const Icon = fileIcon("", name);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void downloadCoreFile(href, name);
      }}
      title={`Download ${name}`}
      className={cn(
        "not-prose inline-flex max-w-full items-center gap-2 rounded-lg border bg-card py-1 pr-2 pl-1.5 align-middle text-[13px] no-underline shadow-xs transition hover:bg-accent",
        className,
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <span className="truncate font-medium">{children || name}</span>
      <Download className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
