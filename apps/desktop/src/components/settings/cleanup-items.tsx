import { useState, type ComponentType } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import {
  BroomSparkles,
  ChevronDown,
  CircleCheck,
  Clock,
  CloudDownload,
  Database,
  Disc3,
  FileClock,
  GitBranch,
  GitFork,
  Globe,
  History,
  Lock,
  ScrollText,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { CleanupId, CleanupItem, CleanupReport, CleanupRun } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./settings-kit";

const ICONS: Record<CleanupId, ComponentType<{ className?: string }>> = {
  "temp-files": FileClock,
  "browser-cache": Globe,
  "task-worktrees": GitBranch,
  "task-clones": GitFork,
  "agent-history": History,
  database: Database,
  "old-logs": ScrollText,
  "vm-downloads": CloudDownload,
  trash: Trash2,
  "vm-images": Disc3,
};

const size = (bytes: number, upTo: boolean) => `${upTo ? "up to " : ""}${formatBytes(bytes)}`;

const cleanable = (i: CleanupItem) => i.count > 0 && !i.blocked;

function defaults(items: CleanupItem[]): Set<CleanupId> {
  return new Set(items.filter((i) => i.recommended && cleanable(i)).map((i) => i.id));
}

function toastRun(run: CleanupRun) {
  const failed = run.results.filter((r) => !r.ok);
  const done = run.results.filter((r) => r.ok && r.removed);
  if (done.length || !failed.length) {
    toast.success(run.freedBytes ? `Freed ${formatBytes(run.freedBytes)}` : "All clean", {
      description: done.length ? done.map((r) => r.name).join(" · ") : "There was nothing left to remove.",
    });
  }
  for (const r of failed) toast.error(`${r.name}: not everything could go`, { description: <span className="whitespace-pre-line">{r.output}</span> });
}

/** What can go, picked by the human: recommended items are preselected, the rest needs a look first. */
export function CleanupItems({ report }: { report: CleanupReport }) {
  const qc = useQueryClient();
  // null = the recommended selection, which follows the report until the human changes it.
  const [picked, setPicked] = useState<Set<CleanupId> | null>(null);
  const [open, setOpen] = useState<CleanupId | null>(null);
  const [confirming, setConfirming] = useState(false);

  const items = report.items.filter((i) => i.count > 0 || i.blocked);
  const clean = report.items.filter((i) => i.count === 0 && !i.blocked);
  const selected = new Set([...(picked ?? defaults(report.items))].filter((id) => report.items.some((i) => i.id === id && cleanable(i))));
  const chosen = items.filter((i) => selected.has(i.id));
  const total = chosen.reduce((n, i) => n + i.bytes, 0);
  const upTo = chosen.some((i) => i.upTo);
  const forGood = chosen.filter((i) => !i.recommended);

  const run = useMutation({
    mutationFn: (ids: CleanupId[]) => api.cleanup.run(ids),
    onSuccess: (result) => {
      toastRun(result);
      setPicked(null);
      void qc.invalidateQueries({ queryKey: qk.cleanup });
    },
    onError: (e) => toastApiError(e, "Couldn't clean up", qc),
  });

  const toggle = (id: CleanupId, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const start = () => (forGood.length ? setConfirming(true) : run.mutate([...selected]));

  return (
    <SettingsGroup
      title="Clean up"
      icon={<BroomSparkles />}
      description="Safe items are picked for you. Anything that may still hold work stays."
      bodyClassName="py-1"
      actions={
        items.length > 0 && (
          <Button size="sm" onClick={start} disabled={!selected.size || run.isPending}>
            {run.isPending ? <Spinner /> : <BroomSparkles />}
            {run.isPending ? "Cleaning…" : total ? `Free ${size(total, upTo)}` : "Clean up"}
          </Button>
        )
      }
    >
      {items.length === 0 && (
        <div className="flex items-center gap-3 py-5">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-success/10 text-success">
            <CircleCheck className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">Nothing to clean up</p>
            <p className="text-xs text-muted-foreground">Godmode's data folder is tidy.</p>
          </div>
        </div>
      )}
      {items.map((item, i) => (
        <motion.div key={item.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
          <ItemRow
            item={item}
            checked={selected.has(item.id)}
            onCheck={(on) => toggle(item.id, on)}
            expanded={open === item.id}
            onExpand={() => setOpen(open === item.id ? null : item.id)}
            busy={run.isPending && selected.has(item.id)}
          />
        </motion.div>
      ))}
      {clean.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3.5 text-xs text-muted-foreground">
          <span>Already clean</span>
          {clean.map((i) => (
            <span key={i.id} className="flex items-center gap-1">
              <CircleCheck className="size-3.5 text-success" /> {i.name}
            </span>
          ))}
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove for good?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>These can't be brought back once they are gone:</p>
                <ul className="space-y-1.5">
                  {forGood.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-4 rounded-md bg-secondary/70 px-3 py-2 text-foreground">
                      <span>{i.name}</span>
                      <span className="text-muted-foreground tabular-nums">{size(i.bytes, i.upTo)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run.mutate([...selected])}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

function ItemRow({
  item,
  checked,
  onCheck,
  expanded,
  onExpand,
  busy,
}: {
  item: CleanupItem;
  checked: boolean;
  onCheck: (on: boolean) => void;
  expanded: boolean;
  onExpand: () => void;
  busy: boolean;
}) {
  const Icon = ICONS[item.id];
  const kept = item.entries.filter((e) => e.kept).length;
  const id = `cleanup-${item.id}`;
  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        <Checkbox id={id} className="mt-2.5" checked={checked} disabled={!cleanable(item)} onCheckedChange={(v) => onCheck(v === true)} />
        <div className={cn("grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground", !cleanable(item) && "opacity-60")}>
          {busy ? <Spinner className="size-4" /> : <Icon className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <label htmlFor={id} className="cursor-pointer text-sm font-medium">
              {item.name}
            </label>
            {!item.recommended && (
              <Badge variant="outline" className="h-5 rounded-[5px] border-warning/30 text-[10px] font-normal text-warning">
                Review first
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
          {item.blocked && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warning">
              <Clock className="size-3.5 shrink-0" /> {item.blocked}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-controls={`${id}-entries`}
          className="group flex shrink-0 items-center gap-2 rounded-md py-1 pr-1 pl-2 text-right outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span>
            <span className="block text-sm font-medium tabular-nums">{size(item.bytes, item.upTo)}</span>
            <span className="block text-[11px] text-muted-foreground tabular-nums">
              {item.count} {item.count === 1 ? "item" : "items"}
              {kept > 0 && ` · ${kept} kept`}
            </span>
          </span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={`${id}-entries`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="ml-[3.75rem] overflow-hidden"
          >
            <ul className="mt-2.5 max-h-72 divide-y overflow-y-auto rounded-lg border bg-paper-2/60">
              {item.entries.map((e, i) => (
                <li key={`${e.path ?? e.name}-${i}`} className="flex items-start justify-between gap-4 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground" title={e.path ?? undefined}>
                      {e.name}
                    </p>
                    {e.kept ? (
                      <p className="mt-0.5 flex items-center gap-1 text-warning">
                        <Lock className="size-3 shrink-0" /> {e.kept}
                      </p>
                    ) : (
                      e.modifiedAt && <p className="mt-0.5 text-muted-foreground">{formatDistanceToNow(new Date(e.modifiedAt), { addSuffix: true })}</p>
                    )}
                  </div>
                  <span className={cn("shrink-0 tabular-nums", e.kept ? "text-muted-foreground/70 line-through" : "text-muted-foreground")}>{formatBytes(e.bytes)}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
