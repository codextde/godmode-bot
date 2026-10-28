import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { ChevronRight, Globe, MessageCircle, Plus, ShieldCheck } from "lucide-react";
import type { Agent, MessagingConnection, MessagingProvider } from "@godmode/shared";
import { MESSAGING_PROVIDERS } from "@godmode/shared";
import { AgentAvatar, PageBody, PageHeader } from "@/components/common";
import { QueryError } from "@/components/integrations/query-error";
import { ConnectDialog } from "@/components/messaging/connect-dialog";
import { ConnectionSheet, useUpdateConnection } from "@/components/messaging/connection-sheet";
import { botHandle, PLATFORMS, PlatformLogo, StatusPill } from "@/components/messaging/platform";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function useMessagingConnections() {
  return useQuery({ queryKey: qk.messagingList, queryFn: api.messaging.list });
}

export default function MessagingPage() {
  const [params, setParams] = useSearchParams();
  const connections = useMessagingConnections();
  const agents = useAllAgents();
  const list = connections.data ?? [];
  const openId = params.get("connection");
  const connectProvider = params.get("connect") as MessagingProvider | null;
  const open = list.find((c) => c.id === openId) ?? null;

  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("connection");
        next.delete("connect");
        if (value) next.set(key, value);
        return next;
      },
      { replace: true },
    );

  return (
    <div className="relative">
      <PageHeader
        icon={<MessageCircle />}
        title="Messaging"
        description="Talk to your agents from Slack, Telegram and Microsoft Teams — they answer right where you already chat."
      />
      <PageBody className="space-y-9">
        {connections.isError ? (
          <QueryError error={connections.error} onRetry={() => connections.refetch()} title="Couldn't load your bots" />
        ) : connections.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-[104px] rounded-xl" />
          </div>
        ) : (
          list.length > 0 && (
            <section className="space-y-3">
              <h2 className="eyebrow">Your bots</h2>
              <ul className="space-y-2">
                {list.map((c, i) => (
                  <motion.li key={c.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 10) * 0.03 } }}>
                    <ConnectionCard connection={c} agents={agents.data ?? []} onOpen={() => setParam("connection", c.id)} />
                  </motion.li>
                ))}
              </ul>
            </section>
          )
        )}

        <section className="space-y-3">
          <h2 className="eyebrow">{list.length ? "Add a platform" : "Platforms"}</h2>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
            {MESSAGING_PROVIDERS.map((p) => (
              <ProviderRow key={p} provider={p} connections={list.filter((c) => c.provider === p)} onConnect={() => setParam("connect", p)} />
            ))}
          </ul>
          <div className="grid gap-3 pt-2 text-xs text-muted-foreground @2xl:grid-cols-2">
            <p className="flex items-start gap-2.5">
              <ShieldCheck className="mt-px size-4 shrink-0 text-foreground/70" />
              Private by default: someone new writes, you approve them here. Tokens are sealed in your vault.
            </p>
            <p className="flex items-start gap-2.5">
              <Globe className="mt-px size-4 shrink-0 text-foreground/70" />
              Every chat becomes a Godmode conversation — read along in Chat, with the agent's memory and tools.
            </p>
          </div>
        </section>
      </PageBody>

      <ConnectDialog
        provider={connectProvider && MESSAGING_PROVIDERS.includes(connectProvider) ? connectProvider : null}
        onOpenChange={(o) => !o && setParam("connect", null)}
        onOpenConnection={(id) => setParam("connection", id)}
      />
      <ConnectionSheet connection={open} onOpenChange={(o) => !o && setParam("connection", null)} />
    </div>
  );
}

