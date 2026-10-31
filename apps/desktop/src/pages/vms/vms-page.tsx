import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Box, Download, HardDrive, Plus, PowerOff, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { VmStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { LiveDot } from "@/components/aicss/Motion";
import { useShortPath } from "@/components/chat/folder-picker";
import { useVmActions } from "@/components/vms/use-vm-actions";
import { VmCard } from "@/components/vms/vm-card";
import { DeleteVmDialog, EditVmDialog, NewVmDialog, ResetVmDialog } from "@/components/vms/vm-dialogs";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { useBootstrap, useVmStatus, useVms } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** macOS VMs agents work in: create, start/stop, open their screen, assign them. */
export default function VmsPage() {
  const { t } = useTranslation(["vms", "common"]);
  const [params, setParams] = useSearchParams();
  const { data: boot } = useBootstrap();
  const status = useVmStatus();
  const s = status.data;
  const supported = s?.supported !== false;
  const list = useVms(supported);
  const vms = list.data ?? [];
  const actions = useVmActions();
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const turnedOff = boot?.settings.vm?.enabled === false;

  // Deep link from other screens: /vms?new=1 opens the New VM dialog.
  useEffect(() => {
    if (params.get("new") !== "1" || !s?.supported) return;
    setCreateOpen(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  }, [params, setParams, s?.supported]);

  const byId = (id: string | null) => (id ? (vms.find((v) => v.id === id) ?? null) : null);

  return (
    <div className="relative">
      <PageHeader
        icon={<Box />}
        title={t("page.title")}
        description={t("page.description")}
        actions={
          s?.supported ? (
            <>
              <RunningCount status={s} />
              <Button onClick={() => setCreateOpen(true)}>
                <Plus /> {t("page.newVm")}
              </Button>
            </>
          ) : undefined
        }
      />
      <PageBody className="space-y-5">
        {status.isLoading ? (
          <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
        ) : status.isError || !s ? (
          <EmptyState
            icon={<Box />}
            title={t("page.checkFailed")}
            description={errorMessage(status.error)}
            action={
              <Button variant="outline" onClick={() => status.refetch()}>
                <RefreshCw /> {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : !s.supported ? (
          <Unsupported reason={s.reason} />
        ) : (
          <>
            {turnedOff && (
              <div className="flex items-start gap-3 rounded-lg border bg-paper-2 px-3 py-2.5 text-[13px]">
                <PowerOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">{t("page.turnedOffTitle")}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    <Trans
                      t={t}
                      i18nKey="page.turnedOffBody"
                      components={{ link: <Link to="/settings/vms" className="font-medium text-foreground underline underline-offset-2" /> }}
                    />
                  </span>
                </p>
              </div>
            )}
            {!s.tart.installed && <SetupCard status={s} />}

            {list.isError ? (
              <EmptyState
                icon={<Box />}
                title={t("page.loadError")}
                description={errorMessage(list.error)}
                action={
                  <Button variant="outline" onClick={() => list.refetch()}>
                    <RefreshCw /> {t("common:actions.tryAgain")}
                  </Button>
                }
              />
            ) : list.isLoading ? (
              <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="h-52 rounded-xl" />
                ))}
              </div>
            ) : vms.length === 0 ? (
              <EmptyState
                icon={<Box />}
                title={t("page.emptyTitle")}
                description={t("page.emptyDescription")}
                action={
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus /> {t("page.newVm")}
                  </Button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
                <AnimatePresence initial={false}>
                  {vms.map((vm, i) => (
                    <motion.div
                      key={vm.id}
                      layout="position"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      transition={{ delay: Math.min(i, 8) * 0.03 }}
                      className="min-w-0"
                    >
                      <VmCard
                        vm={vm}
                        presets={s.images}
                        vms={vms}
                        actions={actions}
                        onEdit={() => setEditId(vm.id)}
                        onReset={() => setResetId(vm.id)}
                        onDelete={() => setDeleteId(vm.id)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}

            <StorageNote status={s} />
          </>
        )}
      </PageBody>

      {s?.supported && <NewVmDialog open={createOpen} onOpenChange={setCreateOpen} status={s} vms={vms} />}
      <EditVmDialog vm={byId(editId)} status={s} onClose={() => setEditId(null)} actions={actions} />
      <ResetVmDialog vm={byId(resetId)} presets={s?.images} onClose={() => setResetId(null)} actions={actions} />
      <DeleteVmDialog vm={byId(deleteId)} onClose={() => setDeleteId(null)} actions={actions} />
    </div>
  );
}

function RunningCount({ status }: { status: VmStatus }) {
  const { t } = useTranslation("vms");
  const full = status.running >= status.maxRunning;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-[13px] text-muted-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <LiveDot live={status.running > 0} className={cn(status.running === 0 && "bg-muted-foreground/40")} />
          <span className="tabular-nums">
            <Trans
              t={t}
              i18nKey="page.running"
              values={{ running: status.running, max: status.maxRunning }}
              components={{ b: <span className={cn("font-medium text-foreground", full && "text-warning")} /> }}
            />
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {t("page.runningTooltip", { max: status.maxRunning })}
      </TooltipContent>
    </Tooltip>
  );
}

function Unsupported({ reason }: { reason: string | null }) {
  const { t } = useTranslation("vms");
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/[0.07] p-4 text-sm" role="alert">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{t("page.unsupportedTitle")}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {reason ?? t("page.unsupportedReason")} {t("page.unsupportedKeep")}
        </p>
      </div>
    </div>
  );
}

function SetupCard({ status }: { status: VmStatus }) {
  const { t } = useTranslation("vms");
  const qc = useQueryClient();
  const short = useShortPath();
  const install = useMutation({
    mutationFn: api.vms.install,
    onSuccess: (res) => {
      if (res.ok) toast.success(t("page.setupReady"), { description: t("page.setupReadyDescription") });
      else toast.error(t("page.setupFailed"), { description: res.output || undefined });
      void qc.invalidateQueries({ queryKey: qk.vms });
    },
    onError: (e) => toastApiError(e, t("page.setupFailed"), qc),
  });
  return (
    <section className={cn("rounded-xl border bg-card p-5 shadow-card", install.isPending && "glow-border")}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
          <Download className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{t("page.setupTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            <Trans
              t={t}
              i18nKey="page.setupBody"
              values={{ path: short(status.storageDir) }}
              components={{
                link: <a href="https://tart.run" target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-2" />,
                mono: <span className="font-mono text-[13px] break-all text-foreground" />,
              }}
            />
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t("page.setupSkip")}</p>
        </div>
        <Button onClick={() => install.mutate()} disabled={install.isPending} className="self-center">
          {install.isPending ? <Spinner /> : <Download />}
          {install.isPending ? t("page.settingUp") : t("page.setUp")}
        </Button>
      </div>
    </section>
  );
}

function StorageNote({ status }: { status: VmStatus }) {
  const { t } = useTranslation(["vms", "common"]);
  const short = useShortPath();
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
      <HardDrive className="size-3.5" />
      <span>
        <Trans t={t} i18nKey="page.storedIn" values={{ path: short(status.storageDir) }} components={{ mono: <span className="font-mono" /> }} />
      </span>
      {status.host.freeDiskGb !== null && (
        <>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">{t("page.free", { n: status.host.freeDiskGb })}</span>
        </>
      )}
      {status.tart.version && (
        <>
          <span className="opacity-40">·</span>
          <span>Tart {status.tart.version}</span>
        </>
      )}
      <span className="opacity-40">·</span>
      <Link to="/settings/vms" className="font-medium text-foreground underline-offset-2 hover:underline">
        {t("common:words.settings")}
      </Link>
    </p>
  );
}
