import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { CircleCheck, CircleX, MessagesSquare, Phone, PhoneIncoming, PhoneOutgoing, Plus, RefreshCw, Settings2, Target, TriangleAlert } from "lucide-react";
import type { Agent, CallPurpose, PhoneCall } from "@godmode/shared";
import { isCallActive } from "@godmode/shared";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { CallStatusPill, OwnerCallBadge, callName, formatCallTime } from "@/components/calls/call-parts";
import { NewCallDialog } from "@/components/calls/new-call-dialog";
import { QueryError } from "@/components/integrations/query-error";
import { formatCost } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/components/vault/use-now";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents, useSettings } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const LIMIT = 200;
const LIVE_POLL = 5_000;

const GOAL_LABEL: Record<CallPurpose, string> = {
  task: "Goal",
  question: "Question for you",
  inform: "News for you",
  inbound: "What the caller wanted",
};

export default function CallsPage() {
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState(false);
  const phone = useSettings().data?.phone;
  const calls = useQuery({
    queryKey: qk.callList(LIMIT),
    queryFn: () => api.calls.list(LIMIT),
    // Websocket events refresh the list; while a call is on, it's polled as well so its status never lags.
    refetchInterval: (q) => (q.state.data?.some(isCallActive) ? LIVE_POLL : false),
  });
  const list = calls.data ?? [];
  const wanted = params.get("call");
  const listed = wanted ? list.find((c) => c.id === wanted) : list[0];
  // A call older than the list (a link from an old chat): load it on its own.
  const single = useQuery({
    queryKey: qk.call(wanted ?? ""),
    queryFn: () => api.calls.get(wanted!),
    enabled: !!wanted && !!calls.data && !listed,
    refetchInterval: (q) => (q.state.data && isCallActive(q.state.data) ? LIVE_POLL : false),
  });
  const selected = listed ?? single.data ?? null;

  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const live = list.filter(isCallActive).length;

  const select = (id: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("call", id);
        return next;
      },
      { replace: true },
    );

  const newCall = (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={phone?.enabled ? -1 : 0}>
          <Button onClick={() => setDialog(true)} disabled={!phone?.enabled}>
            <Plus /> New call
          </Button>
        </span>
      </TooltipTrigger>
      {!phone?.enabled && <TooltipContent>Turn on phone calls in Settings first</TooltipContent>}
    </Tooltip>
  );

  return (
    <div className="relative">
      <PageHeader
        icon={<Phone />}
        title="Calls"
        description={
          live
            ? `${live} call${live === 1 ? "" : "s"} on the line right now. The transcript and summary arrive as soon as ${live === 1 ? "it ends" : "they end"}.`
            : "Calls your agents made and took: who they talked to, what came out of it, and every word."
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/settings/calls">
                <Settings2 /> Settings
              </Link>
            </Button>
            {newCall}
          </>
        }
      />
      <PageBody>
        {calls.isError && !calls.data ? (
          <QueryError error={calls.error} onRetry={() => calls.refetch()} title="Couldn't load your calls" />
        ) : calls.isPending ? (
          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <Skeleton className="h-80 rounded-xl" />
            <Skeleton className="h-[28rem] rounded-xl" />
          </div>
        ) : list.length === 0 && !wanted ? (
          <EmptyState
            icon={<Phone />}
            title="No calls yet"
            description={
              <>
                Agents can phone a business to book an appointment, follow up with a lead, or call you when a question can't wait. Your number answers too: each
                incoming call becomes a chat for an agent. It runs on ElevenLabs with a Twilio or SIP number.
              </>
            }
            action={
              phone?.enabled ? (
                <Button onClick={() => setDialog(true)}>
                  <Plus /> Place a call
                </Button>
              ) : (
                <Button asChild>
                  <Link to="/settings/calls">
                    <Settings2 /> Set up phone calls
                  </Link>
                </Button>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <CallList calls={list} selectedId={selected?.id ?? null} agents={agentById} onSelect={select} />
            {selected ? (
              <CallDetail key={selected.id} call={selected} agent={selected.agentId ? agentById.get(selected.agentId) : undefined} />
            ) : single.isError ? (
              <EmptyState icon={<Phone />} title="Couldn't open this call" description={errorMessage(single.error)} />
            ) : (
              <Skeleton className="h-[28rem] rounded-xl" />
            )}
          </div>
        )}
      </PageBody>

      <NewCallDialog open={dialog} onOpenChange={setDialog} onPlaced={(c) => select(c.id)} />
    </div>
  );
}

function CallList({ calls, selectedId, agents, onSelect }: { calls: PhoneCall[]; selectedId: string | null; agents: Map<string, Agent>; onSelect: (id: string) => void }) {
  return (
    <ul aria-label="Calls" className="divide-y overflow-hidden rounded-xl border bg-card shadow-card @4xl:sticky @4xl:top-6">
      {calls.map((c, i) => (
        <motion.li key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 10) * 0.025 } }}>
          <CallRow call={c} agent={c.agentId ? agents.get(c.agentId) : undefined} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
        </motion.li>
      ))}
    </ul>
  );
}

