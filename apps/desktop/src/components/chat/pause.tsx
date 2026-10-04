import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceStrict, isToday } from "date-fns";
import type { ConversationWithMessages, MessageBlock, RunPause } from "@godmode/shared";
import { ArrowUp, Hourglass, MessageCircleQuestion, Pause, Play, ShieldCheck, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/components/vault/use-now";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { followupIn, followupWhen } from "./followup";

/** "Session limit", "Usage limit" */
function limitTitle(limit: string | null | undefined): string {
  const name = limit?.trim() || "usage limit";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function usePauseActions(conversationId: string) {
  const qc = useQueryClient();
  const key = qk.conversation(conversationId);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: qk.conversationLists });
  };
  const pause = useMutation({
    mutationFn: () => api.conversations.pause(conversationId),
    onError: (err) => toast.error("Couldn't pause", { description: errorMessage(err) }),
  });
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(conversationId),
    onSuccess: refresh,
    onError: (err) => {
      refresh();
      toast.error("Couldn't continue", { description: errorMessage(err) });
    },
  });
  const auto = useMutation({
    mutationFn: (on: boolean) => api.conversations.autoContinue(conversationId, on),
    onMutate: (on) => qc.setQueryData<ConversationWithMessages>(key, (old) => (old?.paused ? { ...old, paused: { ...old.paused, auto: on } } : old)),
    onSuccess: (paused) => qc.setQueryData<ConversationWithMessages>(key, (old) => (old?.paused ? { ...old, paused } : old)),
    onError: (err) => {
      refresh();
      toast.error("Couldn't change that", { description: errorMessage(err) });
    },
  });
  const stop = useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onSuccess: refresh,
    onError: (err) => toast.error("Couldn't stop the run", { description: errorMessage(err) }),
  });
  return { pause, resume, auto, stop };
}

/** Above the composer while the chat's run stands still: what it waits for, and the way on. */
export function PauseBar({ conversationId, pause, agentName, queued }: { conversationId: string; pause: RunPause; agentName: string; queued: number }) {
  if (pause.reason === "question") return <QuestionBar conversationId={conversationId} pause={pause} agentName={agentName} />;
  return <StandStillBar conversationId={conversationId} pause={pause} agentName={agentName} queued={queued} />;
}

