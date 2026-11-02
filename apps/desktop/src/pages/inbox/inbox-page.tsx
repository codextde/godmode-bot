import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Archive, CircleCheck, Inbox, List, PartyPopper, Plus, RefreshCw, Search, SearchX, SquareKanban } from "lucide-react";
import type { Agent, AttentionItem, HumanTask, MissingLogin, MissingLoginStatus, Workspace } from "@godmode/shared";
import { MASCOT_CHARACTER, MASCOT_COLOR, isHumanTaskWaiting } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { Character } from "@/components/character";
import { ClosedLoginRow, InboxSections, useOpenAttention } from "@/components/inbox/inbox-list";
import { INBOX_SECTIONS, loginIdOf, matchesSearch, sectionOf, type InboxFilter } from "@/components/inbox/inbox-model";
import { MissingLoginCard, addLoginPath, useMissingLoginStatus } from "@/components/inbox/missing-login-card";
import { NotificationList } from "@/components/inbox/notification-list";
import { InboxQuestion } from "@/components/inbox/question-item";
import { TicketSheet } from "@/components/inbox/ticket-sheet";
import { domainFromUrl, isVaultLocked } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents, useAttention, useHumanTasks, useMissingLogins, useQuestions, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi, type InboxView } from "@/stores/ui";
import { useScopedAttention } from "@/components/workspaces/workspace-activity";
import { ATTENTION_ICON } from "@/components/attention/attention-list";
import { HumanTaskBoard } from "@/components/human-tasks/human-task-board";
import { HumanTaskSheet } from "@/components/human-tasks/human-task-sheet";
import { shortAge } from "@/components/human-tasks/human-task-card";
import { DirectionHint } from "@/components/layout/direction-hint";

const EMPTY: Record<MissingLoginStatus, { icon: React.ReactNode }> = {
  open: { icon: <PartyPopper /> },
  resolved: { icon: <CircleCheck /> },
  dismissed: { icon: <Archive /> },
};

const VIEWS = [
  { id: "list", labelKey: "views.list", icon: List },
  { id: "board", labelKey: "views.board", icon: SquareKanban },
] as const;

const CLOSED_PAGE = 30;

