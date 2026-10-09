import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { motion } from "motion/react";
import { Link } from "react-router";
import type { Agent, Conversation, Message, MessageBlock } from "@godmode/shared";
import { ArrowUpRight, Coins, Cpu, Info, KanbanSquare, Loader2, Pause, Play, RotateCcw, Square, Timer, Volume2, Workflow } from "lucide-react";
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
import { AttachmentList } from "./attachments";
import { useAllAgents, useBootstrap, useTasks } from "@/lib/hooks";
import { describeTool } from "./tool-meta";
import { FollowupMarker, followupBlock } from "./followup";
import { HumanTaskMarker, humanTaskBlock } from "@/components/human-tasks/human-task-chat";
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

/** "[Delegated by X]" / "[From X, another agent — …]" at the start of an older or board-relayed handoff. */
const HANDOFF_PREFIX = /^\[(?:Delegated by ([^\]\n]+?)|From ([^,\]\n]+), another agent[^\]\n]*)\]\s*/;

/**
 * A turn the human didn't write — an automation, another agent handing work over, the task board — shown as what it
 * is, on the left in a dashed card, never as the human's own bubble.
 */
export function StartedMessage({ message, delegatedFrom }: { message: Message; delegatedFrom?: Conversation["delegatedFrom"] }) {
  const { data: agents = [] } = useAllAgents();
  const { data: tasks = [] } = useTasks("all");
  const { data: boot } = useBootstrap();
  const [open, setOpen] = useState(false);
  const prefix = message.source === "delegation" ? HANDOFF_PREFIX.exec(message.content) : null;
  const body = prefix ? message.content.slice(prefix[0].length) : message.content;
  // A name read from the text is the sending agent's own word: never taken for the human, always marked as an agent.
  const human = boot?.settings.general.userName.trim().toLowerCase() ?? "";
  const parsed = prefix ? (prefix[1] ?? prefix[2] ?? "").replace(/\s*\(.*$/, "").trim() : "";
  const named = parsed && parsed.toLowerCase() !== human ? parsed : "";
  // Who handed the chat over is known to Godmode (delegatedFrom); a name in the text only labels the card.
  const from = message.source === "delegation" ? agents.find((a) => a.id === delegatedFrom?.agentId) : undefined;
  const task = message.source === "task" ? tasks.find((t) => t.conversationId === message.conversationId) : undefined;
  const long = body.length > 400 || body.split("\n").length > 4;
  const time = timeOf(message.createdAt);

  const head =
    message.source === "automation" ? (
      <>
        <Workflow className="size-3.5" aria-hidden />
        <span className="font-medium text-foreground">Automation</span>
      </>
    ) : message.source === "task" ? (
      <>
        <KanbanSquare className="size-3.5" aria-hidden />
        <span className="font-medium text-foreground">{task ? `Board ticket #${task.number}` : "Board ticket"}</span>
      </>
    ) : from ? (
      <>
        <AgentAvatar agent={from} size="sm" still className="size-4 rounded-[4px] text-[9px]" />
        <span className="min-w-0 truncate">
          From <span className="font-medium text-foreground">{from.name}</span>
          {from.role && ` · ${from.role}`}
        </span>
      </>
    ) : (
      <span className="min-w-0 truncate">
        {named ? (
          <>
            From <span className="font-medium text-foreground">{named}</span>, another agent
          </>
        ) : (
          <span className="font-medium text-foreground">From another agent</span>
        )}
      </span>
    );
  const action =
    message.source === "task" && task ? (
      <Link to={`/tasks?task=${task.id}`} className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline">
        Open ticket <ArrowUpRight className="size-3" />
      </Link>
    ) : message.source === "delegation" && from && delegatedFrom?.conversationId ? (
      <Link to={`/chat/${delegatedFrom.conversationId}`} className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline">
        Open {from.name}'s chat <ArrowUpRight className="size-3" />
      </Link>
    ) : null;

  return (
    <div className="group/msg flex flex-col items-start">
      <div className="w-full max-w-[85%] rounded-xl border border-dashed border-foreground/15 bg-card/60 px-4 py-3">
        <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {head}
          {time && (
            <time dateTime={message.createdAt} className="tabular-nums">
              · {time}
            </time>
          )}
          {action && <span className="ml-auto">{action}</span>}
        </div>
        {body && <p className={cn("text-[14px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85", long && !open && "line-clamp-4")}>{body}</p>}
        {long && (
          <button type="button" className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Show less" : "Show all"}
          </button>
        )}
        {message.attachments.length > 0 && <AttachmentList files={message.attachments} className="mt-2" />}
      </div>
      <div className="mt-1 flex h-6 items-center gap-1.5 pl-1 text-[11px] text-muted-foreground opacity-0 transition group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
        {body && <CopyButton text={body} label="Copy message" />}
      </div>
    </div>
  );
}

export function SystemMessage({ message }: { message: Message }) {
  const followup = followupBlock(message);
  if (followup) return <FollowupMarker block={followup} />;
  const done = humanTaskBlock(message);
  if (done) return <HumanTaskMarker block={done} />;
  const retry = message.blocks.find((b) => b.type === "retry");
  if (retry) return <RetryMarker block={retry} at={message.createdAt} />;
  return (
    <div className="flex justify-center">
      <span className="max-w-[80%] rounded-md border bg-card px-3 py-1 text-center text-xs text-muted-foreground">{message.content}</span>
    </div>
  );
}

/** Where a turn that ended early was picked up: by the human, or by Godmode after it restarted. */
function RetryMarker({ block, at }: { block: Extract<MessageBlock, { type: "retry" }>; at: string }) {
  const Icon = block.mode === "continue" ? Play : RotateCcw;
  const label = block.auto
    ? block.mode === "continue"
      ? "Continued after Godmode restarted"
      : "Sent again after Godmode restarted"
    : block.mode === "continue"
      ? "Continued where it stopped"
      : "Tried again";
  return (
    <div role="note" className="flex w-full items-center gap-3 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5">
        <Icon className={cn("size-3", block.mode === "continue" && "fill-current")} aria-hidden />
        <span className="font-medium text-foreground">{label}</span>
        <time dateTime={at} className="tabular-nums">
          · {timeOf(at)}
        </time>
        {block.masked && <span>· saved secrets stay masked</span>}
      </span>
      <span className="h-px flex-1 bg-border" />
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
        <MessageBlocks blocks={blocks} runId={message.runId ?? undefined} />
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
        <MessageBlocks blocks={live?.blocks ?? []} streaming runId={live?.runId} />
      </div>
    </motion.div>
  );
}
