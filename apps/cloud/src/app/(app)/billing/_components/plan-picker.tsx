"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Segmented } from "@/components/controls";
import { StatusBadge } from "@/components/data-display";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { changePlanAction, checkoutAction } from "../actions";

type Interval = "month" | "year";

export interface PickerPlan {
  id: string;
  name: string;
  description: string;
  features: string[];
  isFree: boolean;
  highlighted: boolean;
  prices: { id: string; interval: Interval; amount: number; currency: string; ready: boolean }[];
}

/**
 * The plans on offer. Without a subscription "Subscribe" goes to Stripe Checkout; with one, "Switch" changes the
 * plan in place (Stripe settles the difference).
 */
export function PlanPicker({
  plans,
  currentPlanId,
  currentPriceId,
  subscribed,
  defaultInterval,
  canManage,
}: {
  plans: PickerPlan[];
  /** The plan the account has now (free, paid or given). */
  currentPlanId: string;
  /** The price of the running subscription, if any. */
  currentPriceId: string | null;
  /** A subscription is running: plans are switched, not subscribed to again. */
  subscribed: boolean;
  defaultInterval: Interval;
  /** `billing.self`. */
  canManage: boolean;
}) {
  const yearly = plans.some((p) => p.prices.some((price) => price.interval === "year"));
  const monthly = plans.some((p) => p.prices.some((price) => price.interval === "month"));
  const [interval, setInterval] = useState<Interval>(yearly && (!monthly || defaultInterval === "year") ? "year" : "month");
  const [starting, setStarting] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const subscribe = (priceId: string) => {
    setStarting(priceId);
    startTransition(async () => {
      const result = await checkoutAction(priceId);
      if (!result.ok) {
        toast.error(result.error);
        setStarting(null);
        return;
      }
      // Stays busy while the browser leaves for Stripe.
      window.location.assign(result.data.url);
    });
  };

  return (
    <section aria-labelledby="plans-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="plans-title" className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
            Plans
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {subscribed ? "Switching takes effect right away; Stripe settles the difference." : "Payment is handled by Stripe. Cancel any time."}
          </p>
        </div>
        {yearly && monthly && (
          <Segmented
            aria-label="Billing period"
            size="sm"
            value={interval}
            onChange={setInterval}
            options={[
              { value: "month", label: "Monthly" },
              { value: "year", label: "Yearly" },
            ]}
          />
        )}
      </div>
      <div className={cn("grid grid-cols-1 gap-3", plans.length >= 3 ? "@3xl:grid-cols-3" : "@2xl:grid-cols-2")}>
        {plans.map((plan) => {
          const price = plan.prices.find((p) => p.interval === interval) ?? null;
          const onThisPlan = plan.id === currentPlanId;
          const onThisPrice = subscribed ? price !== null && price.id === currentPriceId : onThisPlan;
          return (
            <article
              key={plan.id}
              aria-label={plan.name}
              className={cn(
                "animate-enter flex min-w-0 flex-col rounded-xl border bg-card p-5 shadow-card",
                plan.highlighted && "border-foreground/30 ring-1 ring-foreground/10",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-medium tracking-[-0.01em]">{plan.name}</h3>
                {onThisPlan && (
                  <StatusBadge tone="info" dot={false}>
                    Current
                  </StatusBadge>
                )}
              </div>
              {plan.description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{plan.description}</p>}
              <p className="mt-4 flex items-baseline gap-1.5">
                {plan.isFree ? (
                  <span className="font-mono text-[26px] leading-none font-medium tracking-[-0.02em] tabular-nums">Free</span>
                ) : price ? (
                  <>
                    <span className="font-mono text-[26px] leading-none font-medium tracking-[-0.02em] tabular-nums">
                      {formatMoney(price.amount, price.currency, { trimZero: true })}
                    </span>
                    <span className="text-xs text-muted-foreground">per {interval}</span>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">Not offered {interval === "year" ? "yearly" : "monthly"}</span>
                )}
              </p>
              {plan.features.length > 0 && (
                <ul className="mt-4 space-y-2 text-[13px]">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{feature}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-auto pt-5">
                {plan.isFree ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {onThisPlan ? "Your account is on this plan." : "Your account returns to this plan when a subscription ends."}
                  </p>
                ) : onThisPrice ? (
                  <Button variant="outline" disabled className="w-full">
                    Current
                  </Button>
                ) : !price ? null : !canManage ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">Your role can&apos;t change the plan.</p>
                ) : !price.ready ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">This plan can&apos;t be bought yet. Ask an administrator of this cloud.</p>
                ) : subscribed ? (
                  <ConfirmDialog
                    trigger={
                      <Button variant={plan.highlighted ? "default" : "outline"} className="w-full">
                        Switch
                      </Button>
                    }
                    title={`Switch to ${plan.name}?`}
                    description={`Your plan changes right away to ${plan.name} at ${formatMoney(price.amount, price.currency)} per ${interval}. Stripe charges or credits the difference for the rest of the current period.`}
                    confirmLabel="Switch"
                    pendingLabel="Switching…"
                    onConfirm={() => changePlanAction(price.id)}
                    successMessage={`Switched to ${plan.name}`}
                  />
                ) : (
                  <Button
                    variant={plan.highlighted ? "default" : "outline"}
                    className="w-full"
                    onClick={() => subscribe(price.id)}
                    disabled={starting !== null}
                    aria-busy={starting === price.id || undefined}
                  >
                    {starting === price.id && <Spinner aria-hidden aria-label={undefined} role={undefined} />}
                    {starting === price.id ? "Opening checkout…" : "Subscribe"}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
