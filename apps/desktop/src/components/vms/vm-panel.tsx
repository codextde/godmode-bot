import { useEffect } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import type { Vm } from "@godmode/shared";
import { AppWindow, ArrowUpRight, Box, Globe, Hand, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Play, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { useNow } from "@/components/vault/use-now";
import { api } from "@/lib/api";
import { useVmChoices } from "@/lib/hooks";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useVmActions } from "./use-vm-actions";
import { formatMemory, VM_STATE_LABEL, VmStateBadge } from "./vm-parts";
import { resolveInherited, type InheritedVm } from "./vm-picker";

/** The VM a chat works in: its own, else its agent's, else its workspace's (null when there is none or VMs are off). */
export function useChatVm(value: string | null, inherited: (InheritedVm | null | undefined)[]): { vm: Vm; from: string | null } | null {
  const { available, vms } = useVmChoices();
  if (!available) return null;
  const own = value ? vms.find((v) => v.id === value) : undefined;
  if (own) return { vm: own, from: null };
  return resolveInherited(inherited, vms);
}

/** The VM's screen, polled while it runs — faster while the agent is working in it. */
function useVmScreen(vm: Vm, size: number, fast: boolean) {
  const running = vm.state === "running";
  const query = useQuery({
    queryKey: qk.vmScreen(vm.id, size),
    queryFn: async () => ({ ...(await api.vms.screenshot(vm.id, size)), at: Date.now() }),
    enabled: running,
    refetchInterval: running ? (fast ? 1_500 : 5_000) : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const now = useNow(1000);
  const shot = running ? query.data : undefined;
  return { shot, live: !!shot && now - shot.at < 6_000, failed: running && query.isError && !shot };
}

/** The screen's shape: from the latest picture, else the VM's display setting. */
function aspectOf(vm: Vm, shot?: { width: number; height: number }): string {
  if (shot?.width && shot.height) return `${shot.width} / ${shot.height}`;
  const [w, h] = vm.display.split("x").map(Number);
  return w && h ? `${w} / ${h}` : "16 / 10";
}

/** What the screen area shows while there is no picture: starting, stopped, suspended… */
function ScreenPlaceholder({ vm, failed, onStart, starting }: { vm: Vm; failed: boolean; onStart: () => void; starting: boolean }) {
  const idle = vm.state === "stopped" || vm.state === "suspended";
  return (
    <span className="absolute inset-0 grid place-items-center bg-paper-2 px-6 text-center">
      <span className="flex flex-col items-center gap-2.5">
        {idle ? (
          <>
            <span className="grid size-9 place-items-center rounded-xl border bg-card text-muted-foreground shadow-card">
              <Box className="size-4" />
            </span>
            <span className="text-xs text-muted-foreground">{vm.state === "suspended" ? "Suspended — resumes with the next message" : "Off — starts with the next message"}</span>
            <Button size="xs" variant="outline" onClick={onStart} disabled={starting}>
              {starting ? <Spinner className="size-3" /> : <Play />} {vm.state === "suspended" ? "Resume now" : "Start now"}
            </Button>
          </>
        ) : vm.state === "error" ? (
          <span className="text-xs text-destructive">{vm.error ?? "The VM needs attention."}</span>
        ) : failed ? (
          <span className="text-xs text-muted-foreground">The screen isn't available right now</span>
        ) : (
          <>
            <Orb variant="C3" size={24} label="Connecting to the screen" />
            <span className="text-shimmer text-xs font-medium">{vm.progress?.label ?? (vm.state === "running" ? "Connecting…" : `${VM_STATE_LABEL[vm.state]}…`)}</span>
          </>
        )}
      </span>
    </span>
  );
}

const INSIDE = [
  { icon: Globe, label: "Chrome" },
  { icon: AppWindow, label: "Apps" },
  { icon: SquareTerminal, label: "Shell" },
] as const;

/** Side panel of a chat that works in a VM: the VM's screen, what the agent is doing, and a way in. */
export function VmPanel({
  vm,
  from,
  activity,
  onHide,
  onFocus,
}: {
  vm: Vm;
  /** Where the VM comes from when the chat didn't pick it ("Coder", "the ACME workspace"). */
  from: string | null;
  /** What the agent is doing right now; null while this chat is idle. */
  activity: string | null;
  onHide: () => void;
  onFocus: () => void;
}) {
  const { shot, live, failed } = useVmScreen(vm, 640, !!activity);
  const actions = useVmActions();
  const starting = actions.start.isPending && actions.start.variables?.id === vm.id;
  const opening = actions.open.isPending && actions.open.variables?.vm.id === vm.id;

  return (
    <motion.aside
      aria-label="Virtual machine"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full w-80 flex-col">
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b px-4", isTauri && isMac && "h-auto pt-7 pb-2")}>
          <span className="text-sm font-medium">Virtual machine</span>
          {vm.state === "running" ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
                live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
              )}
            >
              <LiveDot live={live} />
              {live ? "Live" : "Idle"}
            </span>
          ) : (
            <VmStateBadge state={vm.state} />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1.5 ml-auto text-muted-foreground" onClick={onHide} aria-label="Hide the VM">
                <PanelRightClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide the VM</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className={cn("rounded-xl", activity && "glow-border")}>
            <div className="relative overflow-hidden rounded-xl border bg-card shadow-card" style={{ aspectRatio: aspectOf(vm, shot) }}>
              {shot ? (
                <button
                  type="button"
                  onClick={onFocus}
                  aria-label={`Watch ${vm.name} full size`}
                  className="group/preview absolute inset-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <img src={`data:${shot.mime};base64,${shot.data}`} alt={`Screen of ${vm.name}`} draggable={false} className="absolute inset-0 size-full object-contain select-none" />
                  <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover/preview:bg-black/30 group-hover/preview:opacity-100 group-focus-visible/preview:bg-black/30 group-focus-visible/preview:opacity-100">
                    <span className="glass inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground">
                      <Maximize2 className="size-3.5" /> Watch full size
                    </span>
                  </span>
                </button>
              ) : (
                <ScreenPlaceholder vm={vm} failed={failed} onStart={() => actions.start.mutate(vm)} starting={starting} />
              )}
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
              <Box className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-5 font-medium">{vm.name}</p>
              <p className="truncate text-[11px] leading-4 text-muted-foreground">
                macOS · {vm.cpu} CPUs · {formatMemory(vm.memoryMb)}
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-card px-3 py-2.5 shadow-card">
            <p className="text-[11px] font-medium text-muted-foreground">The agent works inside this VM</p>
            <div className="mt-2 flex gap-1.5">
              {INSIDE.map(({ icon: Icon, label }) => (
                <span key={label} className="inline-flex h-6 flex-1 items-center justify-center gap-1.5 rounded-md border bg-paper-2 text-[11.5px] text-foreground">
                  <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                  {label}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Nothing opens on your Mac — no browser, no apps, no shell.</p>
          </div>

          <AnimatePresence initial={false}>
            {activity && (
              <motion.div
                key="activity"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-card">
                  <WorkingTicks count={8} className="shrink-0 text-brand" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activity}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => actions.open.mutate({ vm, what: "screen" })} disabled={opening || vm.state === "creating" || vm.state === "error"}>
              {opening ? <Spinner className="size-3.5" /> : <Hand />} Take control
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" onClick={onFocus} disabled={!shot} aria-label="Watch full size">
                  <Maximize2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Watch full size</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Link
          to="/vms"
          className="group flex shrink-0 items-center gap-3 border-t px-4 py-3 transition hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground shadow-card">
            <Box className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">Virtual machines</span>
            <span className="block truncate text-[11px] text-muted-foreground">{from ? `The VM of ${from}` : "Picked for this chat"}</span>
          </span>
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
        </Link>
      </div>
    </motion.aside>
  );
}

/** The VM's screen full size on top of the chat; Take control opens it in Screen Sharing. */
export function VmFocus({ vm, open, working, onClose }: { vm: Vm | null; open: boolean; working: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {vm && open && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40 bg-[#1c1b19]/35 dark:bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            key="focus"
            role="dialog"
            aria-modal
            aria-label={`Screen of ${vm.name}`}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="fixed inset-4 z-50 flex flex-col md:inset-8"
          >
            <VmFocusBody vm={vm} working={working} onClose={onClose} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function VmFocusBody({ vm, working, onClose }: { vm: Vm; working: boolean; onClose: () => void }) {
  const { shot, live, failed } = useVmScreen(vm, 1440, true);
  const actions = useVmActions();
  const opening = actions.open.isPending && actions.open.variables?.vm.id === vm.id;
  const starting = actions.start.isPending && actions.start.variables?.id === vm.id;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col rounded-xl", working && "glow-border")}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-float">
        <div className="flex items-center gap-3 border-b bg-paper-2 px-3 py-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
            <Box className="size-3.5" />
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium">{vm.name}</span>
          {vm.state === "running" ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
                live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
              )}
            >
              <LiveDot live={live} />
              {live ? "Live" : "Idle"}
            </span>
          ) : (
            <VmStateBadge state={vm.state} />
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => actions.open.mutate({ vm, what: "screen" })} disabled={opening || vm.state === "creating" || vm.state === "error"}>
              {opening ? <Spinner className="size-3.5" /> : <Hand />} Take control
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Exit focus view">
                  <Minimize2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Exit focus view</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 bg-[#1c1b19]">
          {shot ? (
            <img src={`data:${shot.mime};base64,${shot.data}`} alt={`Screen of ${vm.name}`} draggable={false} className="absolute inset-0 size-full object-contain select-none" />
          ) : (
            <ScreenPlaceholder vm={vm} failed={failed} onStart={() => actions.start.mutate(vm)} starting={starting} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Header button that brings the VM panel back once it's hidden (or opens the screen full size on narrow windows). */
export function VmToggle({ working, onClick }: { working: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Show the VM" onClick={onClick} className="relative text-muted-foreground">
          <PanelRightOpen />
          {working && <LiveDot className="absolute top-1.5 right-1.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show the VM</TooltipContent>
    </Tooltip>
  );
}
