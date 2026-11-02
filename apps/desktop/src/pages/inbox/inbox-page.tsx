import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Archive, CircleCheck, Inbox, List, PartyPopper, Plus, RefreshCw, SquareKanban } from "lucide-react";
import type { Agent, AgentQuestion, AttentionKind, HumanTask, MissingLogin, MissingLoginStatus } from "@godmode/shared";
import { ATTENTION_KINDS, MASCOT_CHARACTER, MASCOT_COLOR, isHumanTaskWaiting } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { Character } from "@/components/character";
import { MissingLoginCard, useMissingLoginStatus } from "@/components/inbox/missing-login-card";
import { NotificationList } from "@/components/inbox/notification-list";
import { InboxQuestion } from "@/components/inbox/question-item";
import { domainFromUrl, isVaultLocked } from "@/components/vault/vault-utils";
import { errorMessage } from "@/lib/api";
import { useAllAgents, useAttention, useHumanTasks, useMissingLogins, useQuestions, useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useUi, type InboxView } from "@/stores/ui";
import { useScopedAttention } from "@/components/workspaces/workspace-activity";
import { ATTENTION_ICON, AttentionList } from "@/components/attention/attention-list";
import { HumanTaskBoard } from "@/components/human-tasks/human-task-board";
import { HumanTaskSheet } from "@/components/human-tasks/human-task-sheet";
import { DirectionHint } from "@/components/layout/direction-hint";
import { useReduceAnimations } from "@/lib/motion";

type Entry = { kind: "login"; item: MissingLogin; at: number } | { kind: "question"; item: AgentQuestion; at: number };

const EMPTY: Record<MissingLoginStatus, { icon: React.ReactNode }> = {
  open: { icon: <PartyPopper /> },
  resolved: { icon: <CircleCheck /> },
  dismissed: { icon: <Archive /> },
};

const VIEWS = [
  { id: "list", labelKey: "views.list", icon: List },
  { id: "board", labelKey: "views.board", icon: SquareKanban },
] as const;

