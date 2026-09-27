import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Archive, CircleCheck, Inbox, PartyPopper, RefreshCw } from "lucide-react";
import type { Agent, MissingLoginStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { MissingLoginCard, useMissingLoginStatus } from "@/components/inbox/missing-login-card";
import { NotificationList } from "@/components/inbox/notification-list";
import { isVaultLocked } from "@/components/vault/vault-utils";
import { errorMessage } from "@/lib/api";
import { useAllAgents, useMissingLogins } from "@/lib/hooks";

const EMPTY: Record<MissingLoginStatus, { icon: React.ReactNode; title: string; description: string }> = {
  open: {
    icon: <PartyPopper />,
    title: "All clear — your agents have everything they need",
    description: "When an agent hits a login it doesn't have, a failed sign-in or a missing 2FA code, it lands here instead of interrupting you.",
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

  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map<string, Agent>(agents.map((a) => [a.id, a])), [agents]);
  const update = useMissingLoginStatus(tab);

  const items = useMemo(
    () => [...(current.data ?? [])].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [current.data],
  );
  const openCount = open.data?.length ?? 0;

  const count = (s: MissingLoginStatus) => byStatus[s].data?.length;

  return (
    <div className="relative">
      <PageHeader
        icon={<Inbox />}
        title="Inbox"
        description={
          openCount > 0
            ? `${openCount} thing${openCount === 1 ? "" : "s"} need${openCount === 1 ? "s" : ""} your attention — add the missing access and your agents pick up where they left off.`
            : "What your agents need from you — missing logins, failed sign-ins, 2FA codes — plus updates from their work."
        }
      />
      <PageBody>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
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

            {current.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-36 rounded-xl" />
                ))}
              </div>
            ) : current.isError ? (
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
                title={EMPTY[tab].title}
                description={EMPTY[tab].description}
                className={tab === "open" ? "border-success/30 bg-success/[0.03]" : undefined}
              />
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {items.map((item, i) => (
                    <motion.div
                      key={item.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
                      exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
                    >
                      <MissingLoginCard
                        item={item}
                        agent={item.agentId ? agentById.get(item.agentId) : undefined}
                        onStatus={(status) => update.mutate({ id: item.id, status })}
                        pending={update.isPending && update.variables?.id === item.id}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </section>

          <NotificationList className="xl:sticky xl:top-6" />
        </div>
      </PageBody>
    </div>
  );
}