function ProviderRow({ provider, connections, onConnect }: { provider: MessagingProvider; connections: MessagingConnection[]; onConnect: () => void }) {
  const meta = PLATFORMS[provider];
  const status =
    connections.length === 0
      ? "Not connected"
      : connections.length === 1
        ? `Connected${botHandle(connections[0]!) ? ` · ${botHandle(connections[0]!)}` : ""}`
        : `${connections.length} bots connected`;
  return (
    <li>
      <button
        type="button"
        onClick={onConnect}
        className="group flex w-full items-center gap-4 px-4 py-4 text-left transition hover:bg-accent/35 focus-visible:bg-accent/40 focus-visible:outline-none @2xl:px-5"
      >
        <PlatformLogo provider={provider} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="text-[15px] font-medium tracking-[-0.01em]">{meta.label}</span>
            <span className={cn("text-xs", connections.length ? "text-brand-strong" : "text-muted-foreground")}>{status}</span>
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">{meta.blurb}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground transition group-hover:text-foreground">
          {connections.length ? <Plus className="size-4" /> : null}
          <span className="hidden @xl:inline">{connections.length ? "Add another" : "Connect"}</span>
          <ChevronRight className="size-4 transition group-hover:translate-x-0.5" />
        </span>
      </button>
    </li>
  );
}

function AgentStack({ agents }: { agents: Agent[] }) {
  const shown = agents.slice(0, 4);
  return (
    <span className="flex items-center">
      {shown.map((a, i) => (
        <AgentAvatar key={a.id} agent={a} size="sm" className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")} />
      ))}
      {agents.length > shown.length && <span className="ml-1.5 text-xs text-muted-foreground">+{agents.length - shown.length}</span>}
    </span>
  );
}

function ConnectionCard({ connection: c, agents, onOpen }: { connection: MessagingConnection; agents: Agent[]; onOpen: () => void }) {
  const update = useUpdateConnection();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const own = c.agentIds.map((id) => byId.get(id)).filter((a): a is Agent => !!a);
  const names = own.map((a) => a.name);
  const handle = botHandle(c);
  const last = c.status.lastEventAt ? formatDistanceToNowStrict(new Date(c.status.lastEventAt), { addSuffix: true }) : null;
  return (
    <div
      className={cn(
        "group relative flex items-center gap-4 rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float has-[button.card-open:focus-visible]:ring-[3px] has-[button.card-open:focus-visible]:ring-ring/50 @2xl:px-5",
        !c.enabled && "opacity-70",
      )}
    >
      <PlatformLogo provider={c.provider} size="lg" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <button type="button" onClick={onOpen} className="card-open truncate text-[15px] font-medium tracking-[-0.01em] outline-none after:absolute after:inset-0 after:rounded-xl">
            {c.name}
          </button>
          {handle && <span className="truncate text-xs text-muted-foreground">{handle}</span>}
          <StatusPill connection={c} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          {own.length > 0 && (
            <span className="flex min-w-0 items-center gap-2">
              <AgentStack agents={own} />
              <span className="truncate">{names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(" & ")}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            {c.access === "approved" ? <ShieldCheck className="size-3.5" /> : <Globe className="size-3.5" />}
            {c.access === "approved" ? "Approved people" : "Anyone"}
          </span>
          <span className="tabular-nums">
            {c.chats} {c.chats === 1 ? "chat" : "chats"}
            {last ? ` · last message ${last}` : ""}
          </span>
        </div>
        {c.status.state === "error" && c.status.message && <p className="line-clamp-1 text-xs text-destructive">{c.status.message}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {c.pendingUsers > 0 && (
          <span className="relative z-10 inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-strong">
            <span className="size-1.5 rounded-full bg-brand" />
            {c.pendingUsers} waiting
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="relative z-10 inline-flex">
              <Switch checked={c.enabled} onCheckedChange={(enabled) => update.mutate({ id: c.id, patch: { enabled } })} aria-label={`${c.enabled ? "Turn off" : "Turn on"} ${c.name}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{c.enabled ? "Answering messages" : "Turned off"}</TooltipContent>
        </Tooltip>
        <ChevronRight className="size-4 text-muted-foreground/60 transition group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>
    </div>
  );
}

