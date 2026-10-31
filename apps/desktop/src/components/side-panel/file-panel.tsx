import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ChatFile } from "@godmode/shared";
import { CircleAlert, Copy, FileCode2, FolderOpen, PanelRightClose, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/components/vault/clipboard";
import { ApiRequestError, api, errorMessage, fetchBlob } from "@/lib/api";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { codeThemeCss, highlightCode, languageOf } from "./highlighter";

const MAX_HIGHLIGHTED_CHARS = 400_000;

export default function FilePanel({ file, line, local, onHide }: { file: ChatFile; line: number | null; local: boolean; onHide: () => void }) {
  const width = "min(50vw, 760px)";
  const text = useQuery({
    queryKey: ["core-text", file.text],
    queryFn: async () => (await fetchBlob(file.text!)).text(),
    enabled: !!file.text,
    staleTime: 10_000,
    retry: false,
  });
  const lang = languageOf(file.name);
  const html = useMemo(() => {
    if (text.data == null) return null;
    return highlightCode(text.data, text.data.length > MAX_HIGHLIGHTED_CHARS ? "plaintext" : lang, line);
  }, [text.data, lang, line]);
  const lines = useMemo(() => (text.data == null ? 0 : text.data.split("\n").length), [text.data]);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!html || !line) return;
    body.current?.querySelector(`.th-line[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, [html, line]);

  const canReveal = local && !file.remote;
  const reveal = () =>
    void api.files.reveal(file.path).catch((err) => {
      const gone = err instanceof ApiRequestError && err.status === 404;
      toast.error(gone ? `${file.name} doesn't exist anymore` : `Couldn't open ${isMac ? "Finder" : "the file manager"}`, gone ? undefined : { description: errorMessage(err) });
    });

  return (
    <motion.aside
      aria-label={file.name}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <style>{codeThemeCss}</style>
      <div className="flex h-full flex-col" style={{ width }}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{file.name}</p>
            <p className="truncate text-[11.5px] text-muted-foreground" title={file.path}>
              {lines ? `${lines} ${lines === 1 ? "line" : "lines"} · ` : ""}
              {line ? `line ${line} · ` : ""}read-only
            </p>
          </div>
          <IconAction label="Reload" onClick={() => void text.refetch()} disabled={text.isFetching}>
            <RefreshCw className={cn(text.isFetching && "animate-spin [animation-duration:1.6s]")} />
          </IconAction>
          <IconAction label="Copy the contents" onClick={() => text.data != null && void copyText(text.data, "Copied")} disabled={text.data == null}>
            <Copy />
          </IconAction>
          {canReveal && (
            <IconAction label={isMac ? "Show in Finder" : "Show in folder"} onClick={reveal}>
              <FolderOpen />
            </IconAction>
          )}
          <IconAction label="Close" onClick={onHide}>
            <PanelRightClose />
          </IconAction>
        </header>
        <div ref={body} className="gm-code-view min-h-0 flex-1 overflow-auto bg-[var(--th-background)] font-mono text-[12px] leading-[1.6]">
          {html != null ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : text.isError ? (
            <p className="flex gap-2 p-4 font-sans text-sm text-muted-foreground">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {text.error instanceof ApiRequestError && text.error.status === 404 ? `${file.name} isn't there anymore, or can't be shown.` : `Couldn't read ${file.name}: ${errorMessage(text.error)}`}
            </p>
          ) : (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
        </div>
      </div>
    </motion.aside>
  );
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
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
