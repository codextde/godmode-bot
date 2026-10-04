"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CreditCard, KeyRound } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/data-display";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { StepCard, StepFooter, StepHeader } from "@/components/setup-shell";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { connectStripeAction, createInStripeAction, setChargingAction, type StripeSetupInput } from "../actions";
import { stepHref } from "../_lib/steps";
import { useStepAction } from "./use-step-action";

export interface BillingPlanRow {
  id: string;
  name: string;
  /** Amounts as typed ("10.00"); empty when there is no price yet. */
  month: string;
  year: string;
  /** The plan and all its prices exist in Stripe. */
  synced: boolean;
}

export interface BillingStepProps {
  connected: boolean;
  accountName: string;
  livemode: boolean | null;
  currency: string;
  plans: BillingPlanRow[];
  webhookSet: boolean;
  charging: boolean;
  /** What turning charging on does right now. */
  preview: { people: number; computersOverLimit: number; freePlanName: string; freeDevices: number | null };
}

/** Step 5: connect Stripe, set the prices, create the products, and decide whether to charge yet. */
export function BillingStep(props: BillingStepProps) {
  const router = useRouter();
  const [connected, setConnected] = useState(props.connected);
  const [account, setAccount] = useState({ name: props.accountName, livemode: props.livemode });
  const [editingKey, setEditingKey] = useState(!props.connected);
  const [key, setKey] = useState("");
  const [currency, setCurrency] = useState(props.currency);
  const [prices, setPrices] = useState<StripeSetupInput["prices"]>(props.plans.map((p) => ({ planId: p.id, month: p.month, year: p.year })));
  const [synced, setSynced] = useState(props.plans.length > 0 && props.plans.every((p) => p.synced));
  const [webhookProblem, setWebhookProblem] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [charging, setCharging] = useState(props.charging);
  const [confirming, setConfirming] = useState(false);
  const connect = useStepAction(["key"]);
  const create = useStepAction(["currency", ...props.plans.flatMap((p) => [`${p.id}.month`, `${p.id}.year`])]);
  const toggle = useStepAction();

  const onConnect = (e: FormEvent) => {
    e.preventDefault();
    connect.run(
      () => connectStripeAction(key),
      (result) => {
        setConnected(true);
        setEditingKey(false);
        setKey("");
        setAccount({ name: result.accountName, livemode: result.livemode });
        setSynced(false);
        router.refresh();
      },
    );
  };

  const onCreate = () => {
    create.run(
      () => createInStripeAction({ currency, prices }),
      (result) => {
        setSynced(true);
        setCreated(true);
        setWebhookProblem(result.webhookProblem);
        router.refresh();
      },
    );
  };

  const setPrice = (planId: string, interval: "month" | "year", value: string) =>
    setPrices((rows) => rows.map((r) => (r.planId === planId ? { ...r, [interval]: value } : r)));

  const onCharging = (next: boolean) => {
    if (next) {
      setConfirming(true);
      return;
    }
    // Turning it off takes effect at once; the UI follows optimistically.
    setCharging(false);
    toggle.run(
      () => setChargingAction(false),
      () => router.refresh(),
    );
  };

  const modeBadge = account.livemode === null ? null : account.livemode ? <StatusBadge tone="positive">Live mode</StatusBadge> : <StatusBadge tone="warning">Test mode</StatusBadge>;

  return (
    <div>
      <StepHeader
        eyebrow="Optional"
        title="Billing"
        description="Sell Godmode Cloud subscriptions through Stripe, or keep every account free. Nothing is charged until you turn charging on."
      />
      <div className="flex flex-col gap-5">
        <StepCard>
          {connected && !editingKey ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4">
                  <CreditCard />
                </div>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{account.name ? `Connected to ${account.name}` : "Connected to Stripe"}</span>
                    {modeBadge}
                  </p>
                  <p className="text-xs text-muted-foreground">The secret key is stored encrypted.</p>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
                <KeyRound /> Use a different key
              </Button>
            </div>
          ) : (
            <form onSubmit={onConnect} noValidate>
              <FormStack>
                <FormField
                  label="Stripe secret key"
                  error={connect.fields.key}
                  hint="Stripe Dashboard → Developers → API keys. A restricted key with write access to products, prices, customers, subscriptions, checkout and webhooks works too. Stored encrypted, never shown again."
                >
                  <Input
                    type="password"
                    name="stripeSecretKey"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="sk_live_…"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </FormField>
                {connect.error && <Callout tone="danger" title={connect.error} />}
                <div className="flex flex-wrap items-center gap-2">
                  <SubmitButton pending={connect.pending} pendingLabel="Checking the key…" disabled={!key.trim()} variant={connected ? "outline" : "default"}>
                    {connected ? "Replace key" : "Connect Stripe"}
                  </SubmitButton>
                  {connected && (
                    <Button type="button" variant="ghost" onClick={() => setEditingKey(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </FormStack>
            </form>
          )}
        </StepCard>

        {connected && (
          <StepCard>
            <FormStack>
              <div>
                <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Plans and prices</h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Everyone without a subscription uses the free plan. Set what the paid plans cost; you can refine plans and limits later under
                  Admin → Billing.
                </p>
              </div>
              <FormField label="Currency" error={create.fields.currency} hint="Three-letter code. Your Stripe account's currency is filled in.">
                <Input
                  name="currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3))}
                  className="w-28 font-mono uppercase"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormField>
              {props.plans.length === 0 ? (
                <Callout tone="muted" role="note">
                  There is no paid plan yet. Create one under Admin → Billing after setup.
                </Callout>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {props.plans.map((plan) => {
                    const row = prices.find((r) => r.planId === plan.id)!;
                    return (
                      <li key={plan.id} className="grid gap-3 p-3.5 sm:grid-cols-[1fr_8rem_8rem] sm:items-end">
                        <div className="flex items-center gap-2 pb-0.5 text-sm font-medium">
                          {plan.name}
                          {plan.synced && <StatusBadge tone="positive">In Stripe</StatusBadge>}
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:contents">
                          <FormField label="Per month" error={create.fields[`${plan.id}.month`]}>
                            <Input
                              inputMode="decimal"
                              value={row.month}
                              onChange={(e) => setPrice(plan.id, "month", e.target.value)}
                              placeholder="10.00"
                              className="font-mono tabular-nums"
                            />
                          </FormField>
                          <FormField label="Per year" error={create.fields[`${plan.id}.year`]}>
                            <Input
                              inputMode="decimal"
                              value={row.year}
                              onChange={(e) => setPrice(plan.id, "year", e.target.value)}
                              placeholder="100.00"
                              className="font-mono tabular-nums"
                            />
                          </FormField>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {create.error && <Callout tone="danger" title={create.error} />}
              {created && (
                <Callout tone="success" role="status" title="Products and prices are in Stripe">
                  People can subscribe as soon as charging is on.
                </Callout>
              )}
              {webhookProblem ? (
                <Callout tone="warning" role="note" title="Add the webhook yourself">
                  {webhookProblem}
                </Callout>
              ) : (
                created && !props.webhookSet && <Callout tone="muted" role="note">The webhook that keeps subscriptions in sync was created in Stripe.</Callout>
              )}
              <div>
                <Button type="button" onClick={onCreate} disabled={create.pending || props.plans.length === 0} aria-busy={create.pending || undefined}>
                  {create.pending ? "Creating in Stripe…" : synced ? "Update in Stripe" : "Create in Stripe"}
                </Button>
              </div>
            </FormStack>
          </StepCard>
        )}

        {connected && synced && (
          <StepCard>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="min-w-0 grow basis-56 space-y-1">
                <Label htmlFor="charging" className="text-sm font-medium">
                  Start charging now
                </Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Off: every account has everything, free of charge. On: people without a subscription get the free plan and its limits.
                </p>
              </div>
              <Switch id="charging" checked={charging} onCheckedChange={onCharging} disabled={toggle.pending} aria-busy={toggle.pending || undefined} />
            </div>
            {toggle.error && (
              <div className="mt-4">
                <Callout tone="danger" title={toggle.error} />
              </div>
            )}
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title="Start charging now?"
              description="People without a subscription move to the free plan right away."
              confirmLabel="Start charging"
              pendingLabel="Turning on…"
              successMessage="Charging is on"
              onConfirm={async () => {
                const result = await setChargingAction(true);
                if (result.ok) {
                  setCharging(true);
                  router.refresh();
                }
                return result;
              }}
            >
              <dl className="divide-y rounded-lg border bg-paper-2 px-3.5 text-sm">
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Move to {props.preview.freePlanName}</dt>
                  <dd className="font-mono tabular-nums">{props.preview.people === 1 ? "1 person" : `${props.preview.people} people`}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Computers over its limit{props.preview.freeDevices !== null && ` of ${props.preview.freeDevices}`}</dt>
                  <dd className="font-mono tabular-nums">{props.preview.computersOverLimit}</dd>
                </div>
              </dl>
              {props.preview.computersOverLimit > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Those computers stop being reachable through the cloud until their owner subscribes. Owners of this cloud are never limited.
                </p>
              )}
            </ConfirmDialog>
          </StepCard>
        )}
      </div>
      <StepFooter backHref={stepHref("access")}>
        {connected ? (
          <Button asChild className="max-md:flex-1">
            <Link href={stepHref("done")}>
              Continue <ArrowRight />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" asChild className="max-md:flex-1">
            <Link href={stepHref("done")}>Keep it free for everyone</Link>
          </Button>
        )}
      </StepFooter>
    </div>
  );
}
