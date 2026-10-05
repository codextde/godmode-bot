import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { MonitorSmartphone, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { AddRunnerDialog } from "@/components/runners/add-runner-dialog";
import { RunnerCard } from "@/components/runners/runner-card";
import { RemoveRunnerDialog, RenameRunnerDialog, RunnerAddressesDialog } from "@/components/runners/runner-dialogs";
import { RunnerScreenDialog } from "@/components/runners/runner-screen-dialog";
import { useRunnerActions } from "@/components/runners/use-runner-actions";
import { errorMessage } from "@/lib/api";
import { useRunners } from "@/lib/hooks";

/** Runners: other computers that do the work of a chat. Pair one, see whether it is ready, fix what isn't. */
export default function RunnersPage() {
  const [params, setParams] = useSearchParams();
  const list = useRunners();
  const runners = list.data ?? [];
  const actions = useRunnerActions();
  const [addOpen, setAddOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [addressesId, setAddressesId] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [screenId, setScreenId] = useState<string | null>(null);

  const byId = (id: string | null) => (id ? (runners.find((r) => r.id === id) ?? null) : null);

  // Deep link from other screens (the chat's "Add runner"): /runners?new=1 opens the add dialog.
  const wantsNew = params.get("new") === "1";
  useEffect(() => {
    if (!wantsNew) return;
    setAddOpen(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  }, [wantsNew, setParams]);

  const add = (
    <Button onClick={() => setAddOpen(true)}>
      <Plus /> Add runner
    </Button>
  );

  return (
    <div className="relative">
      <PageHeader icon={<MonitorSmartphone />} title="Runners" description="Other computers that work for you, even when this one sleeps." actions={add} />
      <PageBody>
        {list.isLoading ? (
          <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-56 rounded-xl" />
            ))}
          </div>
        ) : list.isError ? (
          <EmptyState
            icon={<MonitorSmartphone />}
            title="Couldn't load your runners"
            description={errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                <RefreshCw /> Try again
              </Button>
            }
          />
        ) : runners.length === 0 ? (
          <EmptyState
            icon={<MonitorSmartphone />}
            title="Keep working with the lid closed"
            description="Put Godmode on a Mac that stays on — a Mac mini, an old laptop — and hand it a chat. It works there with your agents, logins and browser sessions while this computer sleeps, and you watch it here like any other chat. Everything between the two is end-to-end encrypted."
            action={add}
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
            <AnimatePresence initial={false}>
              {runners.map((runner, i) => (
                <motion.div
                  key={runner.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ delay: Math.min(i, 8) * 0.03 }}
                  className="min-w-0"
                >
                  <RunnerCard
                    runner={runner}
                    actions={actions}
                    onRename={() => setRenameId(runner.id)}
                    onAddresses={() => setAddressesId(runner.id)}
                    onRemove={() => setRemoveId(runner.id)}
                    onScreen={() => setScreenId(runner.id)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </PageBody>

      <AddRunnerDialog open={addOpen} onOpenChange={setAddOpen} />
      <RenameRunnerDialog runner={byId(renameId)} onClose={() => setRenameId(null)} actions={actions} />
      <RunnerAddressesDialog runner={byId(addressesId)} onClose={() => setAddressesId(null)} actions={actions} />
      <RemoveRunnerDialog runner={byId(removeId)} onClose={() => setRemoveId(null)} actions={actions} />
      <RunnerScreenDialog runner={byId(screenId)} onClose={() => setScreenId(null)} />
    </div>
  );
}
