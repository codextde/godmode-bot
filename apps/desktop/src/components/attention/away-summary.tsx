import { useMemo } from "react";
import { Link } from "react-router";
import { formatDistanceStrict } from "date-fns";
import { motion } from "motion/react";
import { AlertTriangle, ArrowUpRight, KanbanSquare, MessageCircle, Workflow, X, type LucideIcon } from "lucide-react";
import type { Agent, AwayHighlight } from "@godmode/shared";
import { formatUsd } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useAway } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

const ICON: Record<AwayHighlight["kind"], LucideIcon> = { delivered: KanbanSquare, failed: AlertTriangle, replied: MessageCircle, automation: Workflow };
const TONE: Partial<Record<AwayHighlight["kind"], string>> = { failed: "text-destructive", automation: "text-destructive", delivered: "text-brand-strong" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * First thing on Home after the human was away for a while: what the team did meanwhile — who worked, what it cost,
 * and the few things worth a look. Closed with ×; it doesn't come back until the next time they were away.
 */
export function AwaySummaryCard({ agents }: { agents: Agent[] }) {
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const away = useUi((s) => s.away);
  const setAway = useUi((s) => s.setAway);
  const { data } = useAway(away);
  if (!away || !data || (data.finished === 0 && data.delivered === 0)) return null;
  const facts = [
    plural(data.finished, "run") + " finished",
    data.failed ? plural(data.failed, "problem") : null,
    data.delivered ? `${plural(data.delivered, "ticket")} delivered` : null,
    data.costUsd > 0 ? `${formatUsd(data.costUsd)} spent` : null,
  ].filter(Boolean);

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
      aria-labelledby="away-title"
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 id="away-title" className="eyebrow">
          While you were away · {formatDistanceStrict(new Date(away.since), new Date(away.until))}
        </h2>
        <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="Close the summary" onClick={() => setAway(null)}>
          <X />
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3.5 py-2.5">
          <p className="text-[13px] font-medium">{facts.join(" · ")}</p>
          {data.agents.length > 0 && (
            <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Who worked">
              {data.agents.slice(0, 5).map((a) => {
                const agent = agentById.get(a.agentId);
                return (
                  <li key={a.agentId} className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`${a.name}: ${plural(a.runs, "run")}, ${formatUsd(a.costUsd)}`}>
                    {agent && <AgentAvatar agent={agent} size="sm" still className="size-5 rounded-md text-[10px]" />}
                    <span className="text-foreground">{a.name}</span>
                    <span className="tabular-nums">{a.runs}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {data.highlights.length > 0 && (
          <ul className="divide-y">
            {data.highlights.map((h) => {
              const Icon = ICON[h.kind];
              return (
                <li key={`${h.kind}:${h.link}`}>
                  <Link to={h.link} className="group flex min-w-0 items-center gap-3 px-3.5 py-2 text-[13px] transition hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none">
                    <Icon className={cn("size-3.5 shrink-0", TONE[h.kind] ?? "text-muted-foreground")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{h.text}</span>
                    <time dateTime={h.at} className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDistanceStrict(new Date(h.at), new Date(), { addSuffix: true })}
                    </time>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </motion.section>
  );
}
