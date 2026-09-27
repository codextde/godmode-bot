import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { Archive, CalendarClock, MessageSquare, MessagesSquare, Pin, Plug, Plus, Search, Share2 } from "lucide-react";
import type { Agent, Conversation, ConversationOrigin } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useConversations } from "@/lib/hooks";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useStartAgentChat } from "../agent-actions";

const ORIGIN: Record<ConversationOrigin, { icon: typeof MessageSquare; label: string }> = {
  chat: { icon: MessageSquare, label: "Chat" },
  routine: { icon: CalendarClock, label: "Routine" },
  delegation: { icon: Share2, label: "Delegation" },
  api: { icon: Plug, label: "API" },
};

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function ChatsTab({ agent }: { agent: Agent }) {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const q = useDebounced(search.trim());
  const active = useConversations(agent.id, q);
  const archived = useQuery({
    queryKey: [...qk.conversations(agent.id, q), "archived"],
    queryFn: () => api.conversations.list({ agentId: agent.id, search: q, limit: 100, archived: true }),
    enabled: showArchived,
  });
  const chat = useStartAgentChat();
  const runningConversations = useLive((s) => Object.values(s.runs).map((r) => r.conversationId).join(","));

  const list = ((showArchived ? archived.data : active.data) ?? [])
    .filter((c) => showArchived || !c.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  const query = showArchived ? archived : active;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${agent.name}'s chats…`}
            aria-label="Search conversations"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="show-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="show-archived" className="text-sm font-normal text-muted-foreground">
            Archived
          </Label>
        </div>
        <Button className="ml-auto" onClick={() => chat.mutate(agent.id)} disabled={chat.isPending}>
          {chat.isPending ? <Spinner /> : <Plus />} New chat
        </Button>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState icon={<MessagesSquare />} title="Couldn't load conversations" description={errorMessage(query.error)} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={showArchived ? <Archive /> : <MessagesSquare />}
          title={q ? "No conversations match" : showArchived ? "No archived conversations" : `No chats with ${agent.name} yet`}
          description={q ? `Nothing found for “${q}”.` : showArchived ? undefined : "Start one — it keeps the context across messages."}
          action={
            !q && !showArchived ? (
              <Button onClick={() => chat.mutate(agent.id)} disabled={chat.isPending}>
                <Plus /> New chat
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="glass divide-y divide-border/60 overflow-hidden rounded-2xl">
          {list.map((c, i) => (
            <ConversationRow key={c.id} conversation={c} index={i} running={!!c.running || runningConversations.split(",").includes(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationRow({ conversation: c, index, running }: { conversation: Conversation; index: number; running: boolean }) {
  const origin = ORIGIN[c.origin] ?? ORIGIN.chat;
  const Icon = origin.icon;
  const when = c.lastMessageAt ?? c.createdAt;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(index, 15) * 0.02 }}>
      <Link
        to={`/chat/${c.id}`}
        className={cn(
          "flex items-center gap-3 px-4 py-3 transition hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
          running && "bg-primary/5",
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/50 text-muted-foreground" title={origin.label}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{c.title || "New chat"}</span>
            {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
            {c.archived && <Archive className="size-3 shrink-0 text-muted-foreground" aria-label="Archived" />}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {running ? <span className="text-shimmer font-medium">Working…</span> : c.preview || origin.label}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground" title={new Date(when).toLocaleString()}>
          {formatDistanceToNowStrict(new Date(when), { addSuffix: true })}
        </span>
      </Link>
    </motion.div>
  );
}
