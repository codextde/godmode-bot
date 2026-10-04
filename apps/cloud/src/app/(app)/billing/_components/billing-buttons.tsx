"use client";

import { useTransition, type ComponentProps, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cancelSubscriptionAction, portalAction, resumeSubscriptionAction } from "../actions";

/** Opens the Stripe billing portal (payment method, invoices, tax details). */
export function PortalButton({
  children = "Payment method & invoices",
  variant = "outline",
  size,
}: {
  children?: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}) {
  const [pending, startTransition] = useTransition();
  const open = () =>
    startTransition(async () => {
      const result = await portalAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      window.location.assign(result.data.url);
    });
  return (
    <Button variant={variant} size={size} onClick={open} disabled={pending} aria-busy={pending || undefined}>
      {pending ? <Spinner aria-hidden aria-label={undefined} role={undefined} /> : <ExternalLink />}
      {pending ? "Opening Stripe…" : children}
    </Button>
  );
}

export function CancelButton({ planName, endsOn }: { planName: string; endsOn: string | null }) {
  return (
    <ConfirmDialog
      trigger={<Button variant="outline">Cancel subscription</Button>}
      tone="danger"
      title={`Cancel ${planName}?`}
      description={
        endsOn
          ? `You keep ${planName} until ${endsOn}. After that your account moves to the free plan; computers over its limit stay linked but can't be opened. You can resume any time before then.`
          : `Your account moves to the free plan at the end of the paid period. You can resume any time before then.`
      }
      confirmLabel="Cancel subscription"
      pendingLabel="Cancelling…"
      cancelLabel="Keep it"
      onConfirm={() => cancelSubscriptionAction()}
      successMessage="Subscription cancelled"
    />
  );
}

export function ResumeButton({ planName }: { planName: string }) {
  return (
    <ConfirmDialog
      trigger={<Button>Resume subscription</Button>}
      title={`Resume ${planName}?`}
      description="The cancellation is undone and the subscription renews as before."
      confirmLabel="Resume"
      pendingLabel="Resuming…"
      onConfirm={() => resumeSubscriptionAction()}
      successMessage="Subscription resumed"
    />
  );
}
