import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ImageOff } from "lucide-react";
import { toast } from "sonner";
import { TASK_ATTACHMENT_PATH } from "@godmode/shared";
import { fetchBlob } from "@/lib/api";
import { saveBlob } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { fileIcon } from "./attachments";

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

export function CoreImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const file = useCoreFileUrl(src);
  if (file.failed) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground", className)}>
        <ImageOff className="size-3.5" /> {alt || fileName(src)} isn't available anymore
      </span>
    );
  }
  if (!file.src) return <span aria-label={alt} className={cn("inline-block h-40 w-64 max-w-full animate-pulse rounded-lg border bg-muted", className)} />;
  return <img src={file.src} alt={alt ?? ""} className={cn("max-h-96 max-w-full rounded-lg border", className)} />;
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
