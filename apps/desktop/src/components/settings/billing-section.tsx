import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Activity, Cloud, CreditCard, ExternalLink, FileDown, Gauge, Receipt, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import type { CloudBilling, CloudInvoice, CloudSubscriptionStatus, CloudUiContext, UsageSummary } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDuration, formatTokens } from "@/components/runs/run-status";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { dateLocale, intlLocale, t as translate } from "@/i18n";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CloudLinkDialog, isLinked, useCloudStatus } from "./cloud-link-dialog";
import { ToneBadge } from "./cloud-section";
import { Callout, InfoRow, SectionHeading, Segmented, SettingsGroup } from "./settings-kit";

/** Billing always renders a complete, calm state: Godmode works without an account, and the cloud may be unreachable. */
export function BillingSection() {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-5">
      <SectionHeading title={t("billing.title")} description={t("billing.description")} />
      {cloudContext ? <RemoteBilling cloud={cloudContext} /> : <CloudPlan />}
      <UsageCard />
    </div>
  );
}

/** Cloud mode: the plan lives in the cloud, and the computer never asks the cloud about it on this path. */
function RemoteBilling({ cloud }: { cloud: CloudUiContext }) {
  const { t } = useTranslation("settings");
  return (
    <Callout>
      {t("billing.remote")}
      {cloud.role === "owner" && (
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild>
            <a href={cloud.billing}>
              <CreditCard /> {t("billing.openBilling")}
            </a>
          </Button>
        </div>
      )}
    </Callout>
  );
}

function CloudPlan() {
  const { t } = useTranslation("settings");
  const status = useCloudStatus();
  const s = status.data;
  const linked = !!s && isLinked(s);
  const billing = useQuery({ queryKey: qk.cloudBilling, queryFn: api.cloud.billing, enabled: linked, retry: false });

  if (!s && status.isError) {
    return (
      <SettingsGroup title={t("billing.plan.title")} icon={<CreditCard />}>
        <LoadError title={t("cloud.loadError")} error={status.error} onRetry={() => status.refetch()} />
      </SettingsGroup>
    );
  }
  if (!s || billing.isLoading) return <GroupSkeleton />;
  // 409: the link went away between the two requests.
  const notLinked = billing.error instanceof ApiRequestError && billing.error.status === 409;
  if (!linked || notLinked) return <UnlinkedBilling defaultUrl={s.defaultUrl} />;
  if (!billing.data) {
    return (
      <SettingsGroup title={t("billing.plan.title")} icon={<CreditCard />}>
        <LoadError title={t("billing.plan.loadError")} error={billing.error} onRetry={() => billing.refetch()} />
        {s.url && (
          <div className="py-4">
            <Button variant="outline" size="sm" onClick={() => void openExternal(`${s.url}/billing`)}>
              <ExternalLink /> {t("billing.plan.openInBrowser")}
            </Button>
          </div>
        )}
      </SettingsGroup>
    );
  }
  const b = billing.data;
  return (
    <>
      <PlanGroup billing={b} email={s.account?.email ?? null} />
      <UsageMeters billing={b} />
      {b.billingEnabled && <Invoices invoices={b.invoices} />}
    </>
  );
}

function UnlinkedBilling({ defaultUrl }: { defaultUrl: string }) {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const [linking, setLinking] = useState(false);
  return (
    <>
      <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="p-6">
          <p className="eyebrow">{t("billing.unlinked.eyebrow")}</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">Godmode Cloud</h3>
          <p className="mt-1.5 max-w-lg text-sm text-muted-foreground">{t("billing.unlinked.body")}</p>
          {/* With a default cloud the link starts right here; otherwise the Cloud section asks for the address. */}
          <Button className="mt-5" onClick={() => (defaultUrl ? setLinking(true) : navigate("/settings/cloud"))}>
            <Cloud /> {t("cloud.hero.connect")}
          </Button>
        </div>
      </section>
      <Callout tone="muted">
        <Trans
          t={t}
          i18nKey="billing.unlinked.license"
          components={{ link: <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => navigate("/settings/license")} /> }}
        />
      </Callout>
      {defaultUrl && <CloudLinkDialog open={linking} onOpenChange={setLinking} />}
    </>
  );
}

