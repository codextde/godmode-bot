import { useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import { Archive, ArchiveRestore, RefreshCw, Search, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Agent, Conversation } from "@godmode/shared";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { useArchiveChat, useDeleteChat } from "@/components/chat/chat-actions";
import { chatStatus } from "@/components/chat/chat-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/components/vault/use-debounced-value";
import { errorMessage } from "@/lib/api";
import { useAllAgents, useArchivedConversations } from "@/lib/hooks";
import { useLiveRunsMap } from "@/stores/live";
import { useUi } from "@/stores/ui";
import { dateLocale } from "@/i18n";
import { useLocale } from "@/i18n/language";

const LIMIT = 200;

function bucket(d: Date, now: Date, t: TFunction<["chat", "common"]>): string {
  if (isToday(d)) return t("common:words.today");
  if (isYesterday(d)) return t("common:words.yesterday");
  const days = differenceInCalendarDays(now, d);
  if (days < 7) return t("chat:archived.previous7");
  if (days < 30) return t("chat:archived.previous30");
  return format(d, d.getFullYear() === now.getFullYear() ? "MMMM" : "MMMM yyyy", { locale: dateLocale() });
}

export default function ArchivedPage() {
  const { t } = useTranslation(["chat", "common"]);
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const q = useDebouncedValue(search.trim());
  const scope = useUi((s) => s.workspace);
  const agentId = agentFilter === "all" ? undefined : agentFilter;
  const archived = useArchivedConversations(agentId, q, { limit: LIMIT, workspaceId: scope });
  // Archiving only files a chat: these still work, wait or come back on their own.
  const { data: ongoing = [] } = useArchivedConversations(agentId, q, { limit: LIMIT, workspaceId: scope, ongoing: true });
  const liveRuns = useLiveRunsMap();
  const live = (c: Conversation) => {
    const statuses = Object.values(liveRuns).flatMap((r) => (r.conversationId === c.id ? [r.status] : []));
    const queued = !statuses.includes("running") && statuses.includes("queued");
    return { running: statuses.includes("running") || (c.running && !queued), queued };
  };
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const { setArchived } = useArchiveChat();
  const { askDelete, deleteDialog } = useDeleteChat();

  const list = useMemo(() => archived.data ?? [], [archived.data]);
  // What comes next first: working or waiting for you, then by the time they continue.
  const going = useMemo(() => [...ongoing].sort((a, b) => continuesAt(a).localeCompare(continuesAt(b))), [ongoing]);
  const groups = useMemo(() => {
    const now = new Date();
    const shown = new Set(going.map((c) => c.id));
    const out: { label: string; items: Conversation[] }[] = [];
    for (const c of list) {
      if (shown.has(c.id)) continue;
      const label = bucket(new Date(c.lastMessageAt ?? c.createdAt), now, t);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [list, going, t]);

  const filtered = !!q || agentFilter !== "all";

  return (
    <>
      <PageHeader
        icon={<Archive />}
        title={t("archived.title")}
        description={t("archived.description")}
      />
      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("archived.searchPlaceholder")}
              aria-label={t("archived.searchLabel")}
              className="pl-9"
            />
          </div>
          {agents.length > 1 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-48" aria-label={t("archived.filterByAgent")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">{t("archived.allAgents")}</SelectItem>
                <SelectSeparator />
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {list.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {list.length >= LIMIT ? t("archived.countMax", { n: LIMIT }) : t("archived.count", { count: list.length })}
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
            title={t("archived.loadError")}
            description={errorMessage(archived.error)}
            action={
              <Button variant="outline" onClick={() => archived.refetch()}>
                <RefreshCw /> {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Archive />}
            title={filtered ? t("archived.noMatch") : t("archived.empty")}
            description={
              filtered
                ? q
                  ? t("archived.nothingFound", { query: q })
                  : undefined
                : t("archived.emptyHint")
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
                  {t("archived.clearFilters")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-6">
            {going.length > 0 && (
              <section aria-labelledby="archived-going">
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <h2 id="archived-going" className="eyebrow">
                    {t("archived.stillGoing")}
                  </h2>
                  <span className="text-xs text-muted-foreground">{t("archived.stillGoingHint")}</span>
                </div>
                <div className="space-y-0.5 rounded-xl border bg-card p-1.5 shadow-card">
                  <AnimatePresence initial={false}>
                    {going.map((c) => (
                      <ArchivedRow
                        key={c.id}
                        conversation={c}
                        agent={agentById.get(c.agentId)}
                        status={chatStatus(c, live(c))}
                        onRestore={() => setArchived(c, false)}
                        onDelete={() => askDelete(c)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            )}
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
                        onDelete={() => askDelete(c)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        )}
      </PageBody>

      {deleteDialog}
    </>
  );
}

/** When an archived chat goes on by itself; "" for one that works or waits for the human right now. */
function continuesAt(c: Conversation): string {
  if (c.paused) return (c.paused.auto && c.paused.resumeAt) || "";
  return c.running ? "" : (c.followup?.dueAt ?? "");
}

function ArchivedRow({
  conversation: c,
  agent,
  status,
  onRestore,
  onDelete,
}: {
  conversation: Conversation;
  agent?: Agent;
  /** What the chat still has ahead, instead of its last message. */
  status?: ReactNode;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { dateLocale: locale, intlLocale } = useLocale();
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
          <span className="block truncate text-sm font-medium tracking-[-0.01em]">{c.title || t("header.newChat")}</span>
          {status ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              <span className="shrink-0">{agent?.name ?? t("common:words.agent")} ·</span>
              <span className="min-w-0 truncate">{status}</span>
            </span>
          ) : (
            <span className="block truncate text-[13px] text-muted-foreground">
              {agent?.name ?? t("common:words.agent")}
              {c.preview && <span className="opacity-70"> · {c.preview}</span>}
            </span>
          )}
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
          title={when.toLocaleString(intlLocale)}
        >
          {formatDistanceToNowStrict(when, { addSuffix: true, locale })}
        </span>
      </Link>
      <div className="absolute inset-y-0 right-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="xs" variant="outline" className="bg-card" onClick={onRestore}>
          <ArchiveRestore /> {t("header.unarchive")}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={t("archived.deleteNamed", { title: c.title || t("header.newChat") })} onClick={onDelete} className="text-muted-foreground hover:text-destructive">
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("archived.deleteForever")}</TooltipContent>
        </Tooltip>
      </div>
    </motion.div>
  );
}
