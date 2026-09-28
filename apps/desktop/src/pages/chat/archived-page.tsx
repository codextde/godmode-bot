import { useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import { Archive, ArchiveRestore, RefreshCw, Search, Trash2 } from "lucide-react";
import type { Agent, Conversation } from "@godmode/shared";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { DeleteChatDialog, useArchiveChat } from "@/components/chat/chat-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/components/vault/use-debounced-value";
import { errorMessage } from "@/lib/api";
import { useAllAgents, useArchivedConversations } from "@/lib/hooks";

const LIMIT = 200;

function bucket(d: Date, now: Date): string {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  const days = differenceInCalendarDays(now, d);
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return format(d, d.getFullYear() === now.getFullYear() ? "MMMM" : "MMMM yyyy");
}

export default function ArchivedPage() {
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const q = useDebouncedValue(search.trim());
  const archived = useArchivedConversations(agentFilter === "all" ? undefined : agentFilter, q, { limit: LIMIT });
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const { setArchived } = useArchiveChat();
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const list = useMemo(() => archived.data ?? [], [archived.data]);
  const groups = useMemo(() => {
    const now = new Date();
    const out: { label: string; items: Conversation[] }[] = [];
    for (const c of list) {
      const label = bucket(new Date(c.lastMessageAt ?? c.createdAt), now);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [list]);

  const filtered = !!q || agentFilter !== "all";

  return (
    <>
      <PageHeader
        icon={<Archive />}
        title="Archived chats"
        description="Out of your sidebar, never deleted. Open one to read it — sending a message moves it back to Recent."
      />
      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles & messages…"
              aria-label="Search archived chats"
              className="pl-9"
            />
          </div>
          {agents.length > 1 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-48" aria-label="Filter by agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">All agents</SelectItem>
                <SelectSeparator />
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span>{a.avatar}</span> {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {list.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {list.length >= LIMIT ? `${LIMIT}+` : list.length} {list.length === 1 ? "chat" : "chats"}
            </span>
          )}
        </div>

        {archived.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : archived.isError ? (
          <EmptyState
            icon={<Archive />}
            title="Couldn't load archived chats"
            description={errorMessage(archived.error)}
            action={
              <Button variant="outline" onClick={() => archived.refetch()}>
                <RefreshCw /> Try again
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Archive />}
            title={filtered ? "No archived chats match" : "Nothing archived"}
            description={
              filtered
                ? q
                  ? `Nothing found for “${q}”.`
                  : undefined
                : "Hover a chat in the sidebar and press the archive icon to tidy up. It lands here, with every message intact."
            }
            action={
              filtered ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch("");
                    setAgentFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.label}>
                <h2 className="eyebrow mb-2 px-1">{g.label}</h2>
                <div className="space-y-0.5 rounded-xl border bg-card p-1.5 shadow-card">
                  <AnimatePresence initial={false}>
                    {g.items.map((c) => (
                      <ArchivedRow
                        key={c.id}
                        conversation={c}
                        agent={agentById.get(c.agentId)}
                        onRestore={() => setArchived(c, false)}
                        onDelete={() => {
                          setDeleting(c);
                          setConfirmDelete(true);
                        }}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        )}
      </PageBody>

      <DeleteChatDialog chat={deleting} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </>
  );
}

function ArchivedRow({
  conversation: c,
  agent,
  onRestore,
  onDelete,
}: {
  conversation: Conversation;
  agent?: Agent;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const when = new Date(c.lastMessageAt ?? c.createdAt);
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
      className="group relative overflow-hidden rounded-lg"
    >
      <Link
        to={`/chat/${c.id}`}
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition group-hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <AgentAvatar agent={agent ?? { avatar: "💬", color: "violet" }} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium tracking-[-0.01em]">{c.title || "New chat"}</span>
          <span className="block truncate text-[13px] text-muted-foreground">
            {agent?.name ?? "Agent"}
            {c.preview && <span className="opacity-70"> · {c.preview}</span>}
          </span>
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
          title={when.toLocaleString()}
        >
          {formatDistanceToNowStrict(when, { addSuffix: true })}
        </span>
      </Link>
      <div className="absolute inset-y-0 right-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="xs" variant="outline" className="bg-card" onClick={onRestore}>
          <ArchiveRestore /> Unarchive
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={`Delete “${c.title || "New chat"}”`} onClick={onDelete} className="text-muted-foreground hover:text-destructive">
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete forever</TooltipContent>
        </Tooltip>
      </div>
    </motion.div>
  );
}
