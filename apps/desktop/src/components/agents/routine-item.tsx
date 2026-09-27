import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNowStrict, format } from "date-fns";
import { CalendarClock, Clock, Ellipsis, MessageSquare, Pencil, Play, Trash2 } from "lucide-react";
import type { Agent, Routine } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/common";
import { RunStatusBadge } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { cronToHuman, localTimezone } from "./cron";

function patchRoutineCaches(qc: ReturnType<typeof useQueryClient>, id: string, patch: Partial<Routine>) {
  qc.setQueriesData<Routine[]>({ queryKey: qk.routines }, (old) =>
    Array.isArray(old) ? old.map((r) => (r.id === id ? { ...r, ...patch } : r)) : old,
  );
}

export function useToggleRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.routines.update(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.routines });
      patchRoutineCaches(qc, id, { enabled });
    },
    onError: (err, { id, enabled }) => {
      patchRoutineCaches(qc, id, { enabled: !enabled });
      toast.error("Couldn't update routine", { description: errorMessage(err) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.routines }),
  });
}

export function useRunRoutine() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (routine: Routine) => api.routines.run(routine.id),
    onSuccess: (run, routine) => {
      qc.invalidateQueries({ queryKey: qk.runs });
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success(`“${routine.name}” started`, {
        action: { label: "Watch", onClick: () => navigate(`/chat/${run.conversationId}`) },
      });
    },
    onError: (err) => toast.error("Couldn't start routine", { description: errorMessage(err) }),
  });
}

export function useDeleteRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routine: Routine) => api.routines.delete(routine.id),
    onSuccess: (_, routine) => {
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success(`“${routine.name}” deleted`);
    },
    onError: (err) => toast.error("Couldn't delete routine", { description: errorMessage(err) }),
  });
}

function relative(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { text: formatDistanceToNowStrict(d, { addSuffix: true }), full: format(d, "PPpp") };
}

/** One routine as a rich row: schedule, next/last run, enable switch and actions. */
export function RoutineItem({ routine, agent, onEdit }: { routine: Routine; agent?: Agent; onEdit: (r: Routine) => void }) {
  const toggle = useToggleRoutine();
  const run = useRunRoutine();
  const del = useDeleteRoutine();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const next = relative(routine.nextRunAt);
  const last = relative(routine.lastRunAt);
  const tz = routine.timezone && routine.timezone !== localTimezone() ? routine.timezone.replace(/_/g, " ") : null;
  const running = run.isPending && run.variables?.id === routine.id;

  return (
    <div
      className={cn(
        "group flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float md:flex-row md:items-center",
        !routine.enabled && "opacity-70",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {agent ? (
          <Link to={`/agents/${agent.id}/routines`} aria-label={`Open ${agent.name}`} className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <AgentAvatar agent={agent} size="md" />
          </Link>
        ) : (
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
            <CalendarClock className="size-4.5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={() => onEdit(routine)}
              className="truncate text-left font-medium tracking-[-0.01em] hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {routine.name}
            </button>
            {agent && <span className="truncate text-xs text-muted-foreground">· {agent.name}</span>}
            {!routine.enabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">Paused</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-foreground/80">
            <CalendarClock className="size-3.5 text-muted-foreground" />
            <span>{cronToHuman(routine.cron)}</span>
            {tz && <span className="text-xs text-muted-foreground">({tz})</span>}
          </div>
          {routine.prompt && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{routine.prompt}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pl-12 md:pl-0">
        <div className="min-w-24 text-xs">
          <div className="eyebrow">Next run</div>
          {routine.enabled && next ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 font-medium tabular-nums">
                  <Clock className="size-3" /> {next.text}
                </span>
              </TooltipTrigger>
              <TooltipContent>{next.full}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="font-medium text-muted-foreground">{routine.enabled ? "—" : "Paused"}</span>
          )}
        </div>
        <div className="min-w-28 text-xs">
          <div className="eyebrow">Last run</div>
          {routine.lastStatus && last ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5">
                  <RunStatusBadge status={routine.lastStatus} className="px-1.5" />
                  <span className="text-muted-foreground">{last.text}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{last.full}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="font-medium text-muted-foreground">Never</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Switch
            checked={routine.enabled}
            onCheckedChange={(enabled) => toggle.mutate({ id: routine.id, enabled })}
            aria-label={routine.enabled ? `Pause ${routine.name}` : `Enable ${routine.name}`}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => run.mutate(routine)} disabled={running} aria-label={`Run ${routine.name} now`}>
                {running ? <Spinner /> : <Play />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run now</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${routine.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onEdit(routine)}>
                <Pencil /> Edit
              </DropdownMenuItem>
              {routine.conversationId && (
                <DropdownMenuItem asChild>
                  <Link to={`/chat/${routine.conversationId}`}>
                    <MessageSquare /> Open conversation
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{routine.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The schedule is removed. Past runs and conversations stay in your history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => del.mutate(routine)}>
              Delete routine
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
