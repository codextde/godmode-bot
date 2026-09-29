import { useEffect, useState } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { Archive, ArchiveRestore, MessageSquare, MessagesSquare, Moon, Pin, Plug, Plus, Search, Share2, Workflow } from "lucide-react";
import type { Agent, Conversation, ConversationOrigin } from "@godmode/shared";
import { errorMessage } from "@/lib/api";
import { useArchivedConversations, useConversations } from "@/lib/hooks";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/common";
import { Orb } from "@/components/aicss/Orb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useArchiveChat } from "@/components/chat/chat-actions";
import { useStartAgentChat } from "../agent-actions";

const ORIGIN: Record<ConversationOrigin, { icon: typeof MessageSquare; label: string }> = {
  chat: { icon: MessageSquare, label: "Chat" },
  routine: { icon: Workflow, label: "Automation" },
  delegation: { icon: Share2, label: "Delegation" },
  api: { icon: Plug, label: "API" },
  dream: { icon: Moon, label: "Dreams" },
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
  const archived = useArchivedConversations(agent.id, q, { enabled: showArchived, limit: 100 });
  const chat = useStartAgentChat();
  const { setArchived } = useArchiveChat();
  const runningConversations = useLive((s) => Object.values(s.runs).map((r) => r.conversationId).join(","));

  const list = ((showArchived ? archived.data : active.data) ?? [])
    .filter((c) => showArchived || !c.archived)
    .sort(
      (a, b) =>
        (showArchived ? 0 : Number(b.pinned) - Number(a.pinned)) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
    );
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
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
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
        <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {list.map((c, i) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              index={i}
              running={!!c.running || runningConversations.split(",").includes(c.id)}
              onToggleArchive={() => setArchived(c, !c.archived)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  conversation: c,
  index,
  running,
  onToggleArchive,
}: {
  conversation: Conversation;
  index: number;
  running: boolean;
  onToggleArchive: () => void;
}) {
  const origin = ORIGIN[c.origin] ?? ORIGIN.chat;
  const Icon = origin.icon;
  const when = c.lastMessageAt ?? c.createdAt;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(index, 15) * 0.02 }} className="group relative">
      <Link
        to={`/chat/${c.id}`}
        className={cn(
          "flex items-center gap-3 px-4 py-3 transition group-hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
          running && "bg-brand-soft/40",
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-secondary text-foreground" title={origin.label}>
          {running ? <Orb variant="S3" size={14} label="Working…" /> : <Icon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium tracking-[-0.01em]">{c.title || "New chat"}</span>
            {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
            {c.archived && <Archive className="size-3 shrink-0 text-muted-foreground" aria-label="Archived" />}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {running ? <span className="text-shimmer font-medium">Working…</span> : c.preview || origin.label}
          </span>
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
          title={new Date(when).toLocaleString()}
        >
          {formatDistanceToNowStrict(new Date(when), { addSuffix: true })}
        </span>
      </Link>
      <div className="absolute inset-y-0 right-3 flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={c.archived ? "Unarchive chat" : "Archive chat"}
              onClick={onToggleArchive}
              className="bg-card text-muted-foreground hover:text-foreground"
            >
              {c.archived ? <ArchiveRestore /> : <Archive />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{c.archived ? "Unarchive" : "Archive"}</TooltipContent>
        </Tooltip>
      </div>
    </motion.div>
  );
}
