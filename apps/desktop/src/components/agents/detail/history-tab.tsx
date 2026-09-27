import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import { GitCommitHorizontal, History } from "lucide-react";
import type { Agent, GitCommit } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { EmptyState } from "@/components/common";
import { CopyButton } from "@/components/chat/copy-button";
import { Skeleton } from "@/components/ui/skeleton";

/** isomorphic-git reports seconds; accept ISO strings and ms too. */
function commitDate(ts: string): Date {
  if (/^\d+$/.test(ts)) {
    const n = Number(ts);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  return new Date(ts);
}

function dayLabel(d: Date) {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, MMM d, yyyy");
}

export function HistoryTab({ agent }: { agent: Agent }) {
  const q = useQuery({ queryKey: qk.agentCommits(agent.id), queryFn: () => api.agents.commits(agent.id) });

  const groups = useMemo(() => {
    const out: { label: string; commits: (GitCommit & { date: Date })[] }[] = [];
    for (const c of q.data ?? []) {
      const date = commitDate(c.timestamp);
      const label = Number.isNaN(date.getTime()) ? "Unknown date" : dayLabel(date);
      const last = out[out.length - 1];
      if (last?.label === label) last.commits.push({ ...c, date });
      else out.push({ label, commits: [{ ...c, date }] });
    }
    return out;
  }, [q.data]);

  if (q.isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (q.isError) return <EmptyState icon={<History />} title="Couldn't load history" description={errorMessage(q.error)} />;
  if (!groups.length) {
    return (
      <EmptyState
        icon={<History />}
        title="No history yet"
        description={`Every run, memory update and settings change is committed to ${agent.name}'s git repository and shows up here.`}
      />
    );
  }

  let index = 0;
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {agent.name}'s memory lives in a git repository — every change is versioned.
        <span className="ml-1 font-mono text-xs">{agent.repoPath}</span>
      </p>
      {groups.map((g) => (
        <section key={g.label}>
          <h3 className="eyebrow mb-3">{g.label}</h3>
          <ol className="relative space-y-1 border-l pl-6">
            {g.commits.map((c) => {
              const [title, ...rest] = c.message.trim().split("\n");
              const body = rest.join("\n").trim();
              const i = index++;
              return (
                <motion.li
                  key={c.oid}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i, 20) * 0.02 }}
                  className="group relative rounded-lg px-3 py-2.5 transition hover:bg-accent/50"
                >
                  <span className="absolute top-3.5 -left-[31px] grid size-4 place-items-center rounded-full border bg-card text-muted-foreground">
                    <GitCommitHorizontal className="size-3" />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 text-sm font-medium">{title || "(no message)"}</span>
                    <span className="text-xs text-muted-foreground tabular-nums" title={Number.isNaN(c.date.getTime()) ? undefined : format(c.date, "PPpp")}>
                      {Number.isNaN(c.date.getTime()) ? c.timestamp : formatDistanceToNowStrict(c.date, { addSuffix: true })}
                    </span>
                  </div>
                  {body && <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">{body}</p>}
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{c.author}</span>
                    <span>·</span>
                    <code className="rounded-[4px] border bg-secondary px-1 font-mono">{c.oid.slice(0, 7)}</code>
                    <CopyButton text={c.oid} label="Copy commit hash" className="opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100" />
                  </div>
                </motion.li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
