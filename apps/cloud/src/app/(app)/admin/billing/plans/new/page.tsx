import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page";
import { requirePermission } from "@/lib/session";
import { listPlans } from "@/server/billing/plans";
import { getSettings } from "@/server/settings";
import { PlanForm } from "../../_components/plan-form";
import { emptyPlanForm } from "../../_lib/plan-view";

export const metadata: Metadata = { title: "New plan" };

export default async function NewPlanPage() {
  await requirePermission("billing.manage");
  const [billing, plans] = await Promise.all([getSettings("billing"), listPlans({ includeArchived: true })]);
  return (
    <>
      <PageHeader
        width="form"
        title="New plan"
        description="A plan is what a subscription buys: limits, a name and prices."
        icon={<Plus />}
        back={{ href: "/admin/billing", label: "Billing" }}
      />
      <PageBody width="form">
        <PlanForm
          plan={null}
          initial={{ ...emptyPlanForm(), sort: String(plans.length) }}
          priceCurrency={{ month: null, year: null }}
          defaultCurrency={billing.currency}
          stripeConnected={billing.stripeSecretKeySet}
          hasFreePlan={plans.some((p) => p.isFree)}
        />
      </PageBody>
    </>
  );
}
