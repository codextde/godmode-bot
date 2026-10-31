import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowRight, Laptop, LaptopMinimalCheck, Settings2, Timer, TriangleAlert, WifiOff } from "lucide-react";
import type { DeviceGroup, GroupDevice } from "@godmode/shared";
import {
  clockTime,
  countdown,
  DeviceDot,
  DeviceIcon,
  deviceState,
  deviceStateLine,
  HandoffButton,
  isStandingIn,
  needsFullDiskAccess,
  useGroupClock,
  useHandoff,
} from "@/components/devices/device-parts";
import { useNow } from "@/components/vault/use-now";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/desktop";
import { useDeviceGroup } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { t as translate } from "@/i18n";

const thisDevice = () => (isMac ? translate("layout:deviceStatus.thisMac") : translate("layout:deviceStatus.thisComputer"));

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

/** Ticks for the eye; a screen reader hears the time once instead of every second (the banner is a live region). */
function TakesOverIn({ at }: { at: string }) {
  const { t } = useTranslation("layout");
  const now = useNow(1000);
  const left = new Date(at).getTime() - now;
  return (
    <>
      <span className="tabular-nums" aria-hidden>
        {left > 0 ? t("deviceStatus.inTime", { time: countdown(left) }) : t("deviceStatus.inAMoment")}
      </span>
      <span className="sr-only">{t("deviceStatus.atTime", { time: clockTime(at) })}</span>
    </>
  );
}

