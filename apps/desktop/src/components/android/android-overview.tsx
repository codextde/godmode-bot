import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Download, RefreshCw, ShieldQuestion, Smartphone, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AndroidDevice } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/common";
import { ConnectWifiDialog, EditPhoneDialog, ForgetPhoneDialog } from "@/components/android/android-dialogs";
import { CONNECTION_LABEL } from "@/components/android/android-parts";
import { DeviceCard } from "@/components/android/device-card";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { useAndroidDevices, useAndroidStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";

const STEPS = [
  { id: "developer", title: "overview.steps.developer.title", body: "overview.steps.developer.body" },
  { id: "debugging", title: "overview.steps.debugging.title", body: "overview.steps.debugging.body" },
  { id: "plugIn", title: "overview.steps.plugIn.title", body: "overview.steps.plugIn.body" },
] as const;

function SetupSteps() {
  const { t } = useTranslation("android");
  return (
    <ol className="mx-auto mt-6 grid max-w-3xl gap-3 text-left @3xl:grid-cols-3">
      {STEPS.map((s, i) => (
        <li key={s.id} className="rounded-lg border bg-card p-3.5 shadow-card">
          <span className="grid size-6 place-items-center rounded-md border bg-paper-2 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
          <p className="mt-2.5 text-[13px] font-medium">{t(s.title)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(s.body)}</p>
        </li>
      ))}
    </ol>
  );
}

function DeviceGrid({ devices, onEdit, onForget }: { devices: AndroidDevice[]; onEdit: (d: AndroidDevice) => void; onForget: (d: AndroidDevice) => void }) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
      <AnimatePresence initial={false}>
        {devices.map((device, i) => (
          <motion.div
            key={device.id}
            layout="position"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ delay: Math.min(i, 8) * 0.03 }}
            className="min-w-0"
          >
            <DeviceCard device={device} onEdit={() => onEdit(device)} onForget={() => onForget(device)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Android phones connected over adb: watch them, take control, give them to agents. */
export function AndroidOverview() {
  const { t } = useTranslation(["android", "common"]);
  const qc = useQueryClient();
  const status = useAndroidStatus();
  const list = useAndroidDevices();
  const devices = list.data ?? [];
  const [wifiOpen, setWifiOpen] = useState(false);
  const [editing, setEditing] = useState<AndroidDevice | null>(null);
  const [forgetting, setForgetting] = useState<AndroidDevice | null>(null);

  const refresh = useMutation({
    mutationFn: api.android.refresh,
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.android }),
    onError: (e) => toastApiError(e, t("overview.lookFailed"), qc),
  });
  const install = useMutation({
    mutationFn: api.android.install,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.android });
      if (res.ok) toast.success(res.output);
      else toast.error(t("overview.installFailed"), { description: res.output });
    },
    onError: (e) => toastApiError(e, t("overview.installFailed"), qc),
  });

  const adb = status.data?.adb;
  const pending = status.data?.pending ?? [];
  const connected = devices.filter((d) => d.state === "connected").length;

  return (
    <div className="@container relative space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="eyebrow">{devices.length ? t("overview.countConnected", { connected, total: devices.length }) : t("overview.phones")}</h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label={t("overview.lookAgain")} onClick={() => refresh.mutate()} disabled={refresh.isPending || !adb?.installed}>
            {refresh.isPending ? <Spinner className="size-4" /> : <RefreshCw />}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWifiOpen(true)} disabled={!adb?.installed}>
            <Wifi /> {t("overview.connectWifi")}
          </Button>
        </div>
      </div>
      <div>
        {status.isLoading || list.isLoading ? (
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-96 rounded-xl" />
            ))}
          </div>
        ) : adb && !adb.installed ? (
          <EmptyState
            icon={<Download />}
            title={t("overview.adbTitle")}
            description={
              status.data?.canInstall
                ? t("overview.adbCanInstall")
                : t("overview.adbManual")
            }
            action={
              status.data?.canInstall && (
                <Button onClick={() => install.mutate()} disabled={install.isPending}>
                  {install.isPending ? <Spinner className="size-3.5" /> : <Download />} {install.isPending ? t("overview.installing") : t("overview.install")}
                </Button>
              )
            }
          />
        ) : list.isError ? (
          <EmptyState
            icon={<Smartphone />}
            title={t("overview.loadError")}
            description={errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                <RefreshCw /> {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4">
            <AnimatePresence initial={false}>
              {pending.map((p) => (
                <motion.div
                  key={p.adbSerial}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3">
                    <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">
                        {p.state === "unauthorized" ? t("overview.waitingOk") : t("overview.waitingConnect")}
                        <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                          {p.adbSerial} · {CONNECTION_LABEL[p.connection]}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{p.hint}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {status.data?.error && (
              <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs text-destructive">
                adb: {status.data.error}
              </p>
            )}

            {devices.length === 0 ? (
              <EmptyState
                icon={<Smartphone />}
                title={t("overview.emptyTitle")}
                description={t("overview.emptyDescription")}
                action={
                  <>
                    <SetupSteps />
                    <Button variant="link" className="mt-3 text-muted-foreground" onClick={() => setWifiOpen(true)}>
                      <Wifi /> {t("overview.orWifi")}
                    </Button>
                  </>
                }
              />
            ) : (
              <>
                <DeviceGrid devices={devices.filter((d) => d.state !== "disconnected")} onEdit={setEditing} onForget={setForgetting} />
                {devices.some((d) => d.state === "disconnected") && (
                  <section aria-label={t("state.disconnected")} className="mt-4 grid gap-3">
                    <h2 className="eyebrow text-[10.5px]">{t("state.disconnected")}</h2>
                    <DeviceGrid devices={devices.filter((d) => d.state === "disconnected")} onEdit={setEditing} onForget={setForgetting} />
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <ConnectWifiDialog open={wifiOpen} onOpenChange={setWifiOpen} />
      <EditPhoneDialog device={editing} onClose={() => setEditing(null)} />
      <ForgetPhoneDialog device={forgetting} onClose={() => setForgetting(null)} />
    </div>
  );
}
