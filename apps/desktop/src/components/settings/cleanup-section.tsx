import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { motion } from "motion/react";
import { ArrowDown, ArrowUpRight, BroomSparkles, CalendarClock, CircleAlert, CircleArrowDown, CircleCheck, CircleX, FolderOpen, HardDrive, RefreshCw, Stethoscope } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { CleanupReport, HealthCheck, Settings, StorageArea } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDoctor } from "@/components/onboarding/doctor-checklist";
import { api, errorMessage } from "@/lib/api";
import { dateLocale, t as translate } from "@/i18n";
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
  return useQuery({ queryKey: qk.cleanup, queryFn: () => api.cleanup.report(), staleTime: 60_000 });
}

/** Renders without the settings document too (see STANDALONE in the settings page): only the automatic cleanup needs it. */
export function CleanupSection({ settings }: { settings: Settings | undefined }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const report = useCleanupReport();
  // Asked for by hand: the database is checked again too, not only the folders.
  const rescan = useMutation({
    mutationFn: () => api.cleanup.report(true),
    onSuccess: (fresh) => qc.setQueryData(qk.cleanup, fresh),
    onError: (e) => toast.error(t("cleanup.scanError"), { description: errorMessage(e) }),
  });
  const scanning = report.isFetching || rescan.isPending;
  return (
    <div className="space-y-5">
      <SectionHeading title={t("cleanup.title")} description={t("cleanup.description")} />
      {report.isError ? (
        <div className="rounded-xl border border-destructive/25 bg-destructive/[0.05] p-5 text-sm">
          <p className="font-medium text-destructive">{t("cleanup.scanError")}</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(report.error)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => report.refetch()}>
            <RefreshCw /> {t("common:actions.tryAgain")}
          </Button>
        </div>
      ) : (
        <StorageCard report={report.data} scanning={scanning} onScan={() => rescan.mutate()} />
      )}
      <SelfCheck report={report.data} failed={report.isError} rescan={rescan} />
      {report.data ? <CleanupItems report={report.data} refreshing={scanning} /> : !report.isError && <ItemsSkeleton />}
      <SettingsGroup title={t("cleanup.files.title")} description={t("cleanup.files.description")} icon={<FolderOpen />}>
        <SettingRow label={t("files.title")} description={t("cleanup.files.label")}>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/files">
              {t("cleanup.files.open")} <ArrowUpRight />
            </Link>
          </Button>
        </SettingRow>
      </SettingsGroup>
      {settings && <AutoCleanup settings={settings} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

function StorageCard({ report, scanning, onScan }: { report: CleanupReport | undefined; scanning: boolean; onScan: () => void }) {
  const { t } = useTranslation("settings");
  const used = report?.storage.reduce((n, s) => n + s.bytes, 0) ?? 0;
  const reclaim = report?.items.filter((i) => i.recommended && i.count && !i.blocked).reduce((n, i) => n + i.bytes, 0) ?? 0;
  const last = report?.lastRun;
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow flex items-center gap-1.5">
              <HardDrive className="size-3.5" /> {t("cleanup.storage.title")}
            </div>
            {report ? (
              <motion.div key={used} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="mt-2 flex items-baseline gap-2">
                <span className="text-[34px] leading-none font-medium tracking-[-0.04em] tabular-nums">{formatBytes(used)}</span>
                <span className="text-sm text-muted-foreground">{t("cleanup.storage.used")}</span>
              </motion.div>
            ) : (
              <Skeleton className="mt-2 h-9 w-48" />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {report ? (
                <>
                  {report.disk && `${t("cleanup.storage.disk", { free: formatBytes(report.disk.freeBytes), total: formatBytes(report.disk.totalBytes) })} · `}
                  {t("cleanup.storage.checked", { time: formatDistanceToNow(new Date(report.checkedAt), { addSuffix: true, locale: dateLocale() }) })}
                </>
              ) : (
                t("cleanup.storage.looking")
              )}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onScan} disabled={scanning}>
            {scanning ? <Spinner /> : <RefreshCw />} {scanning ? t("cleanup.storage.scanning") : t("cleanup.storage.scanAgain")}
          </Button>
        </div>
        {report ? <StorageBar report={report} used={used} /> : <Skeleton className="h-2.5 w-full rounded-full" />}
      </div>
      {report && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-paper-2/60 px-5 py-3 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <BroomSparkles className="size-3.5 text-brand-strong" />
            {reclaim ? t("cleanup.storage.reclaim", { size: formatBytes(reclaim) }) : t("cleanup.storage.nothing")}
          </span>
          {last && (
            <span className="text-muted-foreground">
              {t(last.automatic ? "cleanup.storage.lastAuto" : "cleanup.storage.last", {
                time: formatDistanceToNow(new Date(last.finishedAt), { addSuffix: true, locale: dateLocale() }),
                size: formatBytes(last.freedBytes),
              })}
            </span>
          )}
        </div>
      )}
    </motion.section>
  );
}

function StorageBar({ report, used }: { report: CleanupReport; used: number }) {
  const { t } = useTranslation("settings");
  const percent = (bytes: number) => (used ? (bytes / used) * 100 : 0);
  const share = (bytes: number) => {
    const p = percent(bytes);
    return p >= 1 ? `${Math.round(p)}%` : "<1%";
  };
  return (
    <div className="space-y-3.5">
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label={t("cleanup.storage.byArea")}>
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

const TONE = {
  ok: { icon: CircleCheck, cls: "text-success", labelKey: "cleanup.tone.ok" },
  warn: { icon: CircleAlert, cls: "text-warning", labelKey: "cleanup.tone.warn" },
  error: { icon: CircleX, cls: "text-destructive", labelKey: "cleanup.tone.error" },
  update: { icon: CircleArrowDown, cls: "text-brand-strong", labelKey: "cleanup.tone.update" },
} as const satisfies Record<Tone, { icon: typeof CircleCheck; cls: string; labelKey: string }>;

interface Check {
  id: string;
  name: string;
  tone: Tone;
  detail: string;
  action?: ReactNode;
}

function OpenSystem() {
  const { t } = useTranslation("common");
  return (
    <Button asChild size="xs" variant="outline">
      <Link to="/settings/system">
        {t("actions.open")} <ArrowUpRight />
      </Link>
    </Button>
  );
}

const unknown = (id: string, name: string): Check => ({ id, name, tone: "warn", detail: translate("settings:cleanup.check.unknown") });

function SelfCheck({
  report,
  failed,
  rescan,
}: {
  report: CleanupReport | undefined;
  /** The report couldn't be loaded: its checks are left out (the error is shown above). */
  failed: boolean;
  rescan: UseMutationResult<CleanupReport, Error, void>;
}) {
  const { t } = useTranslation("settings");
  const doctor = useDoctor();
  const permissions = usePermissions();
  const updates = useToolUpdates();
  const openSystem = <OpenSystem />;

  // null = still being checked.
  const tools = (): Check | null => {
    const name = t("cleanup.check.tools");
    if (!doctor.data) return doctor.isError ? unknown("tools", name) : null;
    const broken = doctor.data.dependencies.filter((d) => d.required && !d.ok);
    if (!broken.length) return { id: "tools", name, tone: "ok", detail: t("cleanup.check.toolsReady", { count: doctor.data.dependencies.filter((d) => d.ok).length }) };
    return { id: "tools", name, tone: "error", detail: t("cleanup.check.toolsBroken", { count: broken.length, names: broken.map((d) => d.name).join(", ") }), action: openSystem };
  };
  const allowed = (): Check | null => {
    const name = t("system.permissions.title");
    if (!permissions.data) return permissions.isError ? unknown("permissions", name) : null;
    const missing = permissions.data.permissions.filter((p) => !p.ok);
    if (!missing.length) return { id: "permissions", name, tone: "ok", detail: t("system.perm.allAllowed") };
    return {
      id: "permissions",
      name,
      tone: missing.some((p) => p.required) ? "error" : "warn",
      detail: t("cleanup.check.needAttention", { count: missing.length }),
      action: openSystem,
    };
  };
  const upToDate = (): Check | null => {
    const name = t("system.updates.title");
    if (!updates.data) return updates.isError ? unknown("updates", name) : null;
    if (!updates.due.length) return { id: "updates", name, tone: "ok", detail: t("system.updates.allUpToDate") };
    const updating = updates.update.isPending && updates.update.variables === undefined;
    return {
      id: "updates",
      name,
      tone: "update",
      detail: updates.due.map((tool) => `${tool.name} ${tool.latest ?? ""}`.trim()).join(", "),
      action: (
        <Button size="xs" onClick={() => updates.update.mutate(undefined)} disabled={updates.update.isPending}>
          {updating ? <Spinner className="size-3" /> : <ArrowDown />} {updating ? t("system.updates.updating") : t("system.updates.update")}
        </Button>
      ),
    };
  };
  const folder: (Check | null)[] = report ? report.checks.map((c) => ({ id: c.id, name: c.name, tone: c.status, detail: c.detail })) : failed ? [] : [null, null, null];
  const checks = [tools(), allowed(), upToDate(), ...folder];

  const known = checks.filter((c): c is Check => !!c);
  const problems = known.filter((c) => c.tone === "warn" || c.tone === "error").length;
  const recheck = () => {
    doctor.refresh.mutate();
    void permissions.refetch();
    updates.check.mutate();
    rescan.mutate();
  };
  const busy = doctor.refresh.isPending || permissions.isFetching || updates.check.isPending || rescan.isPending;

  return (
    <SettingsGroup
      title={
        <span className="flex items-center gap-2">
          {t("cleanup.check.title")}
          {known.length === checks.length && (
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", problems ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
              {problems ? t("cleanup.check.needLook", { count: problems }) : t("cleanup.check.allGood")}
            </span>
          )}
        </span>
      }
      icon={<Stethoscope />}
      description={t("cleanup.check.description")}
      bodyClassName="py-4"
      actions={
        <Button size="sm" variant="ghost" onClick={recheck} disabled={busy}>
          {busy ? <Spinner /> : <RefreshCw />} {t("system.perm.recheck")}
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
  const { t } = useTranslation("settings");
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
      <Icon className={cn("size-5 shrink-0", tone.cls)} aria-label={t(tone.labelKey)} />
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
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  return (
    <SettingsGroup title={t("cleanup.auto.title")} icon={<CalendarClock />} description={t("cleanup.auto.description")}>
      <SettingRow
        label={t("cleanup.auto.label")}
        description={t("cleanup.auto.labelDescription")}
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
