import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Receipt } from "lucide-react";
import { StatusBadge } from "@/components/data-display";
import { PageBody, PageHeader } from "@/components/page";
import { requirePermission } from "@/lib/session";
import { getPlan } from "@/server/billing/plans";
import { getSettings } from "@/server/settings";
import { PlanForm } from "../../_components/plan-form";
import { moneyText } from "../../_lib/money";
import { stripeState, type PlanFormValue } from "../../_lib/plan-view";

export async function generateMetadata({ params }: PageProps<"/admin/billing/plans/[id]">): Promise<Metadata> {
  const { id } = await params;
  const plan = await getPlan(id);
  return { title: plan ? `${plan.name} · Plans` : "Plan" };
}

export default async function EditPlanPage({ params }: PageProps<"/admin/billing/plans/[id]">) {
  await requirePermission("billing.manage");
  const { id } = await params;
  const [plan, billing] = await Promise.all([getPlan(id), getSettings("billing")]);
  if (!plan) notFound();
  const month = plan.prices.find((p) => p.interval === "month") ?? null;
  const year = plan.prices.find((p) => p.interval === "year") ?? null;
  const initial: PlanFormValue = {
    key: plan.key,
    name: plan.name,
    description: plan.description,
    features: plan.features,
    maxDevices: plan.limits.maxDevices === null ? "" : String(plan.limits.maxDevices),
    unlimitedDevices: plan.limits.maxDevices === null,
    relayGb: plan.limits.relayGbPerMonth === null ? "" : String(plan.limits.relayGbPerMonth),
    unlimitedRelay: plan.limits.relayGbPerMonth === null,
    browserAccess: plan.limits.browserAccess,
    phoneGateway: plan.limits.phoneGateway,
    sharing: plan.limits.sharing,
    isPublic: plan.isPublic,
    highlighted: plan.highlighted,
    isFree: plan.isFree,
    sort: String(plan.sort),
    priceMonth: month ? moneyText(month.amount, month.currency) : "",
    priceYear: year ? moneyText(year.amount, year.currency) : "",
  };
  const state = stripeState(plan, billing.stripeSecretKeySet);
  return (
    <>
      <PageHeader
        width="form"
        title={plan.name}
        description={
          <>
            Key <span className="font-mono">{plan.key}</span>
            {plan.stripeProductId && (
              <>
                {" · "}Stripe product <span className="font-mono">{plan.stripeProductId}</span>
              </>
            )}
          </>
        }
        icon={<Receipt />}
        badge={<StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
        back={{ href: "/admin/billing", label: "Billing" }}
      />
      <PageBody width="form">
        <PlanForm
          plan={{ id: plan.id, archived: plan.archived, isFree: plan.isFree, stripeProductId: plan.stripeProductId }}
          initial={initial}
          priceCurrency={{ month: month?.currency ?? null, year: year?.currency ?? null }}
          defaultCurrency={billing.currency}
          stripeConnected={billing.stripeSecretKeySet}
          hasFreePlan
        />
      </PageBody>
    </>
  );
}
