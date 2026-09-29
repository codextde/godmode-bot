import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, CirclePause, CornerDownLeft, Eye, FileDiff as FileDiffIcon, FileMinus2, FilePlus2, FileText, Info, MoonStar, RotateCcw, TriangleAlert, Undo2 } from "lucide-react";
import type { Dream, DreamFileChange } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { diffFile, foldContext, type DiffLine, type FileDiff } from "@/lib/line-diff";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ACTIVE_DREAM, ChangeKindChip, DreamStatusBadge, ROLLED_BACK, dreamWhen, reviewedLabel, useLastDefined } from "./dream-parts";

type View = "changes" | "result";

/** Rows rendered per file before "Show everything" (a new or deleted note can be long). */
const MAX_ROWS = 400;

/** Everything a dream changed: the agent's own report next to a line diff of every memory file it rewrote. */
export function DreamReviewDialog({
  dream,
  agentName,
  undoBlocked,
  onOpenChange,
  onUndo,
}: {
  dream: Dream | null;
  agentName: string;
  undoBlocked: boolean;
  onOpenChange: (open: boolean) => void;
  onUndo: (dream: Dream) => void;
}) {
  const open = !!dream;
  const shown = useLastDefined(dream);
  const contentRef = useRef<HTMLDivElement>(null);
  // Only while open: a closed dialog keeps `shown` for its exit animation but shouldn't refetch on every dream event.
  const q = useQuery({ queryKey: qk.dream(shown?.id ?? ""), queryFn: () => api.dreams.get(shown!.id), enabled: !!shown && open });
  const current = q.data ?? shown;
  const [view, setView] = useState<View>("changes");
  const files = useMemo(() => (q.data?.fileChanges ?? []).map((f) => ({ file: f, diff: diffFile(f.before, f.after) })), [q.data]);
  const totals = files.reduce((t, f) => ({ added: t.added + f.diff.added, removed: t.removed + f.diff.removed }), { added: 0, removed: 0 });
  const rolledBack = !!current && ROLLED_BACK.includes(current.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        // Start on the dialog itself rather than ringing the first toggle.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
      >
        {current && (
          <>
            <DialogHeader className="gap-1.5 border-b bg-paper-2 px-5 pt-4 pb-3.5 pr-12 text-left sm:text-left">
              <div className="eyebrow flex items-center gap-1.5">
                <MoonStar className="size-3.5 text-dream" aria-hidden /> Dream · {dreamWhen(current.createdAt)}
              </div>
              <DialogTitle className="text-[17px] font-medium tracking-[-0.015em]">What {agentName} changed</DialogTitle>
              <DialogDescription className="max-w-3xl text-[13px] leading-relaxed">{current.summary || reviewedLabel(current)}</DialogDescription>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
                <DreamStatusBadge status={current.status} />
                {q.data && (
                  <span className="font-mono text-[11px] tabular-nums">
                    <span className="text-success">+{totals.added}</span> <span className="text-destructive">−{totals.removed}</span>
                  </span>
                )}
                {current.summary && <span>{reviewedLabel(current)}</span>}
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={view}
                  onValueChange={(v) => v && setView(v as View)}
                  aria-label="Show"
                  className="ml-auto bg-card"
                >
                  <ToggleGroupItem value="changes" aria-label="Changes" className="gap-1 px-2 text-xs">
                    <FileDiffIcon className="size-3.5" /> Changes
                  </ToggleGroupItem>
                  <ToggleGroupItem value="result" aria-label="Result" className="gap-1 px-2 text-xs">
                    <Eye className="size-3.5" /> Result
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </DialogHeader>

            <div className="@container min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 @3xl:grid-cols-[16rem_minmax(0,1fr)]">
                <aside className="border-b p-4 @3xl:border-r @3xl:border-b-0">
                  <h3 className="eyebrow mb-2.5">{rolledBack ? "What it attempted" : "The agent's notes"}</h3>
                  {rolledBack && current.changes.length > 0 && (
                    <p className="mb-2.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <RotateCcw className="size-3 shrink-0" aria-hidden />
                      {current.files.length ? "Rolled back where possible" : "Rolled back — nothing was kept"}
                    </p>
                  )}
                  {current.changes.length ? (
                    <ul className={cn("space-y-2", rolledBack && "opacity-70 grayscale")}>
                      {current.changes.map((c, i) => (
                        <li key={i} className="space-y-1">
                          <ChangeKindChip kind={c.kind} />
                          <p className={cn("text-[12.5px] leading-snug", rolledBack && "line-through decoration-muted-foreground/50")}>{c.text}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {agentName} didn't describe its changes — the diff shows exactly what it wrote.
                    </p>
                  )}
                  {current.status !== "succeeded" && current.error && (
                    <p
                      className={cn(
                        "mt-3 flex gap-1.5 rounded-md border px-2.5 py-2 text-xs",
                        current.status === "failed" ? "border-destructive/20 bg-destructive/[0.05] text-destructive" : "bg-secondary/60 text-muted-foreground",
                      )}
                    >
                      {current.status === "failed" ? (
                        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                      ) : current.status === "paused" ? (
                        <CirclePause className="mt-px size-3.5 shrink-0" aria-hidden />
                      ) : (
                        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 break-words">{current.error}</span>
                    </p>
                  )}
                </aside>

                <div className="min-w-0 space-y-4 p-4">
                  {q.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-9 w-full" />
                      {Array.from({ length: 7 }, (_, i) => (
                        <Skeleton key={i} className="h-4" style={{ width: `${45 + ((i * 31) % 50)}%` }} />
                      ))}
                    </div>
                  ) : q.isError ? (
                    <p className="text-sm text-muted-foreground">Couldn't load the changes: {errorMessage(q.error)}</p>
                  ) : files.length ? (
                    files.map((f) => <FileChangeCard key={f.file.path} file={f.file} diff={f.diff} view={view} />)
                  ) : (
                    <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                      {rolledBack ? "Nothing from this dream is left in the memory files." : "This dream didn't change any memory files."}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter className="items-center gap-3 border-t px-5 py-3 sm:justify-between">
              <p className="text-xs text-muted-foreground">
                {current.status === "reverted"
                  ? "This dream was undone — the files are back the way they were before it."
                  : current.canRevert
                    ? undoBlocked
                      ? `Undo is available once ${agentName}'s current dream has ended.`
                      : "Undo puts these files back exactly as they were before the dream."
                    : current.files.length && !ACTIVE_DREAM.includes(current.status)
                      ? "The memory changed after this dream, so it can't be undone automatically — edit the files in the Memory tab instead."
                      : null}
              </p>
              <div className="flex shrink-0 gap-2">
                <DialogClose asChild>
                  <Button variant="outline" size="sm">
                    Close
                  </Button>
                </DialogClose>
                {current.canRevert && (
                  <Button size="sm" disabled={undoBlocked} onClick={() => onUndo(current)}>
                    <Undo2 /> Undo this dream
                  </Button>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FileChangeCard({ file, diff, view }: { file: DreamFileChange; diff: FileDiff; view: View }) {
  const state = file.before === null ? "created" : file.after === null ? "deleted" : "edited";
  const Icon = state === "created" ? FilePlus2 : state === "deleted" ? FileMinus2 : FileText;
  const empty =
    state === "created"
      ? "Created an empty file."
      : state === "deleted"
        ? "Deleted an empty file."
        : diff.finalNewline
          ? `Only the newline at the end of the file was ${diff.finalNewline}.`
          : "No line changes.";
  return (
    <section className="overflow-clip rounded-lg border bg-card" aria-label={file.path}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card/95 px-3 py-2 backdrop-blur-sm">
        <Icon className={cn("size-4 shrink-0", state === "created" ? "text-success" : state === "deleted" ? "text-destructive" : "text-muted-foreground")} />
        <span className="min-w-0 truncate font-mono text-[12.5px]" title={file.path}>
          {file.path}
        </span>
        {state !== "edited" && (
          <span
            className={cn(
              "shrink-0 rounded-[5px] border px-1.5 text-[10.5px] font-medium",
              state === "created" ? "border-success/20 bg-success/[0.08] text-success" : "border-destructive/20 bg-destructive/[0.06] text-destructive",
            )}
          >
            {state === "created" ? "New file" : "Deleted"}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-success">+{diff.added}</span> <span className="text-destructive">−{diff.removed}</span>
        </span>
      </header>
      {view === "changes" ? (
        diff.lines.length ? (
          <DiffView lines={diff.lines} finalNewline={diff.finalNewline} />
        ) : (
          <p className="px-4 py-5 text-sm text-muted-foreground italic">{empty}</p>
        )
      ) : file.after === null ? (
        <p className="px-4 py-6 text-sm text-muted-foreground italic">The dream deleted this file.</p>
      ) : (
        <div className="px-5 py-4">
          {file.after.trim() ? <Markdown>{file.after}</Markdown> : <p className="text-sm text-muted-foreground italic">Empty file.</p>}
        </div>
      )}
    </section>
  );
}

const NOTE_ROW = "flex w-full items-center gap-2 border-dashed bg-paper-2/70 px-3 py-1 text-left font-sans text-[11px] text-muted-foreground";

function DiffView({ lines, finalNewline }: { lines: DiffLine[]; finalNewline: FileDiff["finalNewline"] }) {
  const blocks = useMemo(() => foldContext(lines), [lines]);
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
  const [everything, setEverything] = useState(false);

  // Render until the row budget runs out, then stop — later blocks (folds included) collapse into one note.
  const rows: ReactNode[] = [];
  let budget = everything ? Infinity : MAX_ROWS;
  let notShown = 0;
  blocks.forEach((b, i) => {
    const folded = b.type === "fold" && !unfolded.has(i);
    if (budget <= 0) {
      notShown += b.lines.length;
      return;
    }
    if (folded) {
      budget -= 1;
      rows.push(
        <div key={i} role="listitem">
          <button
            type="button"
            onClick={() => setUnfolded((s) => new Set(s).add(i))}
            className={cn(NOTE_ROW, "border-y transition first:border-t-0 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none")}
          >
            <ChevronsUpDown className="size-3" aria-hidden />
            Show {b.lines.length} unchanged lines
          </button>
        </div>,
      );
      return;
    }
    const shown = b.lines.slice(0, budget);
    notShown += b.lines.length - shown.length;
    budget -= shown.length;
    shown.forEach((l, k) => rows.push(<DiffRow key={`${i}:${k}`} line={l} />));
  });

  return (
    <div className="py-1 font-mono text-[12px] leading-5" role="list">
      {rows}
      {notShown > 0 ? (
        <div role="listitem" className={cn(NOTE_ROW, "mt-1 justify-between border-t py-1.5")}>
          <span>{notShown.toLocaleString()} more lines not shown</span>
          <button type="button" onClick={() => setEverything(true)} className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground">
            Show everything
          </button>
        </div>
      ) : (
        finalNewline && (
          <div role="listitem" className={cn(NOTE_ROW, "mt-1 border-t")}>
            <CornerDownLeft className="size-3" aria-hidden />
            {finalNewline === "added" ? "Newline added at end of file" : "No newline at end of file anymore"}
          </div>
        )
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const add = line.kind === "add";
  const del = line.kind === "del";
  return (
    <div
      role="listitem"
      className={cn(
        "relative grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]",
        add && "bg-success/[0.07] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-success",
        del && "bg-destructive/[0.055] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-destructive/70",
      )}
    >
      <span aria-hidden className={cn("pr-1.5 text-right text-[10.5px] text-muted-foreground/55 tabular-nums select-none", del && "text-destructive/70")}>
        {line.oldNo ?? ""}
      </span>
      <span aria-hidden className={cn("pr-1.5 text-right text-[10.5px] text-muted-foreground/55 tabular-nums select-none", add && "text-success/80")}>
        {line.newNo ?? ""}
      </span>
      <span aria-hidden className={cn("text-center select-none", add ? "text-success" : del ? "text-destructive" : "text-transparent")}>
        {add ? "+" : del ? "−" : " "}
      </span>
      <span className={cn("pr-3 break-words whitespace-pre-wrap [overflow-wrap:anywhere]", line.kind === "same" && "text-muted-foreground")}>
        {(add || del) && <span className="sr-only">{add ? "Added: " : "Removed: "}</span>}
        {line.parts
          ? line.parts.map((p, i) =>
              p.changed ? (
                <mark
                  key={i}
                  className={cn(
                    "rounded-[3px] px-px text-foreground",
                    add ? "bg-success/20" : "bg-destructive/15 line-through decoration-destructive/40",
                  )}
                >
                  {p.text}
                </mark>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )
          : line.text || " "}
      </span>
    </div>
  );
}
