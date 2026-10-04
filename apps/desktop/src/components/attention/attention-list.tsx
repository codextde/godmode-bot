import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangle, Coins, KanbanSquare, KeyRound, MessageCircleQuestion, OctagonAlert, Pause, Play, UserPlus, Workflow, type LucideIcon } from "lucide-react";
import type { Agent, AttentionItem } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const ICON: Record<AttentionItem["kind"], LucideIcon> = {
  question: MessageCircleQuestion,
  login: KeyRound,
  review: KanbanSquare,
  blocked: OctagonAlert,
  paused: Pause,
  held: Coins,
  failed: AlertTriangle,
  automation: Workflow,
  access: UserPlus,
};

const TONE: Partial<Record<AttentionItem["kind"], string>> = {
  question: "text-warning",
  login: "text-warning",
  held: "text-warning",
  blocked: "text-rose-600 dark:text-rose-400",
  failed: "text-destructive",
  automation: "text-destructive",
};

/**
 * Things that wait for the human, one row each: who, what, since when, and the one thing to do. A row leaves when the
 * thing is handled, wherever that happened.
 */
export function AttentionList({ items, agentById, className }: { items: AttentionItem[]; agentById: Map<string, Agent>; className?: string }) {
  return (
    <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card shadow-card", className)}>
      {items.map((item) => (
        <AttentionRow key={item.id} item={item} agent={item.agentId ? agentById.get(item.agentId) : undefined} />
      ))}
    </ul>
  );
}

function AttentionRow({ item, agent }: { item: AttentionItem; agent?: Agent }) {
  const qc = useQueryClient();
  const Icon = ICON[item.kind];
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(item.conversationId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (err) => toast.error("Couldn't continue", { description: errorMessage(err) }),
  });
  return (
    <li className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
      <span className="relative shrink-0">
        {agent ? (
          <AgentAvatar agent={agent} size="sm" still className="size-7 rounded-lg" />
        ) : (
          <span className="grid size-7 place-items-center rounded-lg border bg-secondary text-foreground/70">
            <Icon className="size-3.5" aria-hidden />
          </span>
        )}
        {agent && (
          <span className={cn("absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full border bg-card", TONE[item.kind] ?? "text-muted-foreground")}>
            <Icon className="size-2.5" aria-hidden />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <p className="truncate text-[13px] font-medium" title={item.title}>
          {item.title}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={item.detail}>
          {item.detail ? `${item.detail} · ` : ""}
          <time dateTime={item.since}>{formatDistanceToNowStrict(new Date(item.since), { addSuffix: true })}</time>
        </p>
      </div>
      {item.kind === "paused" && item.conversationId ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" asChild>
            <Link to={item.link}>Open</Link>
          </Button>
          <Button size="xs" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate()}>
            {resume.isPending ? <Spinner /> : <Play className="fill-current" />} Continue
          </Button>
        </span>
      ) : (
        <Button size="xs" variant={item.kind === "question" || item.kind === "review" ? "default" : "outline"} asChild className="shrink-0">
          <Link to={item.link}>{item.action}</Link>
        </Button>
      )}
    </li>
  );
}
