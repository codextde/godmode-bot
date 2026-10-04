import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Play } from "lucide-react";
import type { BudgetReleaseInput, BudgetStatus } from "@godmode/shared";
import { formatUsd } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** "Spent $12.40 of $50.00 this month" with a bar; used up: what waits, and the way on. */
export function BudgetMeter({
  status,
  resetsAt,
  whose,
  setLink,
  release,
  className,
}: {
  status: BudgetStatus;
  resetsAt: string;
  /** "the team's" / "Mia's" */
  whose: string;
  /** Where the budget is set (no budget: "Set a budget"). */
  setLink?: string;
  release?: BudgetReleaseInput;
  className?: string;
}) {
  const qc = useQueryClient();
  const letRun = useMutation({
    mutationFn: () => api.budgets.release(release!),
    onSuccess: ({ continued }) => {
      qc.invalidateQueries({ queryKey: qk.spend });
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success(continued === 1 ? "1 run continues" : `${continued} runs continue`);
    },
    onError: (err) => toast.error("Couldn't continue them", { description: errorMessage(err) }),
  });
  const { budgetUsd, spentUsd, state, held } = status;
  if (budgetUsd === null) {
    return (
      <p className={cn("text-[13px] text-muted-foreground", className)}>
        Spent <span className="font-medium text-foreground tabular-nums">{formatUsd(spentUsd)}</span> this month.{" "}
        {setLink && (
          <Link to={setLink} className="underline-offset-2 hover:text-foreground hover:underline">
            Set a budget
          </Link>
        )}
      </p>
    );
  }
  const share = Math.min(1, spentUsd / budgetUsd);
  const sentence = `Spent ${formatUsd(spentUsd)} of ${formatUsd(budgetUsd)} this month`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="tabular-nums">
          Spent <span className="font-medium">{formatUsd(spentUsd)}</span> <span className="text-muted-foreground">of {formatUsd(budgetUsd)} this month</span>
        </span>
        {state === "warning" && <span className="rounded-[4px] bg-warning/10 px-1.5 text-[11px] font-medium text-warning tabular-nums">{Math.floor(share * 100)}% used</span>}
        <span className="ml-auto text-xs text-muted-foreground">Resets {format(new Date(resetsAt), "MMM d")}</span>
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={budgetUsd} aria-valuenow={Math.min(spentUsd, budgetUsd)} aria-valuetext={sentence} className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", state === "exhausted" ? "bg-destructive" : state === "warning" ? "bg-warning" : "bg-foreground/60")}
          style={{ width: `${Math.max(2, share * 100)}%` }}
        />
      </div>
      {state === "exhausted" && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 basis-60">
            Used up — {whose} automations, follow-ups and board tickets wait. Chats you start still run.
            {held > 0 && <span className="font-medium text-foreground"> {held === 1 ? "1 run is held." : `${held} runs are held.`}</span>}
          </span>
          {held > 0 && release && (
            <Button size="xs" variant="outline" disabled={letRun.isPending} onClick={() => letRun.mutate()} title="Run them although the budget is used up">
              {letRun.isPending ? <Spinner /> : <Play />} Let {held === 1 ? "it" : "them"} run
            </Button>
          )}
          {setLink && (
            <Button size="xs" variant="ghost" asChild>
              <Link to={setLink}>Raise budget</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
