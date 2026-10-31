import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, isToday } from "date-fns";
import { ArrowRightFromLine, ChevronDown, Laptop, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DeviceGroup, GroupDevice, RunnerState } from "@godmode/shared";
import { RunnerStateDot } from "@/components/runners/runner-parts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/components/vault/use-now";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { isMac } from "@/lib/desktop";
import { dateLocale, t } from "@/i18n";
import { useDeviceGroup } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** Laptops by their name, everything else (a Mac mini, an iMac, a Studio) as a desktop. */
export function DeviceIcon({ device, className }: { device: Pick<GroupDevice, "name" | "role">; className?: string }) {
  const laptop = /book|laptop|notebook/i.test(device.name) || (device.role === "secondary" && !/mini|studio|imac|mac pro|desktop|tower/i.test(device.name));
  const Icon = laptop ? Laptop : Monitor;
  return <Icon className={className} aria-hidden />;
}

export function deviceName(device: GroupDevice): string {
  return device.self ? (isMac ? t("devices:thisMac") : t("devices:thisComputer")) : device.name;
}

/** "2 working · 14 chats" */
export function deviceWorkLine(device: Pick<GroupDevice, "activeRuns" | "conversations">): string {
  const chats = t("devices:chats", { count: device.conversations });
  return device.activeRuns > 0 ? t("devices:workingChats", { working: device.activeRuns, chats }) : chats;
}

/** A link slower than this is worth a word; below it the number means nothing to anyone. */
const SLOW_MS = 300;