/** The run waits for the human's answer: the card in the thread asks; this bar says so where the human types. */
function QuestionBar({ conversationId, pause, agentName }: { conversationId: string; pause: RunPause; agentName: string }) {
  const now = useNow(30_000);
  const { stop } = usePauseActions(conversationId);
  const approval = pause.question?.kind === "approval";
  const Icon = approval ? ShieldCheck : MessageCircleQuestion;
  const show = () => {
    const card = pause.question ? document.getElementById(`question-${pause.question.id}`) : null;
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.querySelector<HTMLElement>("button:not([disabled]), textarea")?.focus({ preventScroll: true });
  };
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-warning/30 bg-card py-2 pr-2 pl-2.5 shadow-card" role="status">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-warning/30 bg-warning/[0.08] text-warning">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          <span className="truncate font-medium">{approval ? `${agentName} needs your OK` : `${agentName} is waiting for your answer`}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {now - new Date(pause.pausedAt).getTime() < 60_000
              ? "just now"
              : formatDistanceStrict(new Date(pause.pausedAt), now, { addSuffix: true, roundingMethod: "floor" })}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={pause.question?.title}>
          {approval ? "Approve or decline above — or reply below." : "Pick an answer above or type it below."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {pause.question && (
          <Button size="xs" variant="ghost" onClick={show}>
            <ArrowUp />
            <span className="hidden @lg:inline">{approval ? "Show request" : "Show question"}</span>
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="xs" variant="ghost" aria-label="Stop" className="text-muted-foreground hover:text-destructive" disabled={stop.isPending} onClick={() => stop.mutate(pause.runId)}>
              {stop.isPending ? <Spinner /> : <Square className="size-2.5 fill-current" />}
              <span className="hidden @lg:inline">Stop</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Stop for good — the question is withdrawn</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function StandStillBar({ conversationId, pause, agentName, queued }: { conversationId: string; pause: RunPause; agentName: string; queued: number }) {
  const now = useNow(30_000);
  const { resume, auto, stop } = usePauseActions(conversationId);
  const limit = pause.reason === "limit";
  const along = queued > 0 ? ` with your ${queued > 1 ? `${queued} messages` : "message"}` : "";
  const resetPassed = !!pause.resumeAt && new Date(pause.resumeAt).getTime() <= now;

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-2.5 shadow-card" role="status">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg border",
          limit ? "border-warning/30 bg-warning/[0.08] text-warning" : "bg-secondary text-foreground/80",
        )}
      >
        {limit ? <Hourglass className="size-4" aria-hidden /> : <Pause className="size-4 fill-current" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          <span className="truncate font-medium">{limit ? `Claude's ${pause.limit ?? "usage limit"} is reached` : "Paused"}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {limit && pause.resumeAt
              ? resetPassed
                ? "resets any moment"
                : `resets ${followupIn(pause.resumeAt, now)}`
              : now - new Date(pause.pausedAt).getTime() < 60_000
                ? "just now"
                : formatDistanceStrict(new Date(pause.pausedAt), now, { addSuffix: true, roundingMethod: "floor" })}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {!limit
            ? `${agentName} picks the work up where it stopped${along}.`
            : pause.auto && pause.resumeAt
              ? `${agentName} continues by itself ${followupWhen(pause.resumeAt)}${along}.`
              : pause.resumeAt
                ? `Resets ${followupWhen(pause.resumeAt)} — continue then, and ${agentName} goes on where it stopped.`
                : `Continue when the limit has reset — ${agentName} goes on where it stopped.`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {limit && pause.resumeAt && (
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Switch size="sm" checked={pause.auto} onCheckedChange={(on) => auto.mutate(on)} aria-label="Continue by itself when the limit resets" />
                <span className="hidden @lg:inline">Auto</span>
              </label>
            </TooltipTrigger>
            <TooltipContent side="top">{pause.auto ? "Continues by itself when the limit resets" : "Waits for you after the reset"}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="xs" variant={limit ? "ghost" : "default"} disabled={resume.isPending} onClick={() => resume.mutate()}>
              {resume.isPending ? <Spinner /> : <Play className="fill-current" />}
              {limit ? <span className="hidden @lg:inline">Continue now</span> : "Continue"}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{limit ? "Try now instead of waiting for the reset" : `${agentName} goes on where it stopped`}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="xs" variant="ghost" aria-label="Stop" className="text-muted-foreground hover:text-destructive" disabled={stop.isPending} onClick={() => stop.mutate(pause.runId)}>
              {stop.isPending ? <Spinner /> : <Square className="size-2.5 fill-current" />}
              <span className="hidden @lg:inline">Stop</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Stop for good — it won't continue</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

type PauseBlock = Extract<MessageBlock, { type: "pause" }>;

/** Where a run stood still, inside the turn it belongs to. */
export function PauseMarker({ block }: { block: PauseBlock }) {
  const limit = block.reason === "limit";
  const Icon = limit ? Hourglass : Pause;
  const time = (iso: string) => format(new Date(iso), "HH:mm");
  return (
    <div role="note" className="flex items-center gap-3 py-0.5 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5 tabular-nums">
        <Icon className={cn("size-3.5", limit ? "text-warning" : "fill-current text-foreground/70")} aria-hidden />
        <span className="font-medium text-foreground">{limit ? `${limitTitle(block.limit)} reached` : "Paused"}</span>
        <time dateTime={block.at}>{time(block.at)}</time>
        {block.resumedAt ? (
          <span>
            · continued <time dateTime={block.resumedAt}>{time(block.resumedAt)}</time>
          </span>
        ) : (
          limit && block.resumeAt && <span>· resets {isToday(new Date(block.resumeAt)) ? time(block.resumeAt) : followupWhen(block.resumeAt)}</span>
        )}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
