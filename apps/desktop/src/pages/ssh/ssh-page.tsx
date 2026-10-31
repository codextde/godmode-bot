import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Plus, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { ServerCard } from "@/components/ssh/server-card";
import { DeleteServerDialog, ServerDialog } from "@/components/ssh/server-dialog";
import { useSshActions } from "@/components/ssh/use-ssh-actions";
import { errorMessage } from "@/lib/api";
import { useSshServers } from "@/lib/hooks";
import { useReduceAnimations } from "@/lib/motion";

/** SSH servers agents sign in to: add, test, run a command, assign them. */
export default function SshPage() {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["ssh", "common"]);
  const [params, setParams] = useSearchParams();
  const list = useSshServers();
  const servers = list.data ?? [];
  const actions = useSshActions();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Kept while the dialog closes, so its title doesn't flip to "Add" mid-animation.
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const byId = (id: string | null) => (id ? (servers.find((s) => s.id === id) ?? null) : null);
  const openAdd = () => {
    setDialogId(null);
    setDialogOpen(true);
  };
  const openEdit = (id: string) => {
    setDialogId(id);
    setDialogOpen(true);
  };

  // Deep links from other screens: /ssh?new=1 opens the add dialog, /ssh?edit=<id> the edit dialog.
  const wantsNew = params.get("new") === "1";
  const wantsEdit = params.get("edit");
  useEffect(() => {
    if (!wantsNew && !wantsEdit) return;
    if (wantsEdit && !list.data) return;
    if (wantsNew) openAdd();
    else if (wantsEdit && list.data?.some((s) => s.id === wantsEdit)) openEdit(wantsEdit);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        next.delete("edit");
        return next;
      },
      { replace: true },
    );
  }, [wantsNew, wantsEdit, list.data, setParams]);

  const editing = byId(dialogId);
  useEffect(() => {
    if (dialogOpen && dialogId && list.data && !editing) setDialogOpen(false);
  }, [dialogOpen, dialogId, list.data, editing]);

  return (
    <div className="relative">
      <PageHeader
        icon={<Server />}
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <Button onClick={openAdd}>
            <Plus /> {t("page.addServer")}
          </Button>
        }
      />
      <PageBody>
        {list.isLoading ? (
          <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
        ) : list.isError ? (
          <EmptyState
            icon={<Server />}
            title={t("page.loadError")}
            description={errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                <RefreshCw /> {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<Server />}
            title={t("page.emptyTitle")}
            description={t("page.emptyDescription")}
            action={
              <Button onClick={openAdd}>
                <Plus /> {t("page.addServer")}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
            <AnimatePresence initial={false}>
              {servers.map((server, i) => (
                <motion.div
                  key={server.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={reduce ? undefined : { delay: Math.min(i, 8) * 0.03 }}
                  className="min-w-0"
                >
                  <ServerCard server={server} actions={actions} onEdit={() => openEdit(server.id)} onDelete={() => setDeleteId(server.id)} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </PageBody>

      <ServerDialog open={dialogOpen} server={dialogId ? editing : null} onOpenChange={setDialogOpen} actions={actions} />
      <DeleteServerDialog server={byId(deleteId)} onClose={() => setDeleteId(null)} actions={actions} />
    </div>
  );
}
