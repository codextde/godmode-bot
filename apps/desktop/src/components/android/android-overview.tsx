import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Download, RefreshCw, ShieldQuestion, Smartphone, Wifi } from "lucide-react";
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
  { title: "Turn on developer options", body: "Settings → About phone → tap Build number seven times." },
  { title: "Allow USB debugging", body: "Settings → System → Developer options → USB debugging." },
  { title: "Plug it in and tap Allow", body: "Tick “Always allow from this computer” so it stays allowed." },
];

function SetupSteps() {
  return (
    <ol className="mx-auto mt-6 grid max-w-3xl gap-3 text-left @3xl:grid-cols-3">
      {STEPS.map((s, i) => (
        <li key={s.title} className="rounded-lg border bg-card p-3.5 shadow-card">
          <span className="grid size-6 place-items-center rounded-md border bg-paper-2 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
          <p className="mt-2.5 text-[13px] font-medium">{s.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}

function DeviceGrid({ devices, onEdit, onForget }: { devices: AndroidDevice[]; onEdit: (d: AndroidDevice) => void; onForget: (d: AndroidDevice) => void }) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
      <AnimatePresence initial={false}>
        {devices.map((device) => (
          <motion.div
            key={device.id}
            layout="position"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
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
    onError: (e) => toastApiError(e, "Couldn't look for phones", qc),
  });
  const install = useMutation({
    mutationFn: api.android.install,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.android });
      if (res.ok) toast.success(res.output);
      else toast.error("Couldn't install adb", { description: res.output });
    },
    onError: (e) => toastApiError(e, "Couldn't install adb", qc),
  });

  const adb = status.data?.adb;
  const pending = status.data?.pending ?? [];
  const connected = devices.filter((d) => d.state === "connected").length;

  return (
    <div className="@container relative space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="eyebrow">{devices.length ? `${connected} of ${devices.length} connected` : "Phones"}</h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Look for phones again" onClick={() => refresh.mutate()} disabled={refresh.isPending || !adb?.installed}>
            {refresh.isPending ? <Spinner className="size-4" /> : <RefreshCw />}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWifiOpen(true)} disabled={!adb?.installed}>
            <Wifi /> Connect over Wi-Fi
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
            title="Godmode needs adb to talk to phones"
            description={
              status.data?.canInstall
                ? "adb is Android's free debugging bridge from Google. Godmode installs its own copy (about 16 MB) — nothing else on your computer changes."
                : "Install Android's platform-tools (adb) and make sure it's on your PATH, or set its path below."
            }
            action={
              status.data?.canInstall && (
                <Button onClick={() => install.mutate()} disabled={install.isPending}>
                  {install.isPending ? <Spinner className="size-3.5" /> : <Download />} {install.isPending ? "Installing…" : "Install adb"}
                </Button>
              )
            }
          />
        ) : list.isError ? (
          <EmptyState
            icon={<Smartphone />}
            title="Couldn't load your phones"
            description={errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                <RefreshCw /> Try again
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
                        A phone is waiting {p.state === "unauthorized" ? "for your OK" : "to connect"}
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
                title="Connect your first phone"
                description="Plug an Android phone into this computer with a USB cable. It shows up here on its own."
                action={
                  <>
                    <SetupSteps />
                    <Button variant="link" className="mt-3 text-muted-foreground" onClick={() => setWifiOpen(true)}>
                      <Wifi /> Or connect over Wi-Fi
                    </Button>
                  </>
                }
              />
            ) : (
              <>
                <DeviceGrid devices={devices.filter((d) => d.state !== "disconnected")} onEdit={setEditing} onForget={setForgetting} />
                {devices.some((d) => d.state === "disconnected") && (
                  <section aria-label="Not connected" className="mt-4 grid gap-3">
                    <h2 className="eyebrow text-[10.5px]">Not connected</h2>
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