const SUBSCRIPTION = {
  trialing: { labelKey: "billing.sub.trialing", tone: "live" },
  active: { labelKey: "billing.sub.active", tone: "live" },
  past_due: { labelKey: "billing.sub.pastDue", tone: "warning" },
  canceled: { labelKey: "billing.sub.canceled", tone: "neutral" },
  unpaid: { labelKey: "billing.sub.unpaid", tone: "warning" },
  incomplete: { labelKey: "billing.sub.incomplete", tone: "warning" },
  incomplete_expired: { labelKey: "billing.sub.expired", tone: "neutral" },
  paused: { labelKey: "billing.sub.paused", tone: "neutral" },
} as const satisfies Record<CloudSubscriptionStatus, { labelKey: string; tone: "live" | "neutral" | "warning" }>;

function PlanGroup({ billing, email }: { billing: CloudBilling; email: string | null }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"cancel" | "resume" | null>(null);
  const sub = billing.subscription;
  const live = !!sub && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due");
  const end = sub?.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null;
  const money = sub?.amount != null && sub.currency ? formatMoney(sub.amount, sub.currency) : null;
  const price = money && sub?.interval ? t(sub.interval === "year" ? "billing.plan.perYear" : "billing.plan.perMonth", { price: money }) : money;

  const change = useMutation({
    mutationFn: (action: "cancel" | "resume") => (action === "cancel" ? api.cloud.cancel() : api.cloud.resume()),
    onSuccess: (next, action) => {
      qc.setQueryData(qk.cloudBilling, next);
      toast.success(action === "cancel" ? t("billing.plan.cancelled") : t("billing.plan.resumed"));
    },
    onError: (e, action) => toastApiError(e, action === "cancel" ? t("billing.plan.cancelError") : t("billing.plan.resumeError"), qc),
  });

  const badge = !billing.billingEnabled ? (
    <ToneBadge tone="live">{t("billing.plan.included")}</ToneBadge>
  ) : sub ? (
    sub.cancelAtPeriodEnd && live && end ? (
      <ToneBadge tone="warning">{t("billing.plan.ends", { date: end })}</ToneBadge>
    ) : (
      <ToneBadge tone={SUBSCRIPTION[sub.status]?.tone ?? "neutral"}>{SUBSCRIPTION[sub.status] ? t(SUBSCRIPTION[sub.status].labelKey) : sub.status}</ToneBadge>
    )
  ) : undefined;

  return (
    <SettingsGroup title={t("billing.plan.title")} icon={<CreditCard />} description={email ? t("billing.plan.account", { email }) : undefined} actions={badge}>
      <InfoRow label={t("cloud.status.plan")}>{billing.plan.name}</InfoRow>
      {!billing.billingEnabled ? (
        <div className="py-4">
          <Callout>{t("billing.plan.allIncluded")}</Callout>
        </div>
      ) : (
        <>
          {price && (
            <InfoRow label={t("billing.plan.price")} mono>
              {price}
            </InfoRow>
          )}
          {sub?.status === "trialing" && sub.trialEnd ? (
            <InfoRow label={t("billing.plan.trialEnds")}>{formatDate(sub.trialEnd)}</InfoRow>
          ) : live && end ? (
            <InfoRow label={sub.cancelAtPeriodEnd ? t("billing.plan.endsOn") : t("billing.plan.renewsOn")}>{end}</InfoRow>
          ) : null}
          <div className="space-y-3 py-4">
            {!live && (
              <p className="text-xs text-muted-foreground">{t("billing.plan.upgrade")}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void openExternal(billing.urls.billing)}>
                <ExternalLink /> {live ? t("billing.plan.manage") : t("billing.plan.see")}
              </Button>
              {live && !sub.cancelAtPeriodEnd && (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirm("cancel")} disabled={change.isPending}>
                  {t("billing.plan.cancelEllipsis")}
                </Button>
              )}
              {live && sub.cancelAtPeriodEnd && (
                <Button size="sm" onClick={() => setConfirm("resume")} disabled={change.isPending}>
                  {change.isPending && <Spinner />} {t("billing.plan.resume")}
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "cancel" ? t("billing.confirm.cancelTitle") : t("billing.confirm.resumeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "cancel"
                ? end
                  ? t("billing.confirm.cancelUntil", { date: end })
                  : t("billing.confirm.cancelPeriod")
                : end
                  ? price
                    ? t("billing.confirm.resumeOnAt", { date: end, price })
                    : t("billing.confirm.resumeOn", { date: end })
                  : price
                    ? t("billing.confirm.resumeAt", { price })
                    : t("billing.confirm.resume")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{confirm === "cancel" ? t("billing.confirm.keep") : t("billing.confirm.notNow")}</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "cancel" ? "destructive" : "default"} onClick={() => confirm && change.mutate(confirm)}>
              {confirm === "cancel" ? t("billing.confirm.cancel") : t("billing.plan.resume")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

function UsageMeters({ billing }: { billing: CloudBilling }) {
  const { t } = useTranslation("settings");
  const u = billing.usage;
  const gb = billing.plan.limits.relayGbPerMonth;
  return (
    <SettingsGroup title={t("billing.meters.title")} icon={<Gauge />} description={`${formatDate(u.periodStart)} – ${formatDate(u.periodEnd)}`}>
      <Meter label={t("devices.group.computers")} used={u.devices.used} limit={u.devices.limit} format={String} />
      <Meter label={t("billing.meters.relay")} used={u.relayBytes.used} limit={u.relayBytes.limit} format={formatBytes} limitLabel={gb != null ? t("vms.tart.gb", { size: gb }) : undefined} />
    </SettingsGroup>
  );
}

function Meter({
  label,
  used,
  limit,
  format: show,
  limitLabel,
}: {
  label: string;
  used: number;
  limit: number | null;
  format: (n: number) => string;
  limitLabel?: string;
}) {
  const { t } = useTranslation("settings");
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return (
    <div className="space-y-2 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{show(used)}</span>
          {limit != null ? ` ${t("billing.meters.of", { limit: limitLabel ?? show(limit) })}` : ` · ${t("billing.meters.noLimit")}`}
        </span>
      </div>
      {pct !== null && (
        <Progress
          value={pct}
          aria-label={t("billing.meters.used", { label, percent: pct })}
          className={cn(
            "h-1 bg-foreground/[0.07]",
            pct >= 90 ? "[&>[data-slot=progress-indicator]]:bg-warning" : "[&>[data-slot=progress-indicator]]:bg-brand",
          )}
        />
      )}
    </div>
  );
}

function Invoices({ invoices }: { invoices: CloudInvoice[] }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <SettingsGroup title={t("billing.invoices.title")} icon={<Receipt />} bodyClassName="px-0">
      {invoices.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">{t("billing.invoices.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <TableHeader className="bg-paper-2">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">{t("billing.invoices.invoice")}</TableHead>
              <TableHead className="hidden @md:table-cell">{t("computer.cua.status")}</TableHead>
              <TableHead className="text-right">{t("billing.invoices.amount")}</TableHead>
              <TableHead className="w-0 pr-5">
                <span className="sr-only">{t("common:actions.open")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell className="pl-5">
                  <span className="block font-mono text-xs">{inv.number ?? "—"}</span>
                  <span className="block text-xs text-muted-foreground">{formatDate(inv.date)}</span>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground capitalize @md:table-cell">{inv.status.replace(/_/g, " ")}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{formatMoney(inv.total, inv.currency)}</TableCell>
                <TableCell className="pr-5">
                  <div className="flex justify-end gap-0.5">
                    {inv.url && (
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("billing.invoices.open", { number: inv.number ?? "" })} onClick={() => void openExternal(inv.url!)}>
                        <ExternalLink />
                      </Button>
                    )}
                    {inv.pdf && (
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("billing.invoices.download", { number: inv.number ?? "" })} onClick={() => void openExternal(inv.pdf!)}>
                        <FileDown />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
      )}
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------ */
/* Usage on this computer                                               */
/* ------------------------------------------------------------------ */

const RANGES = ["7", "30", "90"] as const;
type Range = (typeof RANGES)[number];

function UsageCard() {
  const { t } = useTranslation("settings");
  const [range, setRange] = useState<Range>("30");
  const days = Number(range);
  // The answer carries its own range, so the chart never draws old data against a new range while loading.
  const usage = useQuery({
    queryKey: qk.usage(days),
    queryFn: () => api.usage(days).then((summary) => ({ days, summary })),
    placeholderData: keepPreviousData,
  });
  const data = usage.data;

  return (
    <SettingsGroup
      title={t("billing.usage.title")}
      icon={<Activity />}
      description={t("billing.usage.description")}
      actions={
        <Segmented
          value={range}
          onChange={setRange}
          aria-label={t("billing.usage.period")}
          options={RANGES.map((r) => ({ value: r, label: <span className="normal-case">{t("billing.usage.days", { count: Number(r) })}</span> }))}
        />
      }
    >
      {!data && usage.isError ? (
        <LoadError title={t("billing.usage.loadError")} error={usage.error} onRetry={() => usage.refetch()} />
      ) : !data ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className={cn("divide-y transition-opacity", usage.isPlaceholderData && "opacity-60")}>
          <UsageStats usage={data.summary} />
          <RunsChart usage={data.summary} days={data.days} />
        </div>
      )}
    </SettingsGroup>
  );
}

function UsageStats({ usage: u }: { usage: UsageSummary }) {
  const { t } = useTranslation("settings");
  const input = u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite;
  return (
    <div className="grid grid-cols-3 gap-x-6 gap-y-4 py-4">
      <Stat label={t("billing.usage.runs")} value={u.runs.toLocaleString(intlLocale())} />
      <Stat label={t("billing.usage.time")} value={u.durationMs ? formatDuration(u.durationMs) : "0s"} />
      <Stat label={t("billing.usage.tokens")} value={formatTokens(input + u.tokens.output)} hint={t("billing.usage.tokensHint", { input: formatTokens(input), output: formatTokens(u.tokens.output) })} />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg leading-tight font-medium tracking-[-0.02em] tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Runs per day as thin bars on a shared baseline; hovering (or tapping) a day shows its numbers above the chart. */
function RunsChart({ usage, days }: { usage: UsageSummary; days: number }) {
  const { t } = useTranslation("settings");
  const [active, setActive] = useState<number | null>(null);
  const bars = useMemo(() => dayBars(usage, days), [usage, days]);
  const max = Math.max(1, ...bars.map((b) => b.runs));
  const shown = active !== null ? bars[active] : null;
  if (bars.length === 0) return null;

  return (
    <div className="py-4">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{shown ? formatDay(shown.day) : t("billing.chart.perDay")}</span>
        <span className="tabular-nums">{shown ? t("billing.chart.runs", { count: shown.runs }) : t("billing.chart.upTo", { max })}</span>
      </div>
      <div
        role="img"
        aria-label={t("billing.chart.label", { days, total: usage.runs, max })}
        className={cn("mt-3 flex h-28 items-end border-b border-foreground/10", days > 30 ? "gap-px" : "gap-0.5")}
        onPointerLeave={() => setActive(null)}
      >
        {bars.map((b, i) => (
          <div key={b.day} className="flex h-full min-w-0 flex-1 items-end" onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)}>
            <div
              className={cn(
                "w-full transition-opacity",
                days > 30 ? "rounded-t-[1.5px]" : "rounded-t-[4px]",
                b.runs ? "bg-chart-1" : "bg-foreground/[0.08]",
                active !== null && active !== i && "opacity-45",
              )}
              style={{ height: b.runs ? `${Math.max(4, (b.runs / max) * 100)}%` : "2px" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{formatDay(bars[0].day)}</span>
        <span>{formatDay(bars[bars.length - 1].day)}</span>
      </div>
    </div>
  );
}

/** One bar per calendar day of the range, including days without runs (the summary lists only days with some). */
function dayBars(usage: UsageSummary, days: number): { day: string; runs: number }[] {
  const byDay = new Map(usage.byDay.map((d) => [d.day, d]));
  const keys = new Set(byDay.keys());
  const end = new Date(usage.to).getTime();
  if (Number.isFinite(end)) for (let i = 0; i < days; i++) keys.add(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return [...keys]
    .sort()
    .slice(-days)
    .map((day) => ({ day, runs: byDay.get(day)?.runs ?? 0 }));
}

/* ------------------------------------------------------------------ */
/* Bits                                                                 */
/* ------------------------------------------------------------------ */

function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="py-4 text-sm">
      <p className="font-medium text-destructive">{title}</p>
      <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        <RefreshCw /> {t("actions.tryAgain")}
      </Button>
    </div>
  );
}

function GroupSkeleton() {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-4 w-56" />
    </div>
  );
}

/** Amounts arrive in the currency's minor unit (cents; none for JPY). */
function formatMoney(minor: number, currency: string): string {
  try {
    const fmt = new Intl.NumberFormat(intlLocale(), { style: "currency", currency: currency.toUpperCase() });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format(d, translate("settings:billing.dateFormat"), { locale: dateLocale() });
}

/** "2026-10-04" → "Oct 4" (a calendar day, not a moment: read as local midnight). */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : format(d, translate("settings:billing.dayFormat"), { locale: dateLocale() });
}
