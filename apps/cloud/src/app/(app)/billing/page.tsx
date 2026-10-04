import type { Metadata } from "next";
import type { CloudInvoice, CloudSubscription } from "@godmode/shared";
import { CreditCard, Gauge, PartyPopper, Receipt, Sparkles } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { Meter, StatusBadge, type BadgeTone } from "@/components/data-display";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page";
import { Callout, InfoRow, SettingsGroup } from "@/components/settings-kit";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { getEntitlements, LIVE_STATUSES } from "@/server/billing/entitlements";
import { listPlans } from "@/server/billing/plans";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { getBillingOverview } from "@/server/usage";
import { CancelButton, PortalButton, ResumeButton } from "./_components/billing-buttons";
import { PlanPicker, type PickerPlan } from "./_components/plan-picker";

export const metadata: Metadata = { title: "Billing" };

const LIVE: readonly string[] = LIVE_STATUSES;

/** Plans are sold in GB of 10^9 bytes, so the meter prints decimal units ("1.2 GB of 100 GB"). */
function decimalBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1 })} ${units[unit]}`;
}

function statusBadge(sub: CloudSubscription): { tone: BadgeTone; label: string } {
  if (sub.status === "past_due" || sub.status === "unpaid") return { tone: "danger", label: "Payment overdue" };
  if (sub.cancelAtPeriodEnd && LIVE.includes(sub.status)) return { tone: "warning", label: "Ends soon" };
  if (sub.status === "trialing") return { tone: "info", label: "Trial" };
  if (sub.status === "active") return { tone: "positive", label: "Active" };
  if (sub.status === "paused") return { tone: "warning", label: "Paused" };
  if (sub.status === "incomplete") return { tone: "warning", label: "Payment not finished" };
  return { tone: "neutral", label: "Ended" };
}

const INVOICE_STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  paid: { tone: "positive", label: "Paid" },
  open: { tone: "warning", label: "Open" },
  uncollectible: { tone: "danger", label: "Unpaid" },
  void: { tone: "neutral", label: "Void" },
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [ctx, query] = await Promise.all([requireUser(), searchParams]);
  const [overview, entitlements, general] = await Promise.all([getBillingOverview(ctx.user), getEntitlements(ctx.user.id), getSettings("general")]);
  const canManage = can(ctx, "billing.self");
  const checkout = query.checkout === "success" || query.checkout === "canceled" ? query.checkout : null;
  const invoiceId = typeof query.invoice === "string" ? query.invoice : null;

  const { usage } = overview;
  const usageGroup = (
    <SettingsGroup
      icon={<Gauge />}
      title="Usage this month"
      description="Computers shared with you use their owner's plan."
      bodyClassName="divide-y-0"
    >
      <div className="grid grid-cols-1 gap-x-10 gap-y-5 py-5 @2xl:grid-cols-2">
        <Meter
          label="Computers"
          value={usage.devices.used}
          max={usage.devices.limit}
          hint={usage.devices.limit === null ? "Link as many as you like." : "Linked to your account."}
        />
        <Meter
          label="Relay traffic"
          value={usage.relayBytes.used}
          max={usage.relayBytes.limit}
          valueLabel={
            usage.relayBytes.limit === null
              ? `${decimalBytes(usage.relayBytes.used)} · Unlimited`
              : `${decimalBytes(usage.relayBytes.used)} of ${decimalBytes(usage.relayBytes.limit)}`
          }
          hint={`${formatNumber(usage.requests)} request${usage.requests === 1 ? "" : "s"} relayed. Resets on ${formatDate(usage.periodEnd, "date", { timeZone: "UTC" })}.`}
        />
      </div>
    </SettingsGroup>
  );

  if (!overview.billingEnabled) {
    return (
      <>
        <PageHeader icon={<CreditCard />} title="Billing" description="Your plan, what you used this month, and your invoices." />
        <PageBody>
          <EmptyState
            icon={<Sparkles />}
            title="Everything is included"
            description="This cloud does not sell plans. Your account can link any number of computers, relay without a limit and share computers, with nothing to pay."
          />
          {usageGroup}
        </PageBody>
      </>
    );
  }

  const sub = overview.subscription;
  const row = entitlements.subscription;
  const live = Boolean(row && LIVE.includes(row.status));
  const ownerIncluded = entitlements.source === "unlimited";
  const plans = await listPlans({ publicOnly: true });
  const pickerPlans: PickerPlan[] = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    features: plan.features,
    isFree: plan.isFree,
    highlighted: plan.highlighted,
    prices: plan.isFree
      ? []
      : plan.prices.map((p) => ({ id: p.id, interval: p.interval, amount: p.amount, currency: p.currency, ready: Boolean(p.stripePriceId) })),
  }));
  const periodEnd = sub?.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null;
  const badge = sub && live ? statusBadge(sub) : null;
  // The paid plan's own name while a subscription runs, even where the entitlement differs (an owner, a grace period over).
  const paidPlanName = (live && plans.find((p) => p.id === row?.planId)?.name) || overview.plan.name;
  const waitingForStripe = checkout === "success" && !live;

  return (
    <>
      {waitingForStripe && <AutoRefresh seconds={3} />}
      <PageHeader icon={<CreditCard />} title="Billing" description="Your plan, what you used this month, and your invoices." />
      <PageBody>
        {checkout === "success" && (
          <Callout tone="success" icon={<PartyPopper className="text-brand-strong" />} title={live ? "Your subscription is active" : "Thank you — your subscription is being activated"} role="status">
            {live
              ? "Everything in your plan is available now. The receipt is on its way by e-mail."
              : "Stripe confirms the payment in a few seconds. This page updates by itself."}
          </Callout>
        )}
        {checkout === "canceled" && (
          <Callout tone="muted" title="Checkout was cancelled" role="status">
            Nothing was charged and your plan is unchanged.
          </Callout>
        )}
        {overview.notice && (
          <Callout tone="warning" title="Stripe can't be reached right now">
            {overview.notice}
          </Callout>
        )}
        {sub && live && (sub.status === "past_due" || sub.status === "unpaid") && (
          <Callout
            tone="danger"
            title="Your last payment did not go through"
            role="note"
            action={canManage && ctx.user.stripeCustomerId ? <PortalButton size="sm">Update payment method</PortalButton> : undefined}
          >
            Update your payment method to keep {paidPlanName}. Without a payment your account moves to the free plan.
          </Callout>
        )}

        <SettingsGroup
          icon={<CreditCard />}
          title="Your plan"
          description={
            ownerIncluded
              ? "As an owner of this cloud you have everything without a subscription."
              : entitlements.source === "override"
                ? "This plan was given to you by an administrator."
                : entitlements.source === "free"
                  ? "You are on the free plan."
                  : "Billed through Stripe."
          }
          actions={badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : undefined}
          footer={
            canManage && (ctx.user.stripeCustomerId || live) ? (
              <>
                {ctx.user.stripeCustomerId && <PortalButton />}
                {live && sub && (sub.cancelAtPeriodEnd ? <ResumeButton planName={paidPlanName} /> : <CancelButton planName={paidPlanName} endsOn={periodEnd} />)}
              </>
            ) : undefined
          }
        >
          <InfoRow label="Plan">
            <span className="font-medium">{overview.plan.name}</span>
          </InfoRow>
          {live && sub && sub.amount !== null && sub.currency && (
            <InfoRow label="Price" mono>
              {formatMoney(sub.amount, sub.currency)} per {sub.interval ?? "period"}
            </InfoRow>
          )}
          {live && sub?.status === "trialing" && sub.trialEnd && <InfoRow label="Trial ends">{formatDate(sub.trialEnd)}</InfoRow>}
          {live && sub && periodEnd && <InfoRow label={sub.cancelAtPeriodEnd ? "Ends on" : "Renews on"}>{periodEnd}</InfoRow>}
          {entitlements.source === "override" && (
            <InfoRow label="Given until">{ctx.user.planOverrideUntil ? formatDate(ctx.user.planOverrideUntil) : "No end date"}</InfoRow>
          )}
          {ownerIncluded && live && (
            <InfoRow label="Subscription">
              {paidPlanName} — not needed for an owner
            </InfoRow>
          )}
          {!canManage && <p className="py-3 text-xs leading-relaxed text-muted-foreground">Your role can&apos;t change the plan. Ask an administrator of this cloud.</p>}
        </SettingsGroup>

        {usageGroup}

        {(!ownerIncluded || live) && pickerPlans.length > 0 && (
          <>
            <PlanPicker
              plans={pickerPlans}
              currentPlanId={live && row?.planId ? row.planId : overview.plan.id}
              currentPriceId={live ? (row?.priceId ?? null) : null}
              subscribed={live}
              defaultInterval={sub?.interval ?? "month"}
              canManage={canManage}
            />
            {general.termsUrl && (
              <p className="-mt-2 text-xs text-muted-foreground">
                By subscribing you agree to the{" "}
                <a
                  href={general.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  Terms
                </a>
                .
              </p>
            )}
          </>
        )}

        <SettingsGroup id="invoices" icon={<Receipt />} title="Invoices" description="Receipts for what you paid, newest first." bodyClassName="px-0">
          {overview.invoices.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {overview.notice ? "Invoices could not be loaded." : "No invoices yet. They appear here after your first payment."}
            </p>
          ) : (
            <DataTable<CloudInvoice>
              bare
              caption="Invoices"
              rows={overview.invoices}
              getRowId={(invoice) => invoice.id}
              highlightId={invoiceId}
              columns={[
                { id: "number", header: "Invoice", cell: (invoice) => <span className="font-mono text-xs tabular-nums">{invoice.number ?? invoice.id}</span> },
                {
                  id: "status",
                  header: "Status",
                  card: "aside",
                  cell: (invoice) => {
                    const status = INVOICE_STATUS[invoice.status] ?? { tone: "neutral" as const, label: invoice.status };
                    return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
                  },
                },
                { id: "date", header: "Date", card: "line", cell: (invoice) => formatDate(invoice.date) },
                {
                  id: "total",
                  header: "Total",
                  card: "line",
                  mono: true,
                  align: "right",
                  cell: (invoice) => formatMoney(invoice.total, invoice.currency),
                },
                {
                  id: "links",
                  header: "Download",
                  card: "line",
                  align: "right",
                  cell: (invoice) => <InvoiceLinks invoice={invoice} />,
                },
              ]}
            />
          )}
        </SettingsGroup>
      </PageBody>
    </>
  );
}

function InvoiceLinks({ invoice }: { invoice: CloudInvoice }) {
  const cls = "rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";
  if (!invoice.url && !invoice.pdf) return <span className="text-muted-foreground">—</span>;
  const name = invoice.number ?? invoice.id;
  return (
    <span className="inline-flex items-center gap-3 pointer-coarse:py-2">
      {invoice.url && (
        <a href={invoice.url} target="_blank" rel="noopener noreferrer" className={cls} aria-label={`View invoice ${name}`}>
          View
        </a>
      )}
      {invoice.pdf && (
        <a href={invoice.pdf} target="_blank" rel="noopener noreferrer" className={cls} aria-label={`Download invoice ${name} as PDF`}>
          PDF
        </a>
      )}
    </span>
  );
}
