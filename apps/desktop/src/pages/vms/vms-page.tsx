import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
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
        title="Virtual machines"
        description="Isolated macOS machines on this Mac — agents work there instead of on your computer."
        actions={
          s?.supported ? (
            <>
              <RunningCount status={s} />
              <Button onClick={() => setCreateOpen(true)}>
                <Plus /> New VM
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
            title="Couldn't check virtual machines"
            description={errorMessage(status.error)}
            action={
              <Button variant="outline" onClick={() => status.refetch()}>
                <RefreshCw /> Try again
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
                  <span className="font-medium">Agents don't use VMs right now.</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    Virtual machines are turned off in{" "}
                    <Link to="/settings/vms" className="font-medium text-foreground underline underline-offset-2">
                      Settings → Virtual machines
                    </Link>{" "}
                    — every run works on this Mac. You can still manage VMs here.
                  </span>
                </p>
              </div>
            )}
            {!s.tart.installed && <SetupCard status={s} />}

            {list.isError ? (
              <EmptyState
                icon={<Box />}
                title="Couldn't load your VMs"
                description={errorMessage(list.error)}
                action={
                  <Button variant="outline" onClick={() => list.refetch()}>
                    <RefreshCw /> Try again
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
                title="Give an agent its own Mac"
                description="It installs tools, runs builds and uses apps in an isolated macOS VM instead of your computer. Assign a VM to an agent, a chat or a workspace."
                action={
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus /> New VM
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
            <span className={cn("font-medium text-foreground", full && "text-warning")}>{status.running}</span> of {status.maxRunning} running
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Apple lets one Mac run at most {status.maxRunning} macOS VMs at the same time. Stop or suspend one to start another.
      </TooltipContent>
    </Tooltip>
  );
}

function Unsupported({ reason }: { reason: string | null }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/[0.07] p-4 text-sm" role="alert">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">Virtual machines aren't available here</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {reason ?? "macOS VMs need a Mac with Apple silicon."} Agents keep working on this computer as usual.
        </p>
      </div>
    </div>
  );
}

function SetupCard({ status }: { status: VmStatus }) {
  const qc = useQueryClient();
  const short = useShortPath();
  const install = useMutation({
    mutationFn: api.vms.install,
    onSuccess: (res) => {
      if (res.ok) toast.success("Ready for virtual machines", { description: "Create your first VM next." });
      else toast.error("Setup didn't finish", { description: res.output || undefined });
      void qc.invalidateQueries({ queryKey: qk.vms });
    },
    onError: (e) => toastApiError(e, "Setup didn't finish", qc),
  });
  return (
    <section className={cn("rounded-xl border bg-card p-5 shadow-card", install.isPending && "glow-border")}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
          <Download className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">One-time setup</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Godmode runs macOS VMs with Apple's Virtualization framework (via{" "}
            <a href="https://tart.run" target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-2">
              Tart
            </a>
            , free for personal use). VMs and their disks are stored on this Mac in <span className="font-mono text-[13px] break-all text-foreground">{short(status.storageDir)}</span>.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Creating a VM sets this up too — you can skip straight to New VM.</p>
        </div>
        <Button onClick={() => install.mutate()} disabled={install.isPending} className="self-center">
          {install.isPending ? <Spinner /> : <Download />}
          {install.isPending ? "Setting up…" : "Set up"}
        </Button>
      </div>
    </section>
  );
}

function StorageNote({ status }: { status: VmStatus }) {
  const short = useShortPath();
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
      <HardDrive className="size-3.5" />
      <span>
        Stored in <span className="font-mono">{short(status.storageDir)}</span>
      </span>
      {status.host.freeDiskGb !== null && (
        <>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">{status.host.freeDiskGb} GB free</span>
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
        Settings
      </Link>
    </p>
  );
}
