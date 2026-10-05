import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Activity, Cloud, CreditCard, ExternalLink, FileDown, Gauge, Receipt, RefreshCw } from "lucide-react";
import { toast } from "sonner";
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
import { formatCost, formatDuration, formatTokens } from "@/components/runs/run-status";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SITE } from "./about-section";
import { CloudLinkDialog, isLinked, useCloudStatus } from "./cloud-link-dialog";
import { ToneBadge } from "./cloud-section";
import { Callout, InfoRow, SectionHeading, Segmented, SettingsGroup } from "./settings-kit";

/** Billing always renders a complete, calm state: Godmode works without an account, and the cloud may be unreachable. */
export function BillingSection() {
  return (
    <div className="space-y-5">
      <SectionHeading title="Billing" description="Your Godmode Cloud plan, and what the agents on this computer used." />
      {cloudContext ? <RemoteBilling cloud={cloudContext} /> : <CloudPlan />}
      <UsageCard />
    </div>
  );
}

/** Cloud mode: the plan lives in the cloud, and the computer never asks the cloud about it on this path. */
function RemoteBilling({ cloud }: { cloud: CloudUiContext }) {
  return (
    <Callout>
      You are using this computer through Godmode Cloud. Plan, invoices and payment method are on the cloud's Billing page.
      {cloud.role === "owner" && (
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild>
            <a href={cloud.billing}>
              <CreditCard /> Open billing
            </a>
          </Button>
        </div>
      )}
    </Callout>
  );
}