/** Everything that waits for the human in one place: as a list to work through, and the same things as a board to plan with. */
export default function InboxPage() {
  const { t } = useTranslation("inbox");
  const [params, setParams] = useSearchParams();
  const storedView = useUi((s) => s.inboxView);
  const setStoredView = useUi((s) => s.setInboxView);
  const setWorkspace = useUi((s) => s.setWorkspace);
  const asked = params.get("view");
  const view: InboxView = asked === "board" || asked === "list" ? asked : storedView;
  const [adding, setAdding] = useState<"backlog" | "open" | null>(null);
  const [focusNote, setFocusNote] = useState(false);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<MissingLoginStatus>("open");
  const [sheetItem, setSheetItem] = useState<string | null>(null);
  const [sheetLinks2fa, setSheetLinks2fa] = useState(false);
  const navigate = useNavigate();
  const humanTasks = useHumanTasks();
  const { data: agents = [] } = useAllAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const agentById = useMemo(() => new Map<string, Agent>(agents.map((a) => [a.id, a])), [agents]);
  const workspaceById = useMemo(() => new Map<string, Workspace>(workspaces.map((w) => [w.id, w])), [workspaces]);
  const attention = useAttention();
  const { items: scoped, elsewhere, workspaceOf, inScope } = useScopedAttention();
  const openLogins = useMissingLogins("open");
  const loginById = useMemo(() => new Map<string, MissingLogin>((openLogins.data ?? []).map((m) => [m.id, m])), [openLogins.data]);
  const setLoginStatus = useMissingLoginStatus("open");

  const editParam = (edit: (next: URLSearchParams) => void) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        edit(next);
        return next;
      },
      { replace: true },
    );
  const setView = (v: InboxView) => {
    setStoredView(v);
    editParam((next) => next.delete("view"));
  };
  const openTask = (t: HumanTask, note = false) => {
    setFocusNote(note);
    editParam((next) => next.set("task", t.id));
  };
  const closeTask = () => {
    setFocusNote(false);
    editParam((next) => next.delete("task"));
  };
  const openId = params.get("task");
  const selected = openId ? (humanTasks.data?.find((t) => t.id === openId) ?? null) : null;
  const ticketId = params.get("ticket");
  const link2fa = params.get("link2fa")?.toLowerCase() ?? "";

  const openItem = useOpenAttention({
    todo: (item) => openTask(item.humanTask!),
    ticket: (item) => editParam((next) => next.set("ticket", item.task!.id)),
    sheet: (item) => {
      // The vault is locked or the report just left: its card can't show, the work it stopped can.
      if (item.kind === "login" && !loginById.get(loginIdOf(item) ?? "")) void navigate(item.link);
      else {
        setSheetLinks2fa(false);
        setSheetItem(item.id);
      }
    },
  });
  const actOn = (item: AttentionItem) => {
    const login = loginById.get(loginIdOf(item) ?? "");
    if (!login) return openItem(item);
    if (login.kind !== "missing_totp") return void navigate(addLoginPath(login));
    setSheetLinks2fa(true);
    setSheetItem(item.id);
  };

  const query = search.trim().toLowerCase();
  const agentName = (item: AttentionItem) => (item.agentId ? (agentById.get(item.agentId)?.name ?? "") : "");
  const loginOf = (item: AttentionItem) => loginById.get(loginIdOf(item) ?? "");
  const searched = scoped.filter((i) => matchesSearch(i, query, agentName(i), loginOf(i)));
  const visible = filter === "all" ? searched : searched.filter((i) => sectionOf(i.kind) === filter);
  const workspaceOfRow = workspaces.length ? (item: AttentionItem) => workspaceById.get(workspaceOf(item) ?? "") : undefined;

  const onBoard = new Set((humanTasks.data ?? []).map((h) => h.questionId).filter(Boolean));
  // A to-do and a question with a card of its own are already on the board, as what they are.
  const boardCards = visible.filter((i) => i.kind !== "todo" && !(i.kind === "question" && onBoard.has(i.question?.id ?? "")));

  const humanFilter = (h: HumanTask) => {
    if ((h.agentId || h.runId) && !inScope({ agentId: h.agentId, conversationId: h.conversationId })) return false;
    if (filter !== "all" && filter !== (h.questionId ? "question" : "todo")) return false;
    return !query || `H-${h.number} ${h.title} ${h.body} ${h.agentName ?? ""} ${h.conversationTitle ?? ""}`.toLowerCase().includes(query);
  };

  const counts = new Map<InboxFilter, number>();
  for (const i of searched) counts.set(sectionOf(i.kind), (counts.get(sectionOf(i.kind)) ?? 0) + 1);
  const sheet = sheetItem ? (attention.data?.find((i) => i.id === sheetItem) ?? null) : null;
  const linkLogin = link2fa ? openLogins.data?.find((m) => m.status === "open" && (domainFromUrl(m.url) === link2fa || m.service.toLowerCase() === link2fa)) : undefined;
  const clearFilters = () => {
    setFilter("all");
    setSearch("");
  };

  return (
    <div className={view === "board" ? "flex h-full min-h-0 flex-col" : "relative"}>
      <InboxHeader
        view={view}
        onView={setView}
        items={scoped}
        elsewhere={elsewhere}
        onShowAll={() => setWorkspace("all")}
        onNewTask={() => {
          setView("board");
          setAdding("open");
        }}
      />
      <DirectionHint direction="to-you" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-4 @2xl:px-8">
        {(view === "board" || tab === "open") && <FilterChips value={filter} onChange={setFilter} total={searched.length} counts={counts} />}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-52">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("toolbar.search")} className="h-8 pl-8 text-[13px]" aria-label={t("toolbar.search")} />
          </div>
          {view === "list" && <StatusTabs tab={tab} onTab={setTab} openCount={scoped.length} />}
        </div>
      </div>
      {view === "board" ? (
        <HumanTaskBoard
          adding={adding}
          onAdding={setAdding}
          onOpen={openTask}
          matches={humanFilter}
          attention={boardCards}
          loginById={loginById}
          workspaceOf={workspaceOfRow}
          onOpenAttention={openItem}
          onClearFilters={filter !== "all" || query ? clearFilters : undefined}
        />
      ) : (
        <InboxList
          tab={tab}
          loading={attention.isLoading}
          items={visible}
          anyOpen={scoped.length > 0}
          query={query}
          agentById={agentById}
          loginById={loginById}
          workspaceOf={workspaceOfRow}
          onOpen={openItem}
          onAct={actOn}
          onLoginStatus={(login, status) => setLoginStatus.mutate({ id: login.id, status })}
          onClearFilters={clearFilters}
        />
      )}
      <HumanTaskSheet task={selected} agent={selected?.agentId ? agentById.get(selected.agentId) : undefined} focusNote={focusNote} onClose={closeTask} />
      <TicketSheet taskId={ticketId} agents={agents} workspaces={workspaceById} onClose={() => editParam((next) => next.delete("ticket"))} />
      <ItemSheet
        item={sheet}
        login={sheet ? loginOf(sheet) : linkLogin}
        autoOpenLink={sheet ? sheetLinks2fa : !!linkLogin}
        agentById={agentById}
        onClose={() => {
          setSheetItem(null);
          if (link2fa) editParam((next) => next.delete("link2fa"));
        }}
      />
    </div>
  );
}

