"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RowActions } from "@/components/row-actions";
import { archivePlanAction, syncPlanAction } from "../actions";

/** The trailing menu of a plan in the list: edit, sync to Stripe, archive. */
export function PlanRowActions({
  plan,
  stripeConnected,
}: {
  plan: { id: string; name: string; isFree: boolean; archived: boolean };
  stripeConnected: boolean;
}) {
  const router = useRouter();
  return (
    <RowActions
      label={`Actions for ${plan.name}`}
      items={[
        { label: "Edit", href: `/admin/billing/plans/${plan.id}` },
        ...(!plan.isFree
          ? [
              {
                label: "Sync to Stripe",
                disabled: !stripeConnected,
                onSelect: async () => {
                  const result = await syncPlanAction(plan.id);
                  if (result.ok) router.refresh();
                  return result;
                },
                successMessage: "Plan updated in Stripe",
              },
            ]
          : []),
        ...(!plan.isFree && !plan.archived
          ? [
              {
                label: "Archive",
                tone: "danger" as const,
                separator: true,
                confirm: {
                  title: `Archive “${plan.name}”?`,
                  description: "Nobody can subscribe to it any more. People who already pay for it keep it until they change or cancel.",
                  confirmLabel: "Archive plan",
                  pendingLabel: "Archiving…",
                  onConfirm: async () => {
                    const result = await archivePlanAction(plan.id);
                    if (result.ok) {
                      if (result.data.sync.status === "failed") toast.warning("Plan archived, but Stripe was not updated", { description: result.data.sync.error });
                      router.refresh();
                    }
                    return result;
                  },
                },
                successMessage: "Plan archived",
              },
            ]
          : []),
      ]}
    />
  );
}