/** Everything that waits for the human in one place: the list to work through, and the same to-dos as a board to plan with. */
export default function InboxPage() {
  const { t } = useTranslation("inbox");
  const [params, setParams] = useSearchParams();
  const storedView = useUi((s) => s.inboxView);
  const setStoredView = useUi((s) => s.setInboxView);
  const asked = params.get("view");
  const view: InboxView = asked === "board" || asked === "list" ? asked : storedView;
  const [adding, setAdding] = useState<"backlog" | "open" | null>(null);
  const [focusNote, setFocusNote] = useState(false);
  const humanTasks = useHumanTasks();
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map<string, Agent>(agents.map((a) => [a.id, a])), [agents]);

  const setView = (v: InboxView) => {
    setStoredView(v);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("view");
        return next;
      },
      { replace: true },
    );
  };
  const openTask = (t: HumanTask, note = false) => {
    setFocusNote(note);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("task", t.id);
        return next;
      },
      { replace: true },
    );
  };
  const closeTask = () => {
    setFocusNote(false);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("task");
        return next;
      },
      { replace: true },
    );
  };
  const openId = params.get("task");
  const selected = openId ? (humanTasks.data?.find((t) => t.id === openId) ?? null) : null;

  const tasks = humanTasks.data ?? [];
  const waiting = tasks.filter((t) => t.status === "open").length;
  const agentsWaiting = new Set(tasks.filter((t) => isHumanTaskWaiting(t) && t.agentId).map((t) => t.agentId)).size;
  const parked = tasks.filter((t) => t.status === "backlog").length;
  const boardDescription = waiting
    ? t("board.waiting", {
        facts: [
          t("board.toDo", { count: waiting }),
          agentsWaiting ? t("board.onHold", { count: agentsWaiting }) : null,
          parked ? t("board.inBacklog", { count: parked }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })
    : parked
      ? t("board.onlyBacklog", { count: parked })
      : t("board.empty");

  return (
    <div className={view === "board" ? "flex h-full min-h-0 flex-col" : "relative"}>
      <InboxHeader
        view={view}
        onView={setView}
        description={view === "board" ? boardDescription : undefined}
        onNewTask={() => {
          setView("board");
          setAdding("open");
        }}
      />
      <DirectionHint direction="to-you" />
      {view === "board" && <OffBoard tasks={tasks} onShow={() => setView("list")} />}
      {view === "board" ? <HumanTaskBoard adding={adding} onAdding={setAdding} onOpen={openTask} /> : <InboxList agentById={agentById} />}
      <HumanTaskSheet task={selected} agent={selected?.agentId ? agentById.get(selected.agentId) : undefined} focusNote={focusNote} onClose={closeTask} />
    </div>
  );
}

/** What the sidebar's count includes but the board has no card for (logins, tickets, chats), so the two always add up. */
function OffBoard({ tasks, onShow }: { tasks: HumanTask[]; onShow: () => void }) {
  const { t } = useTranslation("inbox");
  const attention = useAttention();
  const onBoard = new Set(tasks.map((h) => h.questionId).filter(Boolean));
  const counts = new Map<AttentionKind, number>();
  for (const i of attention.data ?? []) {
    if (i.kind === "todo" || (i.kind === "question" && onBoard.has(i.question?.id ?? ""))) continue;
    counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return (
    <div className="px-5 @2xl:px-8">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card/60 py-2 pr-2 pl-3 text-sm">
        <span className="text-muted-foreground">{t("board.offBoard.lead")}</span>
        {ATTENTION_KINDS.filter((k): k is Exclude<AttentionKind, "todo"> => k !== "todo" && counts.has(k)).map((k) => {
          const Icon = ATTENTION_ICON[k];
          return (
            <span key={k} className="inline-flex items-center gap-1.5 text-foreground">
              <Icon aria-hidden className="size-3.5 text-warning" />
              {t(`board.offBoard.${k}`, { count: counts.get(k) })}
            </span>
          );
        })}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onShow}>
          <List /> {t("board.offBoard.show")}
        </Button>
      </div>
    </div>
  );
}

function InboxHeader({ view, onView, description, onNewTask }: { view: InboxView; onView: (v: InboxView) => void; description?: string; onNewTask: () => void }) {
  const { t } = useTranslation("inbox");
  const attention = useAttention();
  const openCount = attention.data?.length ?? 0;
  return (
    <PageHeader
      icon={<Inbox />}
      title={t("header.title")}
      description={
        description ??
        (openCount > 0
          ? t("header.descriptionCount", { count: openCount })
          : t("header.description"))
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

function InboxList({ agentById }: { agentById: Map<string, Agent> }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["inbox", "common"]);
  const [tab, setTab] = useState<MissingLoginStatus>("open");
  const open = useMissingLogins("open");
  const resolved = useMissingLogins("resolved");
  const dismissed = useMissingLogins("dismissed");
  const byStatus = { open, resolved, dismissed };
  const current = byStatus[tab];
  // Questions: answered ones count as resolved, withdrawn ones as dismissed.
  const qOpen = useQuestions("open");
  const qResolved = useQuestions("resolved");
  const qWithdrawn = useQuestions("withdrawn");
  const questionsBy = { open: qOpen, resolved: qResolved, dismissed: qWithdrawn };
  const currentQuestions = questionsBy[tab];

  const update = useMissingLoginStatus(tab);
  const [params] = useSearchParams();
  const link2fa = params.get("link2fa")?.toLowerCase() ?? "";

  const items = useMemo<Entry[]>(
    () =>
      [
        ...(current.data ?? []).map((item): Entry => ({ kind: "login", item, at: new Date(item.updatedAt).getTime() })),
        ...(currentQuestions.data ?? []).map((item): Entry => ({ kind: "question", item, at: new Date(item.answer?.at ?? item.updatedAt).getTime() })),
      ].sort((a, b) => b.at - a.at),
    [current.data, currentQuestions.data],
  );
  // The rest of what waits (tickets, paused chats, failures, people): questions and logins have their cards below.
  const attention = useAttention();
  const { workspaceOf } = useScopedAttention();
  const { data: workspaces = [] } = useWorkspaces();
  const others = (attention.data ?? []).filter((i) => i.kind !== "question" && i.kind !== "login");
  const count = (s: MissingLoginStatus) => {
    const logins = byStatus[s].data?.length;
    const questions = questionsBy[s].data?.length;
    if (logins === undefined && questions === undefined) return undefined;
    return (logins ?? 0) + (questions ?? 0) + (s === "open" ? others.length : 0);
  };

  return (
    <PageBody>
        <div className="grid grid-cols-1 items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="attention-title" className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="attention-title" className="eyebrow">
                {t("list.title")}
              </h2>
              <Tabs value={tab} onValueChange={(v) => setTab(v as MissingLoginStatus)}>
                <TabsList>
                  {(["open", "resolved", "dismissed"] as const).map((s) => (
                    <TabsTrigger key={s} value={s} className="gap-1.5 px-3 capitalize">
                      {t(`tabs.${s}`)}
                      {count(s) !== undefined && count(s)! > 0 && (
                        <span
                          className={
                            s === "open"
                              ? "rounded-[4px] bg-warning/12 px-1.5 font-mono text-[10px] font-medium text-warning tabular-nums"
                              : "rounded-[4px] bg-foreground/[0.06] px-1.5 font-mono text-[10px] text-muted-foreground tabular-nums"
                          }
                        >
                          {count(s)}
                        </span>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {tab === "open" && others.length > 0 && (
              <div className="mb-4">
                <AttentionList items={others} agentById={agentById} workspaceOf={workspaces.length ? (item) => workspaces.find((w) => w.id === workspaceOf(item)) : undefined} />
              </div>
            )}
            {current.isLoading && currentQuestions.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-36 rounded-xl" />
                ))}
              </div>
            ) : current.isError && !currentQuestions.data?.length ? (
              <EmptyState
                icon={<Inbox />}
                title={isVaultLocked(current.error) ? t("list.vaultLocked") : t("list.loadError")}
                description={errorMessage(current.error)}
                action={
                  <Button variant="outline" onClick={() => current.refetch()}>
                    <RefreshCw /> {t("common:actions.tryAgain")}
                  </Button>
                }
              />
            ) : items.length === 0 && !(tab === "open" && others.length > 0) ? (
              <EmptyState
                key={tab}
                icon={EMPTY[tab].icon}
                art={tab === "open" ? <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={64} follow /> : undefined}
                title={t(`empty.${tab}.title`)}
                description={t(`empty.${tab}.description`)}
                className={tab === "open" ? "border-success/30 bg-success/[0.03]" : undefined}
              />
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {items.map((entry, i) => (
                    <motion.div
                      key={entry.item.id}
                      layout
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                      animate={reduce ? { opacity: 1, transition: { duration: 0.15, ease: "easeOut" } } : { opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
                      exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
                    >
                      {entry.kind === "question" ? (
                        <InboxQuestion question={entry.item} agent={agentById.get(entry.item.agentId)} />
                      ) : (
                        <MissingLoginCard
                          item={entry.item}
                          agent={entry.item.agentId ? agentById.get(entry.item.agentId) : undefined}
                          onStatus={(status) => update.mutate({ id: entry.item.id, status })}
                          pending={update.isPending && update.variables?.id === entry.item.id}
                          autoOpenLink={!!link2fa && (domainFromUrl(entry.item.url) === link2fa || entry.item.service.toLowerCase() === link2fa)}
                        />
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </section>

          <NotificationList className="@5xl:sticky @5xl:top-6" />
        </div>
    </PageBody>
  );
}
