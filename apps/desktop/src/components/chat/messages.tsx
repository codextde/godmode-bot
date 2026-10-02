import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { motion } from "motion/react";
import type { Agent, Message, MessageBlock } from "@godmode/shared";
import { Coins, Cpu, Info, Loader2, Pause, Square, Timer, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { Orb, type OrbVariant } from "@/components/aicss/Orb";
import { formatCost, formatDuration, formatElapsed, formatTokens, useModelLabel } from "@/components/runs/run-status";
import { useSpeaker } from "@/hooks/use-voice";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { LiveRun } from "@/stores/live";
import { cn } from "@/lib/utils";
import { MessageBlocks } from "./message-blocks";
import { CopyButton } from "./copy-button";
import { UserBubble } from "./user-bubble";
import { describeTool } from "./tool-meta";
import { FollowupMarker, followupBlock } from "./followup";
import { liveMood } from "./conversation-mood";

const FALLBACK_AGENT = { avatar: "🤖", color: "violet" };

function timeOf(iso: string) {
  try {
    return format(new Date(iso), "p");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* User                                                                 */
/* ------------------------------------------------------------------ */

export function UserMessage({ message, pending }: { message: Message; pending?: boolean }) {
  return (
    <div className="group/msg flex flex-col items-end">
      <UserBubble content={message.content} attachments={message.attachments} dim={pending} />
      <div className="mt-1 flex h-6 items-center gap-1.5 pr-1 text-[11px] text-muted-foreground">
        {pending ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Sending…
          </span>
        ) : (
          <span className="flex items-center gap-0.5 opacity-0 transition group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
            <time dateTime={message.createdAt} className="px-1">
              {timeOf(message.createdAt)}
            </time>
            {message.content && <CopyButton text={message.content} label="Copy message" />}
          </span>
        )}
      </div>
    </div>
  );
}

export function SystemMessage({ message }: { message: Message }) {
  const followup = followupBlock(message);
  if (followup) return <FollowupMarker block={followup} />;
  return (
    <div className="flex justify-center">
      <span className="max-w-[80%] rounded-md border bg-card px-3 py-1 text-center text-xs text-muted-foreground">{message.content}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Assistant                                                            */
/* ------------------------------------------------------------------ */

function AgentHeader({ agent, children }: { agent?: Agent; children?: ReactNode }) {
  return (
    <div className="mb-1.5 flex min-h-8 items-center gap-2 text-sm">
      <span className="font-medium tracking-[-0.01em]">{agent?.name ?? "Assistant"}</span>
      {children}
    </div>
  );
}

export function AssistantMessage({ message, agent }: { message: Message; agent?: Agent }) {
  const [hovered, setHovered] = useState(false);
  const blocks: MessageBlock[] = useMemo(
    () => (message.blocks.length ? message.blocks : message.content ? [{ type: "text", text: message.content }] : []),
    [message.blocks, message.content],
  );
  const speaker = useSpeaker();
  const speaking = speaker.speakingKey === message.id;
  const text = message.content || blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n\n");

  return (
    <div className="group/msg flex gap-3" onMouseEnter={() => setHovered(true)} onFocus={() => setHovered(true)}>
      <AgentAvatar agent={agent ?? FALLBACK_AGENT} size="md" mood="idle" still className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <AgentHeader agent={agent} />
        <MessageBlocks blocks={blocks} />
        <div className="mt-1.5 flex h-7 items-center gap-0.5 text-[11px] text-muted-foreground opacity-0 transition group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100">
          {text && <CopyButton text={text} label="Copy reply" />}
          {text && speaker.supported && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={speaking ? "Stop reading" : "Read aloud"}
                  className={cn("text-muted-foreground hover:text-foreground", speaking && "text-foreground")}
                  onClick={() => (speaking ? speaker.stop() : void speaker.speak(text, message.id))}
                >
                  {speaking ? <Square className="fill-current" /> : <Volume2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{speaking ? "Stop reading" : "Read aloud"}</TooltipContent>
            </Tooltip>
          )}
          <time dateTime={message.createdAt} className="px-1.5">
            {timeOf(message.createdAt)}
          </time>
          {message.runId && hovered && <RunMeta runId={message.runId} />}
        </div>
      </div>
    </div>
  );
}

function RunMeta({ runId }: { runId: string }) {
  const modelLabel = useModelLabel();
  const { data: run } = useQuery({
    queryKey: qk.run(runId),
    queryFn: () => api.runs.get(runId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!run) return null;
  const tokens = run.usage ? run.usage.inputTokens + run.usage.outputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens : null;
  return (
    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2.5 border-l pl-2.5">
      {run.durationMs != null && (
        <span className="inline-flex items-center gap-1">
          <Timer className="size-3" /> {formatDuration(run.durationMs)}
        </span>
      )}
      {run.costUsd != null && (
        <span className="inline-flex items-center gap-1">
          <Coins className="size-3" /> {formatCost(run.costUsd)}
        </span>
      )}
      {run.model && (
        <span className="hidden items-center gap-1 @lg:inline-flex">
          <Cpu className="size-3" /> {modelLabel(run.model)}
        </span>
      )}
      {(tokens != null || run.numTurns != null) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Run details" className="inline-flex items-center hover:text-foreground">
              <Info className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {run.numTurns != null && <div>{run.numTurns} turns</div>}
            {run.usage && (
              <div>
                {formatTokens(run.usage.inputTokens)} in · {formatTokens(run.usage.outputTokens)} out · {formatTokens(run.usage.cacheReadTokens)} cached
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      )}
    </motion.span>
  );
}

/* ------------------------------------------------------------------ */
/* Live (streaming) turn                                                */
/* ------------------------------------------------------------------ */

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Pick an orb animation that loosely matches what the agent is doing. */
export function orbVariantFor(label: string): OrbVariant {
  const l = label.toLowerCase();
  if (/(brows|open|navigat|click|page|typ)/.test(l)) return "B2";
  if (/(search|look|find|fetch)/.test(l)) return "S4";
  if (/(login|password|2fa|vault|code)/.test(l)) return "B4";
  if (/(delegat|agent)/.test(l)) return "B5";
  if (/(writ|edit|creat|sav)/.test(l)) return "S2";
  if (/(queue|wait|start)/.test(l)) return "C1";
  return "S3";
}

export function liveActivityLabel(live: LiveRun | null): string {
  if (!live) return "Starting…";
  if (live.status === "queued") return "Queued…";
  if (live.activity) return live.activity;
  const last = live.blocks[live.blocks.length - 1];
  if (!last) return "Thinking…";
  if (last.type === "tool_use" && last.result === undefined) return `${describeTool(last.name, last.input).title}…`;
  if (last.type === "thinking") return "Thinking…";
  if (last.type === "text") return "Writing…";
  return "Working…";
}

export function LiveAssistantMessage({
  agent,
  live,
  startedAt,
  onStop,
  stopping,
  onPause,
  pausing,
}: {
  agent?: Agent;
  live: LiveRun | null;
  startedAt: number;
  onStop?: () => void;
  stopping?: boolean;
  /** Make the run stand still so it can continue later. */
  onPause?: () => void;
  pausing?: boolean;
}) {
  const now = useNow(1000);
  const label = liveActivityLabel(live);
  const since = live?.startedAt ?? startedAt;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3" aria-live="polite" aria-busy="true">
      <AgentAvatar agent={agent ?? FALLBACK_AGENT} size="md" mood={liveMood(live).mood} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <AgentHeader agent={agent}>
          <span className="flex min-w-0 items-center gap-2 rounded-md border bg-card py-1 pr-2 pl-1.5 text-xs shadow-card">
            <Orb variant={orbVariantFor(label)} size={16} label={label} />
            <span className="text-shimmer truncate font-medium">{label}</span>
            <span className="border-l pl-2 font-mono text-[11px] text-muted-foreground tabular-nums">{formatElapsed(now - since)}</span>
          </span>
          {(onPause || onStop) && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {onPause && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="xs" onClick={onPause} disabled={pausing || stopping} className="gap-1.5 text-muted-foreground hover:text-foreground">
                      {pausing ? <Loader2 className="animate-spin" /> : <Pause className="size-2.5 fill-current" />}
                      {pausing ? "Pausing…" : "Pause"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{pausing ? "Finishing the step it is in" : "Pause after the current step — continue anytime"}</TooltipContent>
                </Tooltip>
              )}
              {onStop && (
                <Button type="button" variant="ghost" size="xs" onClick={onStop} disabled={stopping} className="gap-1.5 text-muted-foreground hover:text-destructive">
                  {stopping ? <Loader2 className="animate-spin" /> : <Square className="size-2.5 fill-current" />}
                  Stop
                </Button>
              )}
            </span>
          )}
        </AgentHeader>
        <MessageBlocks blocks={live?.blocks ?? []} streaming />
      </div>
    </motion.div>
  );
}
