import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, SquareTerminal, X } from "lucide-react";
import { toast } from "sonner";
import type { ClaudeUpdateStatus } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

const HOUR = 60 * 60_000;

const lastLines = (output: string) => output.split("\n").filter((l) => l.trim()).slice(-3).join("\n") || "claude update finished without upgrading.";

export function ClaudeUpdateButton() {
  const qc = useQueryClient();
  const skipped = useUi((s) => s.skippedClaudeVersion);
  const skip = useUi((s) => s.skipClaudeVersion);
  const { data } = useQuery({ queryKey: qk.claudeUpdate, queryFn: () => api.doctor.claudeUpdate(), staleTime: HOUR / 2, refetchInterval: HOUR });
  const latest = data?.updateAvailable ? data.latest : null;

  const update = useMutation({
    mutationFn: api.doctor.updateClaude,
    onSuccess: (res) => {
      if (res.ok) {
        qc.setQueryData<ClaudeUpdateStatus>(qk.claudeUpdate, (s) => s && { ...s, current: res.version, updateAvailable: false });
        toast.success(`Claude Code ${res.version}`, { description: "Updated — new chats use it right away." });
      } else {
        if (res.version === res.previous && latest) skip(latest);
        toast.error("Couldn't update Claude Code", { description: <span className="whitespace-pre-line">{lastLines(res.output)}</span> });
      }
      void qc.invalidateQueries({ queryKey: qk.doctor });
    },
    onError: (e) => toast.error("Couldn't update Claude Code", { description: errorMessage(e) }),
  });

  const pending = update.isPending;
  const visible = !!latest && (pending || latest !== skipped);
  const run = () => update.mutate();

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="claude-update"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <div
            className={cn(
              "group/claude relative flex w-full items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-1.5 shadow-card group-data-[collapsible=icon]:hidden",
              pending && "scan-line",
            )}
          >
            <span className="relative grid size-7 shrink-0 place-items-center rounded-md border bg-paper-2 text-foreground/80">
              <SquareTerminal className="size-3.5" />
              {!pending && <LiveDot className="absolute -top-0.5 -right-0.5 size-1.5" />}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[12.5px] font-medium">Claude Code</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {pending ? (
                  <span className="text-shimmer">Installing…</span>
                ) : (
                  <>
                    <span className="font-mono text-[10.5px] text-foreground tabular-nums">{latest}</span> available
                  </>
                )}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="xs" variant="outline" className="h-7 px-2.5" onClick={run} disabled={pending}>
                  {pending ? <Spinner className="size-3" /> : <ArrowDown />}
                  {pending ? "Updating" : "Update"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Update from {data?.current} to {latest}
              </TooltipContent>
            </Tooltip>
            {!pending && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => skip(latest)}
                    aria-label={`Skip Claude Code ${latest}`}
                    className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full border bg-card text-muted-foreground opacity-0 shadow-card transition group-hover/claude:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <X className="size-2.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Skip this version</TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="hidden flex-col items-center rounded-lg border bg-card p-1 shadow-card group-data-[collapsible=icon]:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-8"
                  onClick={run}
                  disabled={pending}
                  aria-label={`Update Claude Code to ${latest}`}
                >
                  {pending ? <Spinner /> : <SquareTerminal />}
                  {!pending && <LiveDot className="absolute top-1 right-1" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{pending ? `Installing Claude Code ${latest}…` : `Update Claude Code to ${latest}`}</TooltipContent>
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