function CloudPlan() {
  const status = useCloudStatus();
  const s = status.data;
  const linked = !!s && isLinked(s);
  const billing = useQuery({ queryKey: qk.cloudBilling, queryFn: api.cloud.billing, enabled: linked, retry: false });

  if (!s && status.isError) {
    return (
      <SettingsGroup title="Godmode Cloud plan" icon={<CreditCard />}>
        <LoadError title="Could not load the cloud link" error={status.error} onRetry={() => status.refetch()} />
      </SettingsGroup>
    );
  }
  if (!s || billing.isLoading) return <GroupSkeleton />;
  // 409: the link went away between the two requests.
  const notLinked = billing.error instanceof ApiRequestError && billing.error.status === 409;
  if (!linked || notLinked) return <UnlinkedBilling defaultUrl={s.defaultUrl} />;
  if (!billing.data) {
    return (
      <SettingsGroup title="Godmode Cloud plan" icon={<CreditCard />}>
        <LoadError title="Could not load your plan" error={billing.error} onRetry={() => billing.refetch()} />
        {s.url && (
          <div className="py-4">
            <Button variant="outline" size="sm" onClick={() => void openExternal(`${s.url}/billing`)}>
              <ExternalLink /> Open billing in the browser
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
  const navigate = useNavigate();
  const [linking, setLinking] = useState(false);
  return (
    <>
      <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="p-6">
          <p className="eyebrow">Optional add-on</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">Godmode Cloud</h3>
          <p className="mt-1.5 max-w-lg text-sm text-muted-foreground">
            Godmode works fully on this computer without an account. Godmode Cloud is an optional add-on: open this computer in any browser and reach
            it from your phone without Tailscale.
          </p>
          {/* With a default cloud the link starts right here; otherwise the Cloud section asks for the address. */}
          <Button className="mt-5" onClick={() => (defaultUrl ? setLinking(true) : navigate("/settings/cloud"))}>
            <Cloud /> Connect to Godmode Cloud
          </Button>
        </div>
      </section>
      <Callout tone="muted">
        Looking for your Godmode licence? Licences (Lifetime or Monthly) are separate from Godmode Cloud and are managed at{" "}
        <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => void openExternal(SITE)}>
          {SITE.replace(/^https?:\/\//, "")}
        </button>
        .
      </Callout>
      {defaultUrl && <CloudLinkDialog open={linking} onOpenChange={setLinking} />}
    </>
  );
}

const SUBSCRIPTION: Record<CloudSubscriptionStatus, { label: string; tone: "live" | "neutral" | "warning" }> = {
  trialing: { label: "Trial", tone: "live" },
  active: { label: "Active", tone: "live" },
  past_due: { label: "Payment due", tone: "warning" },
  canceled: { label: "Ended", tone: "neutral" },
  unpaid: { label: "Unpaid", tone: "warning" },
  incomplete: { label: "Incomplete", tone: "warning" },
  incomplete_expired: { label: "Expired", tone: "neutral" },
  paused: { label: "Paused", tone: "neutral" },
};

function PlanGroup({ billing, email }: { billing: CloudBilling; email: string | null }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"cancel" | "resume" | null>(null);
  const sub = billing.subscription;
  const live = !!sub && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due");
  const end = sub?.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null;
  const price = sub?.amount != null && sub.currency ? `${formatMoney(sub.amount, sub.currency)}${sub.interval ? ` / ${sub.interval}` : ""}` : null;

  const change = useMutation({
    mutationFn: (action: "cancel" | "resume") => (action === "cancel" ? api.cloud.cancel() : api.cloud.resume()),
    onSuccess: (next, action) => {
      qc.setQueryData(qk.cloudBilling, next);
      toast.success(action === "cancel" ? "Your plan ends with this period" : "Your plan renews again");
    },
    onError: (e, action) => toastApiError(e, action === "cancel" ? "Could not cancel the plan" : "Could not resume the plan", qc),
  });

  const badge = !billing.billingEnabled ? (
    <ToneBadge tone="live">Included</ToneBadge>
  ) : sub ? (
    sub.cancelAtPeriodEnd && live && end ? (
      <ToneBadge tone="warning">Ends {end}</ToneBadge>
    ) : (
      <ToneBadge tone={SUBSCRIPTION[sub.status]?.tone ?? "neutral"}>{SUBSCRIPTION[sub.status]?.label ?? sub.status}</ToneBadge>
    )
  ) : undefined;

  return (
    <SettingsGroup title="Godmode Cloud plan" icon={<CreditCard />} description={email ? `Account ${email}` : undefined} actions={badge}>
      <InfoRow label="Plan">{billing.plan.name}</InfoRow>
      {!billing.billingEnabled ? (
        <div className="py-4">
          <Callout>Everything is included — there is nothing to pay on this cloud.</Callout>
        </div>
      ) : (
        <>
          {price && (
            <InfoRow label="Price" mono>
              {price}
            </InfoRow>
          )}
          {sub?.status === "trialing" && sub.trialEnd ? (
            <InfoRow label="Trial ends">{formatDate(sub.trialEnd)}</InfoRow>
          ) : live && end ? (
            <InfoRow label={sub.cancelAtPeriodEnd ? "Ends on" : "Renews on"}>{end}</InfoRow>
          ) : null}
          <div className="space-y-3 py-4">
            {!live && (
              <p className="text-xs text-muted-foreground">Upgrade on the cloud's Billing page to link more computers or relay more data.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void openExternal(billing.urls.billing)}>
                <ExternalLink /> {live ? "Manage plan" : "See plans"}
              </Button>
              {live && !sub.cancelAtPeriodEnd && (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirm("cancel")} disabled={change.isPending}>
                  Cancel plan…
                </Button>
              )}
              {live && sub.cancelAtPeriodEnd && (
                <Button size="sm" onClick={() => setConfirm("resume")} disabled={change.isPending}>
                  {change.isPending && <Spinner />} Resume plan
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "cancel" ? "Cancel your Godmode Cloud plan?" : "Resume your plan?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "cancel"
                ? `It stays active${end ? ` until ${end}` : " until the end of this period"}. After that the account moves to the free plan, and computers over its limit can't be reached through the cloud. You can resume before then.`
                : `It renews${end ? ` on ${end}` : ""}${price ? ` at ${price}` : ""}, as before.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{confirm === "cancel" ? "Keep plan" : "Not now"}</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "cancel" ? "destructive" : "default"} onClick={() => confirm && change.mutate(confirm)}>
              {confirm === "cancel" ? "Cancel plan" : "Resume plan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

function UsageMeters({ billing }: { billing: CloudBilling }) {
  const u = billing.usage;
  const gb = billing.plan.limits.relayGbPerMonth;
  return (
    <SettingsGroup title="This month" icon={<Gauge />} description={`${formatDate(u.periodStart)} – ${formatDate(u.periodEnd)}`}>
      <Meter label="Computers" used={u.devices.used} limit={u.devices.limit} format={String} />
      <Meter label="Relay data" used={u.relayBytes.used} limit={u.relayBytes.limit} format={formatBytes} limitLabel={gb != null ? `${gb} GB` : undefined} />
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
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return (
    <div className="space-y-2 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{show(used)}</span>
          {limit != null ? ` of ${limitLabel ?? show(limit)}` : " · no limit"}
        </span>
      </div>
      {pct !== null && (
        <Progress
          value={pct}
          aria-label={`${label}: ${pct}% used`}
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
  return (
    <SettingsGroup title="Invoices" icon={<Receipt />} bodyClassName="px-0">
      {invoices.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">No invoices yet.</p>
      ) : (
        <table className="w-full text-sm">
          <TableHeader className="bg-paper-2">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Invoice</TableHead>
              <TableHead className="hidden @md:table-cell">Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-0 pr-5">
                <span className="sr-only">Open</span>
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
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Open invoice ${inv.number ?? ""}`} onClick={() => void openExternal(inv.url!)}>
                        <ExternalLink />
                      </Button>
                    )}
                    {inv.pdf && (
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Download invoice ${inv.number ?? ""} as PDF`} onClick={() => void openExternal(inv.pdf!)}>
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
      title="Usage on this computer"
      icon={<Activity />}
      description="What the agents here used, from this computer's own run history."
      actions={
        <Segmented
          value={range}
          onChange={setRange}
          aria-label="Period"
          options={RANGES.map((r) => ({ value: r, label: <span className="normal-case">{r} days</span> }))}
        />
      }
    >
      {!data && usage.isError ? (
        <LoadError title="Could not load usage" error={usage.error} onRetry={() => usage.refetch()} />
      ) : !data ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className={cn("divide-y transition-opacity", usage.isPlaceholderData && "opacity-60")}>
          <UsageStats usage={data.summary} />
          <RunsChart usage={data.summary} days={data.days} />
          <p className="py-3 text-xs text-muted-foreground">
            Costs are as reported by Claude Code. With a Claude subscription this is an equivalent, not a charge.
          </p>
        </div>
      )}
    </SettingsGroup>
  );
}

function UsageStats({ usage: u }: { usage: UsageSummary }) {
  const input = u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-4 @xl:grid-cols-4">
      <Stat label="Runs" value={u.runs.toLocaleString()} />
      <Stat label="Time" value={u.durationMs ? formatDuration(u.durationMs) : "0s"} />
      <Stat label="Tokens" value={formatTokens(input + u.tokens.output)} hint={`${formatTokens(input)} in · ${formatTokens(u.tokens.output)} out`} />
      <Stat label="Cost" value={formatCost(u.costUsd)} hint="Reported by Claude Code" />
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
  const [active, setActive] = useState<number | null>(null);
  const bars = useMemo(() => dayBars(usage, days), [usage, days]);
  const max = Math.max(1, ...bars.map((b) => b.runs));
  const shown = active !== null ? bars[active] : null;
  if (bars.length === 0) return null;

  return (
    <div className="py-4">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{shown ? formatDay(shown.day) : "Runs per day"}</span>
        <span className="tabular-nums">
          {shown ? `${shown.runs} ${shown.runs === 1 ? "run" : "runs"} · ${formatCost(shown.costUsd)}` : `Up to ${max} a day`}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Runs per day over the last ${days} days: ${usage.runs} in total, up to ${max} a day.`}
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
function dayBars(usage: UsageSummary, days: number): { day: string; runs: number; costUsd: number }[] {
  const byDay = new Map(usage.byDay.map((d) => [d.day, d]));
  const keys = new Set(byDay.keys());
  const end = new Date(usage.to).getTime();
  if (Number.isFinite(end)) for (let i = 0; i < days; i++) keys.add(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return [...keys]
    .sort()
    .slice(-days)
    .map((day) => ({ day, runs: byDay.get(day)?.runs ?? 0, costUsd: byDay.get(day)?.costUsd ?? 0 }));
}

/* ------------------------------------------------------------------ */
/* Bits                                                                 */
/* ------------------------------------------------------------------ */

function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <div className="py-4 text-sm">
      <p className="font-medium text-destructive">{title}</p>
      <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        <RefreshCw /> Try again
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
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() });
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
  return Number.isNaN(d.getTime()) ? iso : format(d, "MMM d, yyyy");
}

/** "2026-10-04" → "Oct 4" (a calendar day, not a moment: read as local midnight). */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : format(d, "MMM d");
}
