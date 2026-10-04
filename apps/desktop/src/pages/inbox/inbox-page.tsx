import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Archive, CircleCheck, Inbox, PartyPopper, RefreshCw } from "lucide-react";
import type { Agent, AgentQuestion, MissingLogin, MissingLoginStatus } from "@godmode/shared";
import { MASCOT_CHARACTER, MASCOT_COLOR } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { Character } from "@/components/character";
import { MissingLoginCard, useMissingLoginStatus } from "@/components/inbox/missing-login-card";
import { NotificationList } from "@/components/inbox/notification-list";
import { InboxQuestion } from "@/components/inbox/question-item";
import { isVaultLocked } from "@/components/vault/vault-utils";
import { errorMessage } from "@/lib/api";
import { useAllAgents, useMissingLogins, useQuestions } from "@/lib/hooks";

type Entry = { kind: "login"; item: MissingLogin; at: number } | { kind: "question"; item: AgentQuestion; at: number };

const EMPTY: Record<MissingLoginStatus, { icon: React.ReactNode; title: string; description: string }> = {
  open: {
    icon: <PartyPopper />,
    title: "All clear — your agents have everything they need",
    description: "When an agent needs a decision, your OK, a login it doesn't have or a 2FA code, it lands here instead of getting lost in a chat.",
  },
  resolved: {
    icon: <CircleCheck />,
    title: "Nothing resolved yet",
    description: "Requests you fix — by adding a login or 2FA code, or marking them resolved — are kept here for reference.",
  },
  dismissed: {
    icon: <Archive />,
    title: "Nothing dismissed",
    description: "Requests you dismiss are parked here. Reopen them any time.",
  },
};

export default function InboxPage() {
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

  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map<string, Agent>(agents.map((a) => [a.id, a])), [agents]);
  const update = useMissingLoginStatus(tab);

  const items = useMemo<Entry[]>(
    () =>
      [
        ...(current.data ?? []).map((item): Entry => ({ kind: "login", item, at: new Date(item.updatedAt).getTime() })),
        ...(currentQuestions.data ?? []).map((item): Entry => ({ kind: "question", item, at: new Date(item.answer?.at ?? item.updatedAt).getTime() })),
      ].sort((a, b) => b.at - a.at),
    [current.data, currentQuestions.data],
  );
  const openCount = (open.data?.length ?? 0) + (qOpen.data?.length ?? 0);

  const count = (s: MissingLoginStatus) => {
    const logins = byStatus[s].data?.length;
    const questions = questionsBy[s].data?.length;
    return logins === undefined && questions === undefined ? undefined : (logins ?? 0) + (questions ?? 0);
  };

  return (
    <div className="relative">
      <PageHeader
        icon={<Inbox />}
        title="Inbox"
        description={
          openCount > 0
            ? `${openCount} thing${openCount === 1 ? "" : "s"} need${openCount === 1 ? "s" : ""} your attention — answer what your agents ask or add the missing access.`
            : "What your agents need from you — questions, approvals, missing logins, 2FA codes — plus updates from their work."
        }
      />
      <PageBody>
        <div className="grid grid-cols-1 items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="attention-title" className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="attention-title" className="eyebrow">
                Needs your attention
              </h2>
              <Tabs value={tab} onValueChange={(v) => setTab(v as MissingLoginStatus)}>
                <TabsList>
                  {(["open", "resolved", "dismissed"] as const).map((s) => (
                    <TabsTrigger key={s} value={s} className="gap-1.5 px-3 capitalize">
                      {s}
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

            {current.isLoading && currentQuestions.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-36 rounded-xl" />
                ))}
              </div>
            ) : current.isError && !currentQuestions.data?.length ? (
              <EmptyState
                icon={<Inbox />}
                title={isVaultLocked(current.error) ? "Vault is locked" : "Couldn't load requests"}
                description={errorMessage(current.error)}
                action={
                  <Button variant="outline" onClick={() => current.refetch()}>
                    <RefreshCw /> Try again
                  </Button>
                }
              />
            ) : items.length === 0 ? (
              <EmptyState
                key={tab}
                icon={EMPTY[tab].icon}
                art={tab === "open" ? <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={64} follow /> : undefined}
                title={EMPTY[tab].title}
                description={EMPTY[tab].description}
                className={tab === "open" ? "border-success/30 bg-success/[0.03]" : undefined}
              />
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {items.map((entry, i) => (
                    <motion.div
                      key={entry.item.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
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
    </div>
  );
}
