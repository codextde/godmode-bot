import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { motion } from "motion/react";
import { ArrowDown, ArrowUpRight, BroomSparkles, CalendarClock, CircleAlert, CircleArrowDown, CircleCheck, CircleX, HardDrive, RefreshCw, Stethoscope } from "lucide-react";
import { Link } from "react-router";
import type { CleanupReport, HealthCheck, Settings, StorageArea } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDoctor } from "@/components/onboarding/doctor-checklist";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CleanupItems } from "./cleanup-items";
import { SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";
import { usePermissions } from "./system-permissions";
import { useToolUpdates } from "./system-updates";

/** Fixed per area (never by rank), checked for color-blind separation on both surfaces. */
const AREA_COLOR: Record<StorageArea, string> = {
  agents: "bg-[#12a26a] dark:bg-[#1f9e6a]",
  browser: "bg-[#2a78d6] dark:bg-[#3987e5]",
  vms: "bg-[#eda100] dark:bg-[#c98500]",
  repos: "bg-[#6d63d9] dark:bg-[#8b7fe8]",
  database: "bg-[#e0603a] dark:bg-[#d95926]",
  other: "bg-foreground/20",
};

export function useCleanupReport() {
  return useQuery({ queryKey: qk.cleanup, queryFn: api.cleanup.report, staleTime: 60_000 });
}

/** Renders without the settings document too (see STANDALONE in the settings page): only the automatic cleanup needs it. */
export function CleanupSection({ settings }: { settings: Settings | undefined }) {
  const report = useCleanupReport();
  return (
    <div className="space-y-5">
      <SectionHeading title="Cleanup" description="A self check of Godmode's data folder, and what can go to give the space back." />
      {report.isError ? (
        <div className="rounded-xl border border-destructive/25 bg-destructive/[0.05] p-5 text-sm">
          <p className="font-medium text-destructive">Couldn't look at the data folder</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(report.error)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => report.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : (
        <StorageCard report={report.data} scanning={report.isFetching} onScan={() => report.refetch()} />
      )}
      <SelfCheck report={report.data} />
      {report.data ? <CleanupItems report={report.data} /> : !report.isError && <ItemsSkeleton />}
      {settings && <AutoCleanup settings={settings} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

function StorageCard({ report, scanning, onScan }: { report: CleanupReport | undefined; scanning: boolean; onScan: () => void }) {
  const used = report?.storage.reduce((n, s) => n + s.bytes, 0) ?? 0;
  const reclaim = report?.items.filter((i) => i.recommended && i.count && !i.blocked).reduce((n, i) => n + i.bytes, 0) ?? 0;
  const last = report?.lastRun;
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow flex items-center gap-1.5">
              <HardDrive className="size-3.5" /> Storage
            </div>
            {report ? (
              <motion.div key={used} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="mt-2 flex items-baseline gap-2">
                <span className="text-[34px] leading-none font-medium tracking-[-0.04em] tabular-nums">{formatBytes(used)}</span>
                <span className="text-sm text-muted-foreground">used by Godmode</span>
              </motion.div>
            ) : (
              <Skeleton className="mt-2 h-9 w-48" />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {report ? (
                <>
                  {report.disk && `${formatBytes(report.disk.freeBytes)} free of ${formatBytes(report.disk.totalBytes)} on this disk · `}
                  checked {formatDistanceToNow(new Date(report.checkedAt), { addSuffix: true })}
                </>
              ) : (
                "Looking through the data folder…"
              )}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onScan} disabled={scanning}>
            {scanning ? <Spinner /> : <RefreshCw />} {scanning ? "Scanning…" : "Scan again"}
          </Button>
        </div>
        {report ? <StorageBar report={report} used={used} /> : <Skeleton className="h-2.5 w-full rounded-full" />}
      </div>
      {report && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-paper-2/60 px-5 py-3 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <BroomSparkles className="size-3.5 text-brand-strong" />
            {reclaim ? `${formatBytes(reclaim)} can be freed safely` : "Nothing piles up right now"}
          </span>
          {last && (
            <span className="text-muted-foreground">
              Last cleanup {formatDistanceToNow(new Date(last.finishedAt), { addSuffix: true })}
              {last.automatic && " (automatic)"} freed {formatBytes(last.freedBytes)}
            </span>
          )}
        </div>
      )}
    </motion.section>
  );
}

function StorageBar({ report, used }: { report: CleanupReport; used: number }) {
  const percent = (bytes: number) => (used ? (bytes / used) * 100 : 0);
  const share = (bytes: number) => {
    const p = percent(bytes);
    return p >= 1 ? `${Math.round(p)}%` : "<1%";
  };
  return (
    <div className="space-y-3.5">
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Storage by area">
        {report.storage.map((s, i) => (
          <Tooltip key={s.area}>
            <TooltipTrigger asChild>
              <motion.div
                initial={{ flexGrow: 0 }}
                animate={{ flexGrow: s.bytes }}
                transition={{ duration: 0.6, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                style={{ flexBasis: 0, minWidth: 3 }}
                className={cn("h-full transition-opacity hover:opacity-80", AREA_COLOR[s.area])}
              />
            </TooltipTrigger>
            <TooltipContent>
              {s.name} · {formatBytes(s.bytes)} · {share(s.bytes)}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 @xl:grid-cols-3">
        {report.storage.map((s) => (
          <li key={s.area} className="flex min-w-0 items-center gap-2 text-xs">
            <span className={cn("size-2 shrink-0 rounded-full", AREA_COLOR[s.area])} />
            <span className="truncate text-foreground">{s.name}</span>
            <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{formatBytes(s.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Self check                                                           */
/* ------------------------------------------------------------------ */

type Tone = HealthCheck["status"] | "update";

const TONE: Record<Tone, { icon: typeof CircleCheck; cls: string; label: string }> = {
  ok: { icon: CircleCheck, cls: "text-success", label: "Fine" },
  warn: { icon: CircleAlert, cls: "text-warning", label: "Needs a look" },
  error: { icon: CircleX, cls: "text-destructive", label: "Problem" },
  update: { icon: CircleArrowDown, cls: "text-brand-strong", label: "Update available" },
};

interface Check {
  id: string;
  name: string;
  tone: Tone;
  detail: string;
  action?: ReactNode;
}

const openSystem = (
  <Button asChild size="xs" variant="outline">
    <Link to="/settings/system">
      Open <ArrowUpRight />
    </Link>
  </Button>
);

function SelfCheck({ report }: { report: CleanupReport | undefined }) {
  const doctor = useDoctor();
  const permissions = usePermissions();
  const updates = useToolUpdates();

  const checks: (Check | null)[] = [];
  if (doctor.data) {
    const broken = doctor.data.dependencies.filter((d) => d.required && !d.ok);
    const working = doctor.data.dependencies.filter((d) => d.ok).length;
    checks.push(
      broken.length
        ? { id: "tools", name: "Tools", tone: "error", detail: `${broken.map((d) => d.name).join(", ")} ${broken.length === 1 ? "doesn't" : "don't"} work`, action: openSystem }
        : { id: "tools", name: "Tools", tone: "ok", detail: `${working} tools ready` },
    );
  } else checks.push(null);
  if (permissions.data) {
    const missing = permissions.data.permissions.filter((p) => !p.ok);
    const required = missing.some((p) => p.required);
    checks.push(
      missing.length
        ? {
            id: "permissions",
            name: "Permissions",
            tone: required ? "error" : "warn",
            detail: `${missing.length} ${missing.length === 1 ? "needs" : "need"} attention`,
            action: openSystem,
          }
        : { id: "permissions", name: "Permissions", tone: "ok", detail: "Everything is allowed" },
    );
  } else checks.push(null);
  if (updates.data) {
    const due = updates.due;
    const updating = updates.update.isPending && updates.update.variables === undefined;
    checks.push(
      due.length
        ? {
            id: "updates",
            name: "Updates",
            tone: "update",
            detail: due.map((t) => `${t.name} ${t.latest ?? ""}`.trim()).join(", "),
            action: (
              <Button size="xs" onClick={() => updates.update.mutate(undefined)} disabled={updates.update.isPending}>
                {updating ? <Spinner className="size-3" /> : <ArrowDown />} {updating ? "Updating…" : "Update"}
              </Button>
            ),
          }
        : { id: "updates", name: "Updates", tone: "ok", detail: "Everything is up to date" },
    );
  } else checks.push(null);
  for (const c of report?.checks ?? [null, null, null]) checks.push(c && { id: c.id, name: c.name, tone: c.status, detail: c.detail });

  const known = checks.filter((c): c is Check => !!c);
  const problems = known.filter((c) => c.tone === "warn" || c.tone === "error").length;
  const recheck = () => {
    doctor.refresh.mutate();
    void permissions.refetch();
    updates.check.mutate();
  };
  const busy = doctor.refresh.isPending || permissions.isFetching || updates.check.isPending;

  return (
    <SettingsGroup
      title={
        <span className="flex items-center gap-2">
          Self check
          {known.length === checks.length && (
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", problems ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
              {problems ? `${problems} ${problems === 1 ? "needs" : "need"} a look` : "All good"}
            </span>
          )}
        </span>
      }
      icon={<Stethoscope />}
      description="Tools, permissions, updates and the data folder, checked in one go."
      bodyClassName="py-4"
      actions={
        <Button size="sm" variant="ghost" onClick={recheck} disabled={busy}>
          {busy ? <Spinner /> : <RefreshCw />} Re-check
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
        {checks.map((c, i) =>
          c ? (
            <motion.div key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <CheckTile check={c} />
            </motion.div>
          ) : (
            <Skeleton key={i} className="h-[62px] rounded-lg" />
          ),
        )}
      </div>
    </SettingsGroup>
  );
}

function CheckTile({ check }: { check: Check }) {
  const tone = TONE[check.tone];
  const Icon = tone.icon;
  return (
    <div
      className={cn(
        "flex h-full items-center gap-3 rounded-lg border bg-card px-3.5 py-3",
        check.tone === "error" && "border-destructive/25",
        check.tone === "warn" && "border-warning/25",
      )}
    >
      <Icon className={cn("size-5 shrink-0", tone.cls)} aria-label={tone.label} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{check.name}</p>
        <p className="truncate text-xs text-muted-foreground" title={check.detail}>
          {check.detail}
        </p>
      </div>
      {check.action && <div className="shrink-0">{check.action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Automatic cleanup                                                    */
/* ------------------------------------------------------------------ */

function AutoCleanup({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  return (
    <SettingsGroup title="Automatic cleanup" icon={<CalendarClock />} description="Let Godmode tidy up after itself.">
      <SettingRow
        label="Clean up automatically"
        description="Once a day, while no agent is working, Godmode removes what is recommended above — worktrees once their task has been finished for a week. The trash and VM downloads only go when you pick them."
        htmlFor="maintenance-auto-cleanup"
      >
        <Switch id="maintenance-auto-cleanup" checked={settings.maintenance.autoCleanup} onCheckedChange={(on) => patch({ maintenance: { autoCleanup: on } })} />
      </SettingRow>
    </SettingsGroup>
  );
}

function ItemsSkeleton() {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
      <Skeleton className="h-5 w-32" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded-[4px]" />
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-72" />
          </div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}
