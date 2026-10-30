import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Check, Code2, Copy, FileText, FileX2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatFile } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchBlob } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

type View = "read" | "source";
type Heading = { el: HTMLElement; title: string; level: number };

/** The headings of the rendered document, for its outline. */
function useOutline(container: HTMLElement | null, text: string | undefined, view: View) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState(0);
  // A heading near the end can't scroll to the top: the one picked stays marked while the reader scrolls to it.
  const picked = useRef(0);
  useLayoutEffect(() => {
    if (!container || view !== "read") {
      setHeadings([]);
      return;
    }
    const read = () =>
      setHeadings(
        [...container.querySelectorAll<HTMLElement>("article h1, article h2, article h3")].map((el) => ({
          el,
          title: el.textContent?.trim() ?? "",
          level: Number(el.tagName[1]),
        })),
      );
    read();
    // Pictures and file links arrive a moment later and move the headings.
    const watch = new MutationObserver(read);
    watch.observe(container, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [container, text, view]);

  useEffect(() => {
    if (!container || headings.length === 0) return;
    const onScroll = () => {
      if (Date.now() < picked.current) return;
      const top = container.getBoundingClientRect().top + 96;
      let current = 0;
      headings.forEach((h, i) => h.el.getBoundingClientRect().top <= top && (current = i));
      setActive(current);
    };
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [container, headings]);

  const jump = useCallback(
    (i: number) => {
      picked.current = Date.now() + 900;
      setActive(i);
      headings[i]?.el.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [headings],
  );

  return { headings, active, jump };
}

function HeaderAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground hover:text-foreground" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The file as written: numbered lines that wrap, so nothing hides off to the side. */
function Source({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <div className="mx-auto max-w-[56rem] px-6 py-6">
      <ol className="overflow-hidden rounded-xl border bg-card py-3 font-mono text-[12.5px] leading-[1.7] shadow-card">
        {lines.map((line, i) => (
          <li key={i} className="flex hover:bg-foreground/[0.03]">
            <span aria-hidden className="w-12 shrink-0 pr-4 text-right text-muted-foreground/60 tabular-nums select-none">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 pr-5 break-words whitespace-pre-wrap">{line || "\u00A0"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const WORDS_PER_MINUTE = 230;

/** A Markdown file a message names, rendered to read — or as its source. */
export function MarkdownReader({
  file,
  open,
  onOpenChange,
  folderAction,
}: {
  file: ChatFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderAction: { label: string; icon: LucideIcon; show: () => void };
}) {
  const [view, setView] = useState<View>("read");
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const doc = useQuery({
    queryKey: ["core-markdown", file.markdown],
    queryFn: async () => (await fetchBlob(file.markdown!)).text(),
    enabled: open && !!file.markdown,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: 1,
  });
  const text = doc.data;
  const { headings, active, jump } = useOutline(scroller, text, view);
  const words = useMemo(() => text?.match(/\S+/g)?.length ?? 0, [text]);
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  const folder = file.path.slice(0, file.path.length - file.name.length).replace(/[\\/]$/, "");
  const FolderIcon = folderAction.icon;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    scroller?.scrollTo({ top: 0 });
  }, [scroller, view, file.path]);

  const copy = useCallback(() => {
    if (text === undefined) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1400);
    });
  }, [text]);

  return (
    // The dialog is a portal, but React still bubbles its events to the message around the link.
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(88vh,60rem)] w-[min(68rem,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <header className="flex items-center gap-3 border-b py-2.5 pr-2.5 pl-4">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-muted-foreground">
              <FileText className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-[13.5px] leading-tight font-medium">{file.name}</DialogTitle>
              <DialogDescription className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate font-mono text-[11px]" title={file.path}>
                  {folder}
                </span>
                {text !== undefined && (
                  <span className="shrink-0 tabular-nums">
                    · {words.toLocaleString()} {words === 1 ? "word" : "words"} · {minutes} min read
                  </span>
                )}
              </DialogDescription>
            </div>
            <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && setView(v as View)} aria-label="View" className="shrink-0">
              <ToggleGroupItem value="read" className="gap-1.5 px-2.5 text-xs">
                <BookOpen className="size-3.5" /> Read
              </ToggleGroupItem>
              <ToggleGroupItem value="source" className="gap-1.5 px-2.5 text-xs">
                <Code2 className="size-3.5" /> Source
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="flex shrink-0 items-center gap-0.5">
              <HeaderAction label={copied ? "Copied" : "Copy Markdown"} onClick={copy}>
                {copied ? <Check className="text-success" /> : <Copy />}
              </HeaderAction>
              <HeaderAction label={folderAction.label} onClick={folderAction.show}>
                <FolderIcon />
              </HeaderAction>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" className="text-muted-foreground hover:text-foreground">
                  <X />
                </Button>
              </DialogClose>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            {view === "read" && headings.length >= 3 && (
              <nav aria-label="Outline" className="hidden w-56 shrink-0 overflow-y-auto border-r bg-paper-2/50 px-3 py-6 lg:block">
                <p className="mb-2 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">On this page</p>
                <ul className="space-y-px">
                  {headings.map((h, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => jump(i)}
                        className={cn(
                          "block w-full truncate rounded-md py-1 pr-2 text-left text-[12.5px] transition-colors hover:bg-foreground/5 hover:text-foreground",
                          h.level === 3 ? "pl-5" : "pl-2",
                          i === active ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground",
                        )}
                        title={h.title}
                      >
                        {h.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}

            <div ref={setScroller} className="min-w-0 flex-1 overflow-y-auto scroll-smooth">
              {doc.isError ? (
                <div className="grid h-full place-items-center p-8 text-center">
                  <div>
                    <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl border bg-card shadow-card">
                      <FileX2 className="size-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">{file.name} can't be opened</p>
                    <p className="mt-1 text-xs text-muted-foreground">It was moved, deleted, or is too large to read here.</p>
                  </div>
                </div>
              ) : text === undefined ? (
                <div className="mx-auto max-w-[44rem] space-y-3 px-10 py-10">
                  <Skeleton className="mb-6 h-7 w-1/2" />
                  {Array.from({ length: 9 }, (_, i) => (
                    <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 37) % 45)}%` }} />
                  ))}
                </div>
              ) : view === "source" ? (
                <Source text={text} />
              ) : text.trim() ? (
                <article className="mx-auto max-w-[44rem] px-10 pt-9 pb-16">
                  <Markdown className="prose-reader">{text}</Markdown>
                </article>
              ) : (
                <p className="p-10 text-center text-sm text-muted-foreground italic">This file is empty.</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}
