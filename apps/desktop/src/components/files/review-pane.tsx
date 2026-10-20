import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Boxes, CircleCheck, Clock3, Copy, FileWarning, Folder, FolderInput, FolderX, HardDrive, RefreshCw, Sparkles, Trash2, Unlink, Unplug, Wind } from "lucide-react";
import type { Agent, FileReviewItem, FileReviewKind } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fileIcon, nameOf } from "./file-editor";
import { plural } from "./use-files";

const KINDS: Record<FileReviewKind, { title: string; hint: string; icon: ComponentType<{ className?: string }>; safe: boolean }> = {
  build: { title: "Installed packages and build output", hint: "Installing or building again brings them back.", icon: Boxes, safe: true },
  junk: { title: "Junk files", hint: "Logs, temporary files and Finder leftovers.", icon: Wind, safe: true },
  empty: { title: "Empty files and folders", hint: "Nothing in them.", icon: FolderX, safe: true },
  duplicate: { title: "Copies", hint: "The same content lies somewhere else too — the other copy stays.", icon: Copy, safe: true },
  large: { title: "Large files", hint: "Check whether they are still needed.", icon: HardDrive, safe: false },
  scratch: { title: "Large scratch in tmp/", hint: "Goes by itself a week after its last change — delete now to free the space today.", icon: Clock3, safe: false },
  stale: { title: "Untouched for 30 days", hint: "Old reports, exports and experiments: keep what still matters.", icon: Clock3, safe: false },
  loose: { title: "Unsorted", hint: "Loose files at the top: sort them into a folder.", icon: FolderInput, safe: false },
  "unlinked-note": { title: "Notes nothing links to", hint: "Memory notes without a link from MEMORY.md are rarely read: link, merge or delete them.", icon: Unplug, safe: false },
  "broken-link": { title: "Broken links in memory", hint: "The memory points at notes that don't exist: fix the link in the note.", icon: Unlink, safe: false },
};
const ORDER = Object.keys(KINDS) as FileReviewKind[];

/** What a review item does when clicked: open it, the note that links (broken link), or the folder. */
export interface ReviewActions {
  onOpen: (item: FileReviewItem) => void;
  onDelete: (paths: string[]) => void;
  onMove: (paths: string[]) => void;
}

export function useFileReview(agentId: string) {
  return useQuery({ queryKey: qk.agentFileReview(agentId), queryFn: () => api.agents.fileReview(agentId), staleTime: 60_000 });
}

