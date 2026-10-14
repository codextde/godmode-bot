import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Laptop, WifiOff } from "lucide-react";
import type { DeviceGroup, RunnerState } from "@godmode/shared";
import { DeviceDot, DeviceIcon, deviceStateLine, HandoffButton, useHandoff } from "@/components/devices/device-parts";
import { THIS_COMPUTER, THIS_COMPUTER_INLINE } from "@/components/runners/runner-parts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/desktop";
import { useDeviceGroup } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** True once `on` held for `delay` ms; false right away when it doesn't. A primary that blips for a second stays quiet. */
function useSteady(on: boolean, delay: number): boolean {
  const [steady, setSteady] = useState(false);
  useEffect(() => {
    if (!on) return setSteady(false);
    const t = setTimeout(() => setSteady(true), delay);
    return () => clearTimeout(t);
  }, [on, delay]);
  return on && steady;
}

/** On a secondary while its primary can't be reached: what the app shows now, and what comes back with it. */
export function PrimaryOfflineBanner() {
  const { data: group } = useDeviceGroup();
  const { pathname } = useLocation();
  const shown = useSteady(group?.role === "secondary" && !group.primaryOnline, 2500);
  const name = group?.primaryName ?? "Your primary";
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          key="primary-offline"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="shrink-0 overflow-hidden"
        >
          <div className="px-3 pt-3">
            <div role="status" className="flex min-h-10 items-center gap-3 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 text-[13px] shadow-card">
              <WifiOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="min-w-0 flex-1 leading-snug">
                <span className="font-medium">{name} is offline</span>
                <span className="text-muted-foreground">
                  {" "}
                  — you see {THIS_COMPUTER_INLINE}'s own chats. Agents, the board and automations come back when it's online.
                </span>
              </p>
              {!pathname.startsWith("/settings/devices") && (
                <Button size="sm" variant="outline" className="h-7 shrink-0 bg-card" asChild>
                  <Link to="/settings/devices">Devices</Link>
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const DOT: Record<RunnerState, string> = {
  online: "bg-brand",
  connecting: "animate-pulse bg-warning",
  update_required: "bg-warning",
  offline: "bg-muted-foreground/50",
};

function summary(group: DeviceGroup): { label: string; state: RunnerState } {
  if (group.role === "secondary") {
    const primary = group.devices.find((d) => d.role === "primary");
    const state: RunnerState = group.primaryOnline ? "online" : primary?.state === "connecting" ? "connecting" : "offline";
    return { label: state === "offline" ? `${group.primaryName} is offline` : `Synced with ${group.primaryName}`, state };
  }
  const n = group.devices.length;
  const noun = isMac ? (n === 1 ? "Mac" : "Macs") : n === 1 ? "computer" : "computers";
  const anyOnline = group.devices.some((d) => !d.self && d.state === "online");
  return { label: `${n} ${noun} in your group`, state: anyOnline || n === 1 ? "online" : "offline" };
}

/** Sidebar footer: the device group at a glance, with the hand-off one click away. */
export function DeviceIndicator() {
  const { group, working } = useHandoff();
  const { state: sidebar, isMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  if (!group?.role) return null;
  const railed = sidebar === "collapsed" && !isMobile;
  const { label, state } = summary(group);
  const primaryName = group.role === "primary" ? THIS_COMPUTER : group.primaryName;

  const trigger = (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label={`${label}. Devices`}
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground outline-none transition-colors",
          "hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground",
          "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:self-center group-data-[collapsible=icon]:px-0",
        )}
      >
        <span className="relative shrink-0">
          <Laptop className="size-4" aria-hidden />
          <span className={cn("absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-sidebar", DOT[state])} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-left group-data-[collapsible=icon]:hidden">{label}</span>
        {working > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] text-foreground/70 tabular-nums group-data-[collapsible=icon]:hidden">{working} working</span>
        )}
      </button>
    </PopoverTrigger>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {railed ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverContent side={railed ? "right" : "top"} align={railed ? "end" : "start"} sideOffset={8} className="w-72 overflow-hidden rounded-xl p-0">
        <div className="px-4 pt-3.5 pb-2">
          <p className="text-sm font-medium">Device group</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{primaryName} is the primary.</p>
        </div>
        <ul className="px-1.5 pb-1.5">
          {group.devices.map((d) => (
            <li key={d.id ?? "primary"} className="flex items-center gap-2.5 rounded-md px-2.5 py-2">
              <DeviceIcon device={d} className={cn("size-4 shrink-0", d.self || d.state === "online" ? "text-foreground/80" : "text-muted-foreground/60")} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {d.name}
                  {d.self && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{THIS_COMPUTER}</span>}
                </p>
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <DeviceDot device={d} />
                  <span className="truncate">{deviceStateLine(d)}</span>
                </p>
              </div>
              {d.activeRuns > 0 && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{d.activeRuns} working</span>}
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t bg-muted/40 p-2">
          <HandoffButton size="sm" label="Hand off work to" variant={working > 0 ? "default" : "outline"} className="w-full" />
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" asChild>
            <Link to="/settings/devices" onClick={() => setOpen(false)}>
              Manage devices <ArrowRight />
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