/** On a secondary while its primary is away: this computer keeps everything working, and soon stands in for it. */
export function PrimaryOfflineBanner() {
  const { t } = useTranslation("layout");
  const { data: group } = useDeviceGroup();
  const { pathname } = useLocation();
  const shown = useSteady(group?.role === "secondary" && !group.primaryOnline, 2500);
  const name = group?.primaryName ?? t("deviceStatus.yourPrimary");
  const standIn = group?.standIn;
  const waiting = standIn?.state === "waiting" && !!standIn.takesOverAt;
  const active = standIn?.state === "active";
  const Icon = active ? LaptopMinimalCheck : waiting ? Timer : WifiOff;
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
              <Icon className={cn("size-4 shrink-0", active ? "text-brand-strong" : "text-muted-foreground")} aria-hidden />
              <p className="min-w-0 flex-1 leading-snug">
                {active ? (
                  <>
                    <span className="font-medium">{t("deviceStatus.standsIn", { device: thisDevice(), name })}</span>
                    <span className="text-muted-foreground"> {t("deviceStatus.standsInHint")}</span>
                  </>
                ) : waiting ? (
                  <>
                    <span className="font-medium">{t("deviceStatus.away", { name })}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      <Trans t={t} i18nKey="deviceStatus.takesOver" values={{ device: thisDevice() }} components={{ time: <TakesOverIn at={standIn.takesOverAt!} /> }} />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium">{t("deviceStatus.away", { name })}</span>
                    <span className="text-muted-foreground"> {t("deviceStatus.awayHint")}</span>
                  </>
                )}
              </p>
              {!pathname.startsWith("/settings/devices") && (
                <Button size="sm" variant="outline" className="h-7 shrink-0 bg-card" asChild>
                  <Link to="/settings/devices">{t("deviceStatus.devices")}</Link>
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type Tone = "ok" | "busy" | "away";

const DOT: Record<Tone, string> = {
  ok: "bg-brand",
  busy: "animate-pulse bg-warning",
  away: "bg-muted-foreground/50",
};

function summary(group: DeviceGroup): { label: string; tone: Tone } {
  if (group.role === "secondary") {
    const primary = group.devices.find((d) => d.role === "primary");
    if (group.standIn.state === "active") return { label: translate("layout:deviceStatus.summary.standingIn", { name: group.primaryName }), tone: "ok" };
    if (group.primaryOnline) return { label: translate("layout:deviceStatus.summary.synced", { name: group.primaryName }), tone: "ok" };
    return { label: translate("layout:deviceStatus.summary.away", { name: group.primaryName }), tone: group.standIn.state === "waiting" || primary?.state === "connecting" ? "busy" : "away" };
  }
  const n = group.devices.length;
  const anyOnline = group.devices.some((d) => !d.self && d.state === "online");
  const label = isMac ? translate("layout:deviceStatus.summary.groupMacs", { count: n }) : translate("layout:deviceStatus.summary.groupComputers", { count: n });
  return { label, tone: anyOnline || n === 1 ? "ok" : "away" };
}

/** Sidebar footer: the device group at a glance, with the hand-off one click away. */
export function DeviceIndicator() {
  const { t } = useTranslation("layout");
  const { group, working, targets } = useHandoff();
  const { state: sidebar, isMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  if (!group?.role) return null;
  const railed = sidebar === "collapsed" && !isMobile;
  const { label, tone } = summary(group);
  const attention = group.devices.filter(needsFullDiskAccess).length;
  const hint = [label, working > 0 && t("counts.working", { count: working }), attention > 0 && t("deviceStatus.needsAttention", { count: attention })].filter(Boolean).join(" · ");

  const trigger = (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label={t("deviceStatus.triggerLabel", { hint })}
        title={railed ? undefined : hint}
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground outline-none transition-colors",
          "hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground",
          "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:self-center group-data-[collapsible=icon]:px-0",
        )}
      >
        <span className="relative shrink-0">
          <Laptop className="size-4" aria-hidden />
          <span className={cn("absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-sidebar", attention > 0 && tone === "ok" ? "bg-warning" : DOT[tone])} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-left group-data-[collapsible=icon]:hidden">{label}</span>
        {working > 0 ? (
          <span className="shrink-0 text-[11px] text-foreground/70 tabular-nums group-data-[collapsible=icon]:hidden">{t("counts.working", { count: working })}</span>
        ) : (
          attention > 0 && <TriangleAlert className="size-3.5 shrink-0 text-warning group-data-[collapsible=icon]:hidden" aria-hidden />
        )}
      </button>
    </PopoverTrigger>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {railed ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{hint}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverContent side={railed ? "right" : "top"} align={railed ? "end" : "start"} sideOffset={8} className="w-76 overflow-hidden rounded-xl p-0">
        <GroupPopover group={group} working={working} canHandOff={targets.length > 0} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function GroupPopover({ group, working, canHandOff, onClose }: { group: DeviceGroup; working: number; canHandOff: boolean; onClose: () => void }) {
  const { t } = useTranslation("layout");
  const now = useGroupClock(group);
  const standingIn = group.role === "secondary" && group.standIn.state === "active";
  const subtitle =
    group.role === "primary"
      ? t("deviceStatus.isPrimary", { name: thisDevice() })
      : standingIn
        ? t("deviceStatus.standsIn", { device: thisDevice(), name: group.primaryName })
        : t("deviceStatus.isPrimary", { name: group.primaryName });
  return (
    <>
      <div className="px-3 pt-3 pb-1.5">
        <p className="text-[13px] font-medium">{t("deviceStatus.group")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <ul className="pb-1.5">
        {group.devices.map((d) => (
          <PopoverDevice key={d.id ?? "primary"} device={d} group={group} now={now} onClose={onClose} />
        ))}
      </ul>
      {canHandOff && (
        <div className="border-t px-3 py-3">
          <HandoffButton stacked size="sm" variant="outline" className={working > 0 ? "[&>svg]:text-brand" : undefined} />
        </div>
      )}
      <Link
        to="/settings/devices"
        onClick={onClose}
        className="flex h-9 items-center gap-2.5 border-t bg-muted/40 px-3 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
      >
        <Settings2 className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t("deviceStatus.manage")}</span>
        <ArrowRight className="size-3.5 shrink-0" aria-hidden />
      </Link>
    </>
  );
}

function PopoverDevice({ device: d, group, now, onClose }: { device: GroupDevice; group: DeviceGroup; now: number; onClose: () => void }) {
  const { t } = useTranslation("layout");
  const navigate = useNavigate();
  const online = deviceState(d, group) === "online";
  const standing = isStandingIn(d, group);
  const roles = [d.self && thisDevice(), d.role === "primary" && t("deviceStatus.primary")].filter(Boolean).join(" · ");
  const work = d.activeRuns > 0 ? t("counts.working", { count: d.activeRuns }) : null;
  return (
    <li className="flex gap-2.5 px-3 py-1.5">
      <DeviceIcon device={d} className={cn("mt-0.5 size-4 shrink-0", online ? "text-foreground/80" : "text-muted-foreground/60")} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5">
          <span className="truncate font-medium">{d.name}</span>
          {roles && <span className="shrink-0 text-[11px] text-muted-foreground">{roles}</span>}
        </p>
        <p className="flex items-center gap-1.5 text-[11.5px] leading-4 text-muted-foreground">
          <DeviceDot device={d} group={group} />
          <span className="truncate tabular-nums">
            <span className={cn(standing && "font-medium text-brand-strong")}>{deviceStateLine(d, group, now)}</span>
            {work && ` · ${work}`}
          </span>
        </p>
        {(needsFullDiskAccess(d) || d.runnerTwin) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {needsFullDiskAccess(d) && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  navigate("/settings/devices");
                }}
                className="inline-flex h-5 items-center gap-1 rounded-[5px] border border-warning/30 bg-warning/[0.07] px-1.5 text-[11px] font-medium text-warning outline-none transition-colors hover:bg-warning/[0.13] focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <TriangleAlert className="size-3" aria-hidden />
                {t("deviceStatus.needsFullDisk")}
              </button>
            )}
            {d.runnerTwin && <span className="text-[11px] text-muted-foreground">{t("deviceStatus.alsoRunner")}</span>}
          </div>
        )}
      </div>
    </li>
  );
}