function CallRow({ call: c, agent, selected, onSelect }: { call: PhoneCall; agent?: Agent; selected: boolean; onSelect: () => void }) {
  const inbound = c.direction === "inbound";
  const DirectionIcon = inbound ? PhoneIncoming : PhoneOutgoing;
  const agentName = agent?.name ?? c.agentName;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative flex w-full items-start gap-3 px-4 py-3.5 text-left transition outline-none hover:bg-accent/35 focus-visible:bg-accent/40",
        selected && "bg-accent/50 hover:bg-accent/50",
      )}
    >
      {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-foreground/70" />}
      <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4", inbound ? "text-sky-600 dark:text-sky-400" : "text-brand-strong")}>
        <DirectionIcon aria-label={inbound ? "Incoming" : "Outgoing"} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium tracking-[-0.005em]">{callName(c)}</span>
          <time dateTime={c.createdAt} className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatDistanceToNowStrict(new Date(c.createdAt), { addSuffix: true })}
          </time>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{c.goal || (inbound ? "Incoming call" : "No goal given")}</span>
        <span className="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <CallStatusPill status={c.status} />
          {c.fromOwner && <OwnerCallBadge />}
          {c.durationSecs != null && <span className="tabular-nums">{formatCallTime(c.durationSecs)}</span>}
          {agentName && (
            <span className="flex min-w-0 items-center gap-1">
              {agent && <AgentAvatar agent={agent} size="sm" still className="size-4" />}
              <span className="truncate">{agentName}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function CallDetail({ call: c, agent }: { call: PhoneCall; agent?: Agent }) {
  const inbound = c.direction === "inbound";
  const active = isCallActive(c);
  const DirectionIcon = inbound ? PhoneIncoming : PhoneOutgoing;
  const agentName = agent?.name ?? c.agentName;
  return (
    <motion.article initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 pb-4">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-[18px]", inbound ? "text-sky-600 dark:text-sky-400" : "text-brand-strong")}>
            <DirectionIcon aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-lg leading-tight font-medium tracking-[-0.02em]">{callName(c)}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              {c.contactName && c.number && (
                <>
                  <span className="font-mono">{c.number}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{inbound ? "Incoming" : "Outgoing"}</span>
              <span aria-hidden>·</span>
              <time dateTime={c.createdAt}>{format(new Date(c.createdAt), "EEE, MMM d · HH:mm")}</time>
            </p>
          </div>
        </div>
        {c.conversationId && (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/chat/${c.conversationId}`}>
              <MessagesSquare /> Open chat
            </Link>
          </Button>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-px border-y bg-border @2xl:grid-cols-4">
        <Fact label="Status">
          <span className="flex flex-wrap items-center gap-1.5">
            <CallStatusPill status={c.status} />
            {c.fromOwner && <OwnerCallBadge />}
          </span>
        </Fact>
        <Fact label="Duration">{active && c.durationSecs == null ? <LiveTimer since={c.createdAt} /> : formatCallTime(c.durationSecs)}</Fact>
        <Fact label="Cost">{formatCost(c.costUsd)}</Fact>
        <Fact label="Agent">
          {agentName ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {agent && <AgentAvatar agent={agent} size="sm" still className="size-4" />}
              <span className="truncate">{agentName}</span>
            </span>
          ) : (
            "—"
          )}
        </Fact>
      </dl>

      <div className="space-y-6 px-5 py-5">
        {c.error && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-[13px] text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {c.error}
          </p>
        )}

        {c.goal && (
          <Block label={GOAL_LABEL[c.purpose]}>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.goal}</p>
          </Block>
        )}

        {c.outcome && <Outcome text={c.outcome} successful={c.successful} />}

        {c.purpose === "question" && c.answer && (
          <Block label="Your answer">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.answer}</p>
          </Block>
        )}

        {c.summary && (
          <Block label="Summary">
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/85">{c.summary}</p>
          </Block>
        )}

        {active && (
          <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-3.5 text-[13px] text-muted-foreground">
            <span className="relative flex size-2.5 shrink-0">
              <span className="absolute inset-0 animate-ping rounded-full bg-brand/50" />
              <span className="relative size-2.5 rounded-full bg-brand" />
            </span>
            {c.status === "processing"
              ? "The call ended. Godmode is writing the summary."
              : "The transcript, summary and recording show up here when the call ends."}
          </div>
        )}

        {c.hasAudio && <Recording id={c.id} />}

        {c.transcript.length > 0 && <Transcript call={c} />}
      </div>
    </motion.article>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-card px-5 py-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="eyebrow mb-1.5">{label}</h3>
      {children}
    </section>
  );
}

function Outcome({ text, successful }: { text: string; successful: boolean | null }) {
  const missed = successful === false;
  const Icon = successful === true ? CircleCheck : missed ? CircleX : Target;
  return (
    <section className={cn("rounded-lg border px-4 py-3.5", missed ? "border-warning/30 bg-warning/[0.07]" : "border-brand/25 bg-brand-soft/60")}>
      <h3 className={cn("eyebrow mb-1.5 flex items-center gap-1.5", missed ? "text-warning" : "text-brand-strong")}>
        <Icon className="size-3.5" aria-hidden />
        {missed ? "Outcome · goal not reached" : "Outcome"}
      </h3>
      <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{text}</p>
    </section>
  );
}

function LiveTimer({ since }: { since: string }) {
  const now = useNow(1000);
  return <span className="tabular-nums">{formatCallTime((now - new Date(since).getTime()) / 1000)}</span>;
}

function Recording({ id }: { id: string }) {
  const audio = useQuery({ queryKey: qk.callAudio(id), queryFn: () => api.calls.audio(id), staleTime: Infinity, gcTime: 10 * 60_000, retry: 1 });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!audio.data) return;
    const next = URL.createObjectURL(audio.data);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [audio.data]);

  return (
    <Block label="Recording">
      {audio.isError ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Couldn't load the recording: {errorMessage(audio.error)}
          <Button size="xs" variant="ghost" onClick={() => audio.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </p>
      ) : url ? (
        <audio controls preload="metadata" src={url} className="h-10 w-full" />
      ) : (
        <Skeleton className="h-10 w-full rounded-full" />
      )}
    </Block>
  );
}

function Transcript({ call: c }: { call: PhoneCall }) {
  const other = c.contactName || (c.direction === "inbound" ? "Caller" : "Them");
  return (
    <Block label="Transcript">
      <ol className="mt-3 space-y-1.5">
        {c.transcript.map((t, i) => {
          const mine = t.speaker === "agent";
          const first = i === 0 || c.transcript[i - 1]!.speaker !== t.speaker;
          return (
            <li key={i} className={cn("flex flex-col", mine ? "items-end" : "items-start", first && i > 0 && "pt-2.5")}>
              {first && <span className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">{mine ? "Godmode" : other}</span>}
              <div className={cn("flex max-w-[85%] items-end gap-2", mine && "flex-row-reverse")}>
                <p
                  className={cn(
                    "rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap",
                    mine ? "rounded-br-[6px] border border-foreground/[0.05] bg-secondary" : "rounded-bl-[6px] border bg-card",
                  )}
                >
                  {t.text}
                </p>
                <span className="pb-1 text-[10.5px] text-muted-foreground/70 tabular-nums">{formatCallTime(t.at)}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </Block>
  );
}
