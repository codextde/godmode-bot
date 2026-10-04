import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus, Receipt, Users } from "lucide-react";
import { StatCard, StatusBadge, type BadgeTone } from "@/components/data-display";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect, FilterSheet, ListToolbar, PAGE_SIZE, Pagination, SearchInput } from "@/components/list-controls";
import { PageBody, PageHeader } from "@/components/page";
import { Callout, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import { listPlans } from "@/server/billing/plans";
import { listSubscriptions, revenueSummary, type SubscriptionRow } from "@/server/billing/subscriptions";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { PlanRowActions } from "./_components/plan-row-actions";
import { limitsSummary, stripeState } from "./_lib/plan-view";

export const metadata: Metadata = { title: "Billing" };

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "positive" },
  trialing: { label: "Trial", tone: "info" },
  past_due: { label: "Past due", tone: "warning" },
  canceled: { label: "Canceled", tone: "neutral" },
  unpaid: { label: "Unpaid", tone: "danger" },
  incomplete: { label: "Incomplete", tone: "neutral" },
  incomplete_expired: { label: "Expired", tone: "neutral" },
  paused: { label: "Paused", tone: "neutral" },
};

const STATUS_FILTER = ["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "paused"];

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function statusBadge(sub: SubscriptionRow) {
  const s = STATUS[sub.status] ?? { label: sub.status, tone: "neutral" as BadgeTone };
  if (sub.status === "active" && sub.cancelAtPeriodEnd) return <StatusBadge tone="warning">Canceling</StatusBadge>;
  return (
    <StatusBadge tone={s.tone} live={sub.status === "active"}>
      {s.label}
      {!sub.livemode && <span className="font-normal opacity-70">· test</span>}
    </StatusBadge>
  );
}

function periodText(sub: SubscriptionRow): string {
  const end = sub.currentPeriodEnd;
  if (sub.status === "canceled") return sub.canceledAt ? `Ended ${formatDate(sub.canceledAt)}` : "Ended";
  if (!end) return "—";
  if (sub.status === "trialing" && sub.trialEnd) return `Trial ends ${formatDate(sub.trialEnd)}`;
  return `${sub.cancelAtPeriodEnd ? "Ends" : "Renews"} ${formatDate(end)}`;
}

export default async function AdminBillingPage({ searchParams }: PageProps<"/admin/billing">) {
  const ctx = await requirePermission("billing.read");
  const manage = can(ctx, "billing.manage");
  const seePeople = can(ctx, "users.read");
  const params = await searchParams;
  const search = first(params.q).trim();
  const status = first(params.status);
  const page = Math.max(Number.parseInt(first(params.page), 10) || 1, 1);

  const [billing, revenue, plans, subs] = await Promise.all([
    getSettings("billing"),
    revenueSummary(),
    listPlans({ includeArchived: true }),
    listSubscriptions({ search, status: STATUS_FILTER.includes(status) ? status : undefined, page, pageSize: PAGE_SIZE }),
  ]);
  const connected = billing.stripeSecretKeySet;
  const on = billing.enabled && connected;
  const exportQuery = new URLSearchParams(Object.entries({ q: search, status }).filter(([, v]) => v)).toString();
  const exportHref = exportQuery ? `/admin/billing/export?${exportQuery}` : "/admin/billing/export";

  return (
    <>
      <PageHeader
        title="Billing"
        description="Plans, subscriptions and revenue."
        icon={<Receipt />}
        badge={on ? <StatusBadge tone="positive" live>On · {billing.livemode ? "live" : "test"} mode</StatusBadge> : <StatusBadge>Off</StatusBadge>}
        actions={
          manage ? (
            <Button asChild>
              <Link href="/admin/billing/plans/new">
                <Plus />
                New plan
              </Link>
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {!on && (
          <Callout
            tone="info"
            title={connected ? "Billing is off" : "Stripe is not connected"}
            action={
              manage ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/admin/settings/billing">Open billing settings</Link>
                </Button>
              ) : undefined
            }
          >
            Every account has everything without a plan.{" "}
            {connected
              ? "Plans can be prepared here and turned on under Settings → Billing."
              : "Plans can be prepared here; nobody can subscribe until Stripe is connected under Settings → Billing."}
          </Callout>
        )}

        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-5">
          <StatCard label="Monthly revenue" value={formatMoney(revenue.mrr, revenue.currency)} mono hint="Yearly plans count a twelfth" className="col-span-2 @3xl:col-span-1" />
          <StatCard label="Active" value={formatNumber(revenue.active)} />
          <StatCard label="Trialing" value={formatNumber(revenue.trialing)} />
          <StatCard label="Past due" value={formatNumber(revenue.pastDue)} />
          <StatCard label="Canceling" value={formatNumber(revenue.canceling)} hint="End at the period's end" />
        </div>

        <SettingsGroup
          id="plans"
          title="Plans"
          description={manage ? "What people can subscribe to. Prices are created in Stripe when a plan is saved." : "What people can subscribe to."}
          bodyClassName="px-0"
        >
          <DataTable
            bare
            caption="Plans"
            rows={plans}
            getRowId={(p) => p.id}
            rowHref={manage ? (p) => `/admin/billing/plans/${p.id}` : undefined}
            columns={[
              {
                id: "name",
                header: "Plan",
                cell: (p) => (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className={p.archived ? "text-muted-foreground line-through" : undefined}>{p.name}</span>
                    {p.isFree && <StatusBadge dot={false}>Free</StatusBadge>}
                    {p.highlighted && !p.archived && (
                      <StatusBadge dot={false} tone="info">
                        Highlighted
                      </StatusBadge>
                    )}
                    {!p.isPublic && !p.archived && <StatusBadge dot={false}>Hidden</StatusBadge>}
                    {p.archived && <StatusBadge dot={false}>Archived</StatusBadge>}
                  </span>
                ),
              },
              { id: "limits", header: "Limits", cell: (p) => <span className="text-muted-foreground">{limitsSummary(p.limits)}</span>, card: "line" },
              {
                id: "prices",
                header: "Prices",
                mono: true,
                card: "line",
                cell: (p) =>
                  p.isFree ? (
                    "—"
                  ) : p.prices.length === 0 ? (
                    <span className="text-muted-foreground">No price yet</span>
                  ) : (
                    <span className="flex flex-col gap-0.5 @2xl/table:items-start">
                      {p.prices.map((price) => (
                        <span key={price.id} className="whitespace-nowrap">
                          {formatMoney(price.amount, price.currency)} / {price.interval === "month" ? "mo" : "yr"}
                        </span>
                      ))}
                    </span>
                  ),
              },
              {
                id: "stripe",
                header: "Stripe",
                card: "aside",
                cell: (p) => {
                  const state = stripeState(p, connected);
                  return <StatusBadge tone={state.tone}>{state.label}</StatusBadge>;
                },
              },
            ]}
            rowActions={manage ? (p) => <PlanRowActions plan={{ id: p.id, name: p.name, isFree: p.isFree, archived: p.archived }} stripeConnected={connected} /> : undefined}
            empty={
              <EmptyState
                icon={<Receipt />}
                title="No plans yet."
                description="Plans are created when the server starts for the first time."
                action={
                  manage ? (
                    <Button asChild>
                      <Link href="/admin/billing/plans/new">New plan</Link>
                    </Button>
                  ) : undefined
                }
                className="m-4 border-0 py-8"
              />
            }
          />
        </SettingsGroup>

        <section id="subscriptions" className="flex flex-col gap-3">
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Subscriptions</h2>
          <ListToolbar>
            <SearchInput placeholder="Search by name, e-mail or Stripe id…" aria-label="Search subscriptions" />
            <div className="flex flex-wrap items-center gap-2">
              <FilterSheet params={["status"]}>
                <FilterSelect
                  param="status"
                  label="Status"
                  allLabel="All statuses"
                  options={STATUS_FILTER.map((value) => ({ value, label: STATUS[value]?.label ?? value }))}
                />
              </FilterSheet>
              <Button variant="outline" asChild>
                <a href={exportHref} download>
                  <Download />
                  Export CSV
                </a>
              </Button>
            </div>
          </ListToolbar>
          <DataTable
            caption="Subscriptions"
            rows={subs.rows}
            getRowId={(s) => s.id}
            rowHref={seePeople ? (s) => `/admin/users/${s.user.id}` : undefined}
            columns={[
              {
                id: "person",
                header: "Person",
                cell: (s) => (
                  <span className="flex flex-col">
                    <span>{s.user.name || s.user.email}</span>
                    {s.user.name && <span className="text-xs font-normal text-muted-foreground">{s.user.email}</span>}
                  </span>
                ),
              },
              { id: "plan", header: "Plan", cell: (s) => s.plan?.name ?? <span className="text-muted-foreground">Unknown price</span>, card: "line" },
              { id: "status", header: "Status", cell: statusBadge, card: "aside" },
              { id: "period", header: "Renews / ends", cell: periodText, card: "line", hideBelow: "4xl" },
              {
                id: "amount",
                header: "Amount",
                align: "right",
                mono: true,
                card: "line",
                cell: (s) => (s.amount === null || !s.currency ? "—" : `${formatMoney(s.amount, s.currency)} / ${s.interval === "year" ? "yr" : "mo"}`),
              },
            ]}
            footer={<Pagination total={subs.total} noun={["subscription", "subscriptions"]} />}
            empty={
              <EmptyState
                icon={<Users />}
                title={search || status ? "No subscription matches." : "No subscriptions yet."}
                description={search || status ? "Try another search or clear the filter." : on ? "They appear here as soon as someone subscribes." : "People can subscribe once billing is on."}
              />
            }
          />
        </section>
      </PageBody>
    </>
  );
}