/** A question or a login from a row or card, answered in place: the full card in a side panel. */
function ItemSheet({ item, login, autoOpenLink, agentById, onClose }: { item: AttentionItem | null; login?: MissingLogin; autoOpenLink: boolean; agentById: Map<string, Agent>; onClose: () => void }) {
  const { t } = useTranslation("inbox");
  const status = useMissingLoginStatus("open");
  const question = item?.question;
  const open = !!question || !!login;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" aria-describedby={undefined} className="w-full gap-0 overflow-y-auto p-4 sm:max-w-[34rem]">
        <SheetTitle className="mb-3 pr-8 text-sm font-medium">{question ? t("kinds.question") : t("kinds.login")}</SheetTitle>
        {question ? (
          <InboxQuestion question={question} agent={agentById.get(question.agentId)} />
        ) : login ? (
          <MissingLoginCard
            item={login}
            agent={login.agentId ? agentById.get(login.agentId) : undefined}
            onStatus={(s) => {
              status.mutate({ id: login.id, status: s });
              onClose();
            }}
            pending={status.isPending}
            autoOpenLink={autoOpenLink}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function FilterChips({ value, onChange, total, counts }: { value: InboxFilter; onChange: (f: InboxFilter) => void; total: number; counts: Map<InboxFilter, number> }) {
  const { t } = useTranslation("inbox");
  const present = INBOX_SECTIONS.filter((s) => counts.has(s.id) || value === s.id);
  if (!present.length) return null;
  return (
    <div role="group" aria-label={t("toolbar.filterLabel")} className="flex flex-wrap items-center gap-1.5">
      <Chip active={value === "all"} label={t("toolbar.all")} count={total} onClick={() => onChange("all")} />
      {present.map((s) => {
        const Icon = ATTENTION_ICON[s.kinds[0]!];
        return <Chip key={s.id} active={value === s.id} icon={<Icon aria-hidden />} label={t(`toolbar.${s.id}`)} count={counts.get(s.id) ?? 0} onClick={() => onChange(value === s.id ? "all" : s.id)} />;
      })}
    </div>
  );
}

function Chip({ active, icon, label, count, onClick }: { active: boolean; icon?: React.ReactNode; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5",
        active ? "border-foreground/30 bg-foreground/[0.07] text-foreground" : "border-border/80 text-muted-foreground hover:border-foreground/20 hover:text-foreground",
      )}
    >
      {icon}
      {label}
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

function InboxHeader({
  view,
  onView,
  items,
  elsewhere,
  onShowAll,
  onNewTask,
}: {
  view: InboxView;
  onView: (v: InboxView) => void;
  items: AttentionItem[];
  elsewhere: number;
  onShowAll: () => void;
  onNewTask: () => void;
}) {
  const { t } = useTranslation("inbox");
  const agentsHeld = new Set(items.filter((i) => i.agentId && (i.kind === "question" || i.kind === "paused" || i.kind === "login" || (i.kind === "todo" && i.humanTask && isHumanTaskWaiting(i.humanTask)))).map((i) => i.agentId)).size;
  const oldest = items.reduce<string | null>((min, i) => (!min || i.since < min ? i.since : min), null);
  const facts = items.length
    ? [t("header.summary", { count: items.length }), agentsHeld ? t("header.onHold", { count: agentsHeld }) : null, oldest ? t("header.oldest", { age: shortAge(oldest) }) : null].filter(Boolean).join(" · ")
    : t("header.description");
  return (
    <PageHeader
      icon={<Inbox />}
      title={t("header.title")}
      description={
        <>
          {facts}
          {elsewhere > 0 && (
            <>
              {" · "}
              <button type="button" onClick={onShowAll} className="text-foreground underline-offset-2 hover:underline">
                {t("header.elsewhere", { count: elsewhere })}
              </button>
            </>
          )}
        </>
      }
      actions={
        <>
          <div role="group" aria-label={t("views.label")} className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                onClick={() => onView(v.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5",
                  view === v.id ? "border bg-card text-foreground shadow-card" : "border border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <v.icon aria-hidden /> {t(v.labelKey)}
              </button>
            ))}
          </div>
          <Button onClick={onNewTask}>
            <Plus /> {t("header.newTodo")}
          </Button>
        </>
      }
    />
  );
}

function StatusTabs({ tab, onTab, openCount }: { tab: MissingLoginStatus; onTab: (s: MissingLoginStatus) => void; openCount: number }) {
  const { t } = useTranslation("inbox");
  const counts: Record<MissingLoginStatus, number | undefined> = {
    open: openCount,
    resolved: useClosedCount("resolved"),
    dismissed: useClosedCount("dismissed"),
  };
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as MissingLoginStatus)}>
      <TabsList>
        {(["open", "resolved", "dismissed"] as const).map((s) => (
          <TabsTrigger key={s} value={s} className="gap-1.5 px-2.5 text-[13px] capitalize">
            {t(`tabs.${s}`)}
            {!!counts[s] && <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{counts[s]}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

const CLOSED_QUESTIONS = { resolved: "resolved", dismissed: "withdrawn" } as const;

function useClosedCount(status: "resolved" | "dismissed") {
  const logins = useMissingLogins(status).data?.length;
  const questions = useQuestions(CLOSED_QUESTIONS[status]).data?.length;
  return logins === undefined && questions === undefined ? undefined : (logins ?? 0) + (questions ?? 0);
}

function InboxList({
  tab,
  loading,
  items,
  anyOpen,
  query,
  agentById,
  loginById,
  workspaceOf,
  onOpen,
  onAct,
  onLoginStatus,
  onClearFilters,
}: {
  tab: MissingLoginStatus;
  loading: boolean;
  items: AttentionItem[];
  anyOpen: boolean;
  query: string;
  agentById: Map<string, Agent>;
  loginById: Map<string, MissingLogin>;
  workspaceOf?: (item: AttentionItem) => Workspace | undefined;
  onOpen: (item: AttentionItem) => void;
  onAct: (item: AttentionItem) => void;
  onLoginStatus: (login: MissingLogin, status: "resolved" | "dismissed") => void;
  onClearFilters: () => void;
}) {
  const { t } = useTranslation("inbox");
  const notifications = useQuery({ queryKey: qk.notifications, queryFn: api.notifications.list });
  const rail = !!notifications.data?.length || notifications.isError;
  return (
    <PageBody>
      <div className={cn("grid grid-cols-1 items-start gap-6", rail && "@5xl:grid-cols-[minmax(0,1fr)_340px]")}>
        <div className="min-w-0">
          {tab !== "open" ? (
            <ClosedList status={tab} query={query} agentById={agentById} />
          ) : loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : items.length ? (
            <InboxSections items={items} agentById={agentById} loginById={loginById} workspaceOf={workspaceOf} onOpen={onOpen} onAct={onAct} onLoginStatus={onLoginStatus} />
          ) : anyOpen ? (
            <EmptyState
              icon={<SearchX />}
              title={t("noMatch.title")}
              description={t("noMatch.description")}
              action={
                <Button variant="outline" onClick={onClearFilters}>
                  {t("noMatch.clear")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={EMPTY.open.icon}
              art={<Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={64} follow />}
              title={t("empty.open.title")}
              description={t("empty.open.description")}
              className="border-success/30 bg-success/[0.03]"
            />
          )}
        </div>
        {rail && <NotificationList className="@5xl:sticky @5xl:top-6" />}
      </div>
    </PageBody>
  );
}

/** Resolved and dismissed: what was handled, for reference, newest first. */
function ClosedList({ status, query, agentById }: { status: "resolved" | "dismissed"; query: string; agentById: Map<string, Agent> }) {
  const { t } = useTranslation(["inbox", "common"]);
  const logins = useMissingLogins(status);
  const questions = useQuestions(CLOSED_QUESTIONS[status]);
  const update = useMissingLoginStatus(status);
  const [limit, setLimit] = useState(CLOSED_PAGE);
  const [openLogin, setOpenLogin] = useState<string | null>(null);
  const entries = useMemo(
    () =>
      [
        ...(logins.data ?? []).filter((m) => !query || `${m.service} ${m.reason} ${m.url}`.toLowerCase().includes(query)).map((item) => ({ kind: "login" as const, item, at: item.updatedAt })),
        ...(questions.data ?? []).filter((q) => !query || q.title.toLowerCase().includes(query)).map((item) => ({ kind: "question" as const, item, at: item.answer?.at ?? item.updatedAt })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [logins.data, questions.data, query],
  );
  const selected = logins.data?.find((m) => m.id === openLogin);

  if (logins.isLoading && questions.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }
  if (logins.isError && !questions.data?.length) {
    return (
      <EmptyState
        icon={<Inbox />}
        title={isVaultLocked(logins.error) ? t("list.vaultLocked") : t("list.loadError")}
        description={errorMessage(logins.error)}
        action={
          <Button variant="outline" onClick={() => logins.refetch()}>
            <RefreshCw /> {t("common:actions.tryAgain")}
          </Button>
        }
      />
    );
  }
  if (!entries.length) return <EmptyState key={status} icon={EMPTY[status].icon} title={t(`empty.${status}.title`)} description={t(`empty.${status}.description`)} />;
  const rest = entries.length - limit;
  return (
    <div className="space-y-3">
      {entries.slice(0, limit).map((e) =>
        e.kind === "question" ? (
          <InboxQuestion key={e.item.id} question={e.item} agent={agentById.get(e.item.agentId)} />
        ) : (
          <div key={e.item.id} className="overflow-hidden rounded-xl border bg-card shadow-card">
            <ClosedLoginRow
              login={e.item}
              agent={e.item.agentId ? agentById.get(e.item.agentId) : undefined}
              pending={update.isPending && update.variables?.id === e.item.id}
              onReopen={() => update.mutate({ id: e.item.id, status: "open" })}
              onOpen={() => setOpenLogin(e.item.id)}
            />
          </div>
        ),
      )}
      {rest > 0 && (
        <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setLimit((l) => l + CLOSED_PAGE)}>
          {t("showMore", { count: Math.min(CLOSED_PAGE, rest) })}
        </Button>
      )}
      <Sheet open={!!selected} onOpenChange={(o) => !o && setOpenLogin(null)}>
        <SheetContent side="right" aria-describedby={undefined} className="w-full gap-0 overflow-y-auto p-4 sm:max-w-[34rem]">
          <SheetTitle className="mb-3 pr-8 text-sm font-medium">{t("kinds.login")}</SheetTitle>
          {selected && (
            <MissingLoginCard
              item={selected}
              agent={selected.agentId ? agentById.get(selected.agentId) : undefined}
              onStatus={(s) => {
                update.mutate({ id: selected.id, status: s });
                setOpenLogin(null);
              }}
              pending={update.isPending}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
