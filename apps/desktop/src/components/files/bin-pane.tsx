import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Folder, RotateCcw, Trash, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Agent } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
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
import { fileIcon, nameOf } from "./file-editor";
import { plural, useRefreshFiles } from "./use-files";

const KEEP_DAYS = 30;

export function useBin(agentId: string) {
  return useQuery({ queryKey: qk.agentBin(agentId), queryFn: () => api.agents.deletedFiles(agentId) });
}

export function BinPane({ agent, frozen }: { agent: Agent; frozen: boolean }) {
  const bin = useBin(agent.id);
  const refresh = useRefreshFiles(agent.id);
  const [confirm, setConfirm] = useState<"empty" | { id: string; path: string } | null>(null);
  const restore = useMutation({
    mutationFn: (id: string) => api.agents.restoreDeleted(agent.id, id),
    onSuccess: (r) => {
      refresh();
      toast.success(`Put back ${nameOf(r.path)}`, { description: r.path });
    },
    onError: (err) => toast.error("Couldn't put it back", { description: errorMessage(err) }),
  });
  const purge = useMutation({
    mutationFn: (target: "empty" | { id: string }) => (target === "empty" ? api.agents.emptyBin(agent.id) : api.agents.purgeDeleted(agent.id, target.id)),
    onSuccess: (r) => {
      refresh();
      toast.success(r.removed === 1 ? "Deleted for good" : `Emptied the bin`, { description: `${formatBytes(r.bytes)} freed.` });
    },
    onError: (err) => toast.error("Couldn't delete", { description: errorMessage(err) }),
  });
  const entries = bin.data ?? [];
  const bytes = entries.reduce((n, e) => n + e.bytes, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium tracking-[-0.01em]">Recently deleted</h2>
          <p className="text-xs text-muted-foreground">
            {entries.length ? `${plural(entries.length, "item")} · ${formatBytes(bytes)} · ` : ""}kept {KEEP_DAYS} days, then the daily cleanup removes them.
          </p>
        </div>
        {entries.length > 0 && (
          <Button size="sm" variant="outline" className="ml-auto" disabled={purge.isPending} onClick={() => setConfirm("empty")}>
            <Trash /> Empty bin
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {bin.isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : bin.isError ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(bin.error)}</p>
        ) : !entries.length ? (
          <div className="grid place-items-center px-6 py-16 text-center">
            <div className="mb-3 grid size-11 place-items-center rounded-lg border bg-card shadow-card">
              <Trash2 className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">The bin is empty</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">What you delete here waits {KEEP_DAYS} days, so you can put it back.</p>
          </div>
        ) : (
          <ul className="divide-y">
            {entries.map((e) => {
              const left = Math.max(0, KEEP_DAYS - Math.floor((Date.now() - Date.parse(e.deletedAt)) / 86_400_000));
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                  {e.type === "dir" ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : fileIcon(e.path)}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs" title={e.path}>
                      {e.path}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatBytes(e.bytes)}
                      {e.type === "dir" && (e.files ? ` · ${plural(e.files, "file")}` : " · empty folder")} · deleted {formatDistanceToNowStrict(new Date(e.deletedAt), { addSuffix: true })} · {left ? `${left} days left` : "goes today"}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={frozen || restore.isPending} onClick={() => restore.mutate(e.id)}>
                    {restore.isPending && restore.variables === e.id ? <Spinner /> : <RotateCcw />} Put back
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${nameOf(e.path)} for good`} onClick={() => setConfirm({ id: e.id, path: e.path })}>
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "empty" ? `Empty ${agent.name}'s bin?` : `Delete ${confirm ? nameOf(confirm.path) : ""} for good?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "empty" ? `${plural(entries.length, "item")} (${formatBytes(bytes)}) are removed for good.` : "It can't be put back afterwards."} Files the agent had committed stay in its version history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirm) purge.mutate(confirm === "empty" ? "empty" : { id: confirm.id });
                setConfirm(null);
              }}
            >
              Delete for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