/** "14:02" today, "12 Oct, 14:02" before. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return format(d, isToday(d) ? t("devices:clock.today") : t("devices:clock.earlier"), { locale: dateLocale() });
}

/** "1:40" */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ticks every second while a stand-in counts down, rarely otherwise ("Away since" doesn't change). */
export function useGroupClock(group: DeviceGroup | undefined): number {
  return useNow(group?.role === "secondary" && group.standIn.state === "waiting" ? 1000 : 30_000);
}

/** Whether it stands in for the primary right now. */
export function isStandingIn(device: GroupDevice, group: DeviceGroup | undefined): boolean {
  return device.standingIn || (device.self && group?.role === "secondary" && group.standIn.state === "active");
}

/** The connection as this computer sees it: on a secondary the primary is what `primaryOnline` says. */
export function deviceState(device: GroupDevice, group: DeviceGroup | undefined): RunnerState {
  if (device.self) return "online";
  if (group?.role === "secondary" && device.role === "primary") return group.primaryOnline ? "online" : device.state === "connecting" ? "connecting" : "offline";
  return device.state;
}

/** "Online", "Online · slow connection", "Away since 14:02", "Takes over in 1:40", "Stands in since 14:04". */
export function deviceStateLine(device: GroupDevice, group?: DeviceGroup, now = Date.now()): string {
  if (isStandingIn(device, group)) return device.self && group?.standIn.since ? t("devices:state.standsInSince", { time: clockTime(group.standIn.since) }) : t("devices:state.standsIn");
  if (device.self) {
    const standIn = group?.role === "secondary" ? group.standIn : null;
    if (standIn?.state === "waiting" && standIn.takesOverAt) {
      const left = new Date(standIn.takesOverAt).getTime() - now;
      return left > 0 ? t("devices:state.takesOverIn", { time: countdown(left) }) : t("devices:state.takingOver");
    }
    return t("devices:state.online");
  }
  const state = deviceState(device, group);
  if (state === "online") return device.latencyMs !== null && device.latencyMs > SLOW_MS ? t("devices:state.onlineSlow") : t("devices:state.online");
  if (state === "offline") return device.lastSeenAt ? t("devices:state.awaySince", { time: clockTime(device.lastSeenAt) }) : t("devices:state.away");
  return state === "connecting" ? t("devices:state.connecting") : t("devices:state.updateRequired");
}

export function DeviceDot({ device, group, className }: { device: GroupDevice; group?: DeviceGroup; className?: string }) {
  return <RunnerStateDot state={deviceState(device, group)} className={className} />;
}

/** On a Mac without Full Disk Access a command that opens Desktop, Documents or Downloads waits for a click there. */
export function needsFullDiskAccess(device: GroupDevice): boolean {
  return device.fullDiskAccess === false;
}

/** Where this computer's running work can go: the primary from a secondary, the online secondaries from the primary. */
export function handoffTargets(group: DeviceGroup | undefined): GroupDevice[] {
  if (!group?.role) return [];
  if (group.role === "secondary") return group.primaryOnline ? group.devices.filter((d) => d.role === "primary") : [];
  return group.devices.filter((d) => !d.self && d.role === "secondary" && d.state === "online");
}

/** Hand this computer's working chats to another computer of the group, with a toast that says how it went. */
export function useHandoff() {
  const { t } = useTranslation("devices");
  const qc = useQueryClient();
  const { data: group } = useDeviceGroup();
  const self = group?.devices.find((d) => d.self) ?? null;
  const targets = handoffTargets(group);
  const run = useMutation({
    mutationFn: (to: GroupDevice) =>
      api.devices.handoff(group?.role === "secondary" ? { from: group.selfId, to: null } : { from: null, to: to.id }),
    onSuccess: (result, to) => {
      const moved = result.moved.length;
      const failed = result.failed.length;
      const details = result.failed.map((f) => `${f.title}: ${f.error}`).join("\n");
      if (!moved && !failed) toast(t("handoff.nothing"), { description: isMac ? t("handoff.nothingDescriptionMac") : t("handoff.nothingDescription") });
      else if (!failed) toast.success(t("handoff.moved", { count: moved, name: to.name }), { description: t("handoff.movedDescription") });
      else if (!moved) toast.error(t("handoff.moveError", { count: failed, name: to.name }), { description: details });
      else toast.warning(t("handoff.movedPartly", { moved, total: moved + failed, name: to.name }), { description: details });
      void qc.invalidateQueries({ queryKey: qk.devices });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (e, to) => toastApiError(e, t("handoff.error", { name: to.name }), qc),
  });
  return { group, self, targets, working: self?.activeRuns ?? 0, handoff: run.mutate, pending: run.isPending };
}

function targetLine(d: GroupDevice): string {
  if (d.activeRuns > 0) return t("devices:working", { count: d.activeRuns });
  return d.latencyMs !== null && d.latencyMs > SLOW_MS ? t("devices:slowConnection") : "";
}

/**
 * "Hand off to Mac mini", or a menu of computers when more than one could take it. `stacked`: the action on the first
 * line and where the work goes on the second, so a long computer name never squeezes the label.
 */
export function HandoffButton({
  size = "default",
  variant = "default",
  className,
  label,
  stacked = false,
}: {
  size?: "default" | "sm";
  variant?: "default" | "outline";
  className?: string;
  label?: string;
  stacked?: boolean;
}) {
  const { t } = useTranslation("devices");
  const { group, targets, working, handoff, pending } = useHandoff();
  label ??= t("handoff.label");
  const icon = pending ? <Spinner /> : <ArrowRightFromLine />;
  const to = targets.length === 1 ? targets[0] : null;
  const unavailable = group?.role === "secondary" ? (group.primaryName ? t("handoff.primaryAway", { name: group.primaryName }) : t("handoff.primaryAwayFallback")) : t("handoff.noneOnline");
  const menu = targets.length > 1;
  // Nowhere to go: never the loud style, whatever is running.
  const look = targets.length ? variant : "outline";

  const content = stacked ? (
    <>
      {icon}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] leading-5 font-medium">
          {pending ? t("handoff.handingOff") : working > 0 ? t("handoff.handOffChats", { count: working }) : t("handoff.handOffWork")}
        </span>
        <span className="block truncate text-[11.5px] leading-4 font-normal opacity-70">{to ? t("handoff.toName", { name: to.name }) : menu ? t("handoff.pick") : unavailable}</span>
      </span>
      {menu && !pending && <ChevronDown className="opacity-60" />}
    </>
  ) : (
    <>
      {icon}
      <span className="truncate">{pending ? t("handoff.handingOff") : to ? `${label} ${to.name}` : menu ? `${label}…` : unavailable}</span>
      {menu && !pending && <ChevronDown className="opacity-60" />}
    </>
  );
  const cls = cn(stacked && "h-auto min-h-10 w-full min-w-0 justify-start gap-2.5 px-3 py-1 has-[>svg]:px-3", className);

  if (!menu) {
    return (
      <Button size={size} variant={look} className={cls} disabled={!to || pending} onClick={() => to && handoff(to)}>
        {content}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={look} className={cls} disabled={pending}>
          {content}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn("min-w-56", stacked && "w-(--radix-dropdown-menu-trigger-width)")}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("handoff.continueOn")}</DropdownMenuLabel>
        {targets.map((d) => (
          <DropdownMenuItem key={d.id ?? "primary"} onSelect={() => handoff(d)}>
            <DeviceIcon device={d} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{targetLine(d)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