export function ReviewPane({ agent, selected, actions, frozen }: { agent: Agent; selected: string | null; actions: ReviewActions; frozen: boolean }) {
  const qc = useQueryClient();
  const review = useFileReview(agent.id);
  const recheck = useMutation({
    mutationFn: () => api.agents.fileReview(agent.id, true),
    onSuccess: (data) => qc.setQueryData(qk.agentFileReview(agent.id), data),
  });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const items = review.data?.items ?? [];
  const deletable = (i: FileReviewItem) => i.kind !== "broken-link";
  // Safe kinds start ticked, unless the agent still names the item.
  const defaults = useMemo(() => new Set(items.filter((i) => KINDS[i.kind].safe && !i.namedBy).map((i) => i.path)), [items]);
  const chosen = picked ?? defaults;
  const groups = useMemo(() => ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length), [items]);
  const chosenItems = items.filter((i) => chosen.has(i.path) && deletable(i));
  const chosenBytes = chosenItems.reduce((n, i) => n + i.bytes, 0);
  const totalBytes = items.filter(deletable).reduce((n, i) => n + i.bytes, 0);

  useEffect(() => setPicked(null), [review.data]);

  const toggle = (paths: string[], on: boolean) =>
    setPicked(() => {
      const next = new Set(chosen);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium tracking-[-0.01em]">{review.data ? (items.length ? `${plural(items.length, "thing")} to look at` : "Nothing to tidy") : "Looking through the files…"}</h2>
          <p className="text-xs text-muted-foreground">
            {review.data
              ? `${totalBytes ? `${formatBytes(totalBytes)} could go · ` : ""}checked ${formatDistanceToNowStrict(new Date(review.data.checkedAt), { addSuffix: true })}${review.data.partial ? " · very large, not everything was looked at" : ""}`
              : "Sizes, copies, junk and notes nothing links to."}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Check again" disabled={review.isFetching || recheck.isPending} onClick={() => recheck.mutate()}>
              {review.isFetching || recheck.isPending ? <Spinner /> : <RefreshCw />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Check again</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {review.isLoading ? (
          <div className="space-y-4 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9 w-11/12" />
              </div>
            ))}
          </div>
        ) : review.isError ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(review.error)}</p>
        ) : !groups.length ? (
          <div className="grid place-items-center px-6 py-16 text-center">
            <div className="mb-3 grid size-11 place-items-center rounded-full bg-brand-soft text-brand-strong">
              <CircleCheck className="size-5" />
            </div>
            <p className="text-sm font-medium">{agent.name}'s files look tidy</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">No build output, junk, copies or forgotten notes. The nightly dream keeps sorting the workspace too.</p>
          </div>
        ) : (
          <div className="divide-y">
            {groups.map((g) => {
              const meta = KINDS[g.kind];
              const Icon = meta.icon;
              const paths = g.items.filter(deletable).map((i) => i.path);
              const on = paths.filter((p) => chosen.has(p)).length;
              const bytes = g.items.reduce((n, i) => n + i.bytes, 0);
              return (
                <section key={g.kind} aria-label={meta.title} className="py-2">
                  <div className="flex items-start gap-2.5 px-4 pt-1 pb-1.5">
                    {paths.length > 0 ? (
                      <Checkbox
                        className="mt-0.5"
                        aria-label={`Select all ${meta.title.toLowerCase()}`}
                        checked={on === paths.length ? true : on ? "indeterminate" : false}
                        onCheckedChange={(v) => toggle(paths, v === true)}
                      />
                    ) : (
                      <span className="w-4" />
                    )}
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">
                        {meta.title} <span className="font-normal text-muted-foreground tabular-nums">· {g.items.length}{bytes ? ` · ${formatBytes(bytes)}` : ""}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{meta.hint}</p>
                    </div>
                  </div>
                  <ul className="px-1.5">
                    {g.items.map((item) => (
                      <ReviewRow
                        key={`${item.kind}:${item.path}`}
                        item={item}
                        active={!!selected && (selected === item.path || selected === item.related)}
                        checked={chosen.has(item.path)}
                        onCheck={deletable(item) ? (v) => toggle([item.path], v) : undefined}
                        actions={actions}
                        frozen={frozen}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {groups.length > 0 && (
        <div className="flex items-center gap-3 border-t bg-card px-4 py-2.5">
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {chosenItems.length ? (
              <>
                <span className="font-medium text-foreground">{plural(chosenItems.length, "item")}</span> selected · {formatBytes(chosenBytes)} · everything goes to the bin first
              </>
            ) : (
              "Tick what can go — it waits in the bin for 30 days."
            )}
          </p>
          <Button size="sm" variant="destructive" disabled={!chosenItems.length || frozen} onClick={() => actions.onDelete(chosenItems.map((i) => i.path))}>
            <Trash2 /> Delete {chosenItems.length || ""}
          </Button>
        </div>
      )}
    </div>
  );
}

function ReviewRow({
  item,
  active,
  checked,
  onCheck,
  actions,
  frozen,
}: {
  item: FileReviewItem;
  active: boolean;
  checked: boolean;
  onCheck?: (on: boolean) => void;
  actions: ReviewActions;
  frozen: boolean;
}) {
  const isDir = item.type === "dir";
  return (
    <li className={cn("group/row flex items-start gap-2.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-accent/50", active && "bg-secondary")}>
      <span className="mt-0.5 grid w-4 place-items-center">{onCheck ? <Checkbox aria-label={`Select ${item.path}`} checked={checked} onCheckedChange={(v) => onCheck(v === true)} /> : <FileWarning className="size-3.5 text-warning" />}</span>
      <button type="button" onClick={() => actions.onOpen(item)} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="shrink-0">{isDir ? <Folder className="size-4 text-muted-foreground" /> : fileIcon(item.path)}</span>
          <span className="truncate font-mono text-xs" title={item.path}>
            {item.path}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {item.detail}
          {item.namedBy && <span className="ml-1 rounded-[4px] bg-warning/12 px-1 py-px text-[10px] font-medium text-warning">named in {item.namedBy}</span>}
        </span>
      </button>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {item.bytes > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(item.bytes)}
            {isDir && item.files > 1 && <span className="text-muted-foreground/70"> · {item.files.toLocaleString()}</span>}
          </span>
        )}
        {item.kind === "loose" && (
          <Button size="xs" variant="ghost" className="h-5 opacity-0 group-hover/row:opacity-100" disabled={frozen} onClick={() => actions.onMove([item.path])}>
            <FolderInput /> Move
          </Button>
        )}
        {item.kind === "broken-link" && item.related && (
          <Button size="xs" variant="ghost" className="h-5" onClick={() => actions.onOpen(item)}>
            Open {nameOf(item.related)}
          </Button>
        )}
      </span>
    </li>
  );
}
