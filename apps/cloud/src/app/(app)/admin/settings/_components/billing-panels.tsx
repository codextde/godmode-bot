"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CreditCard, KeyRound, Webhook } from "lucide-react";
import type { CloudPlanSummary } from "@godmode/shared";
import { ConfirmDialog, isNavigationError } from "@/components/confirm-dialog";
import { CopyButton, CopyField } from "@/components/copy-button";
import { StatusBadge } from "@/components/data-display";
import { RelativeTime } from "@/components/relative-time";
import { Callout, InfoRow, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ActionResult } from "@/lib/action";
import { formatNumber } from "@/lib/format";
import { saveStripeKeyAction, saveWebhookSecretAction, setBillingEnabledAction, setupWebhookAction } from "../actions";

/* ------------------------------------------------------------------ */
/* Charging                                                             */
/* ------------------------------------------------------------------ */

export function ChargingCard({
  enabled: enabledInitial,
  connected,
  webhookReady,
  preview,
}: {
  enabled: boolean;
  connected: boolean;
  webhookReady: boolean;
  preview: { people: number; computersOverLimit: number; freePlan: CloudPlanSummary };
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(enabledInitial);
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();

  const turnOff = () => {
    setEnabled(false);
    startTransition(async () => {
      try {
        const result = await setBillingEnabledAction(false);
        if (!result.ok) {
          setEnabled(true);
          toast.error(result.error);
          return;
        }
        toast.success("Billing is off. Everyone has everything again.");
        router.refresh();
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setEnabled(true);
        toast.error("Could not reach the server. Try again.");
      }
    });
  };

  const limits = preview.freePlan.limits;
  const freeText = [
    limits.maxDevices === null ? "any number of computers" : `${formatNumber(limits.maxDevices)} ${limits.maxDevices === 1 ? "computer" : "computers"}`,
    limits.relayGbPerMonth === null ? "unlimited relay traffic" : `${formatNumber(limits.relayGbPerMonth)} GB of relay traffic a month`,
  ].join(", ");

  return (
    <SettingsGroup
      title="Charging"
      description="While billing is off, every account has everything, without a plan."
      icon={<CreditCard />}
      actions={enabled ? <StatusBadge tone="positive" live>On</StatusBadge> : <StatusBadge>Off</StatusBadge>}
    >
      <SettingRow
        label="Charge for plans"
        htmlFor="billing-enabled"
        disabled={!connected}
        description={
          !connected
            ? "Connect Stripe below first."
            : enabled
              ? "Accounts without a subscription or a granted plan are on the free plan. Owners always have everything."
              : "Turning this on takes effect at once. Changes with a confirmation that says who is affected."
        }
      >
        <Switch
          id="billing-enabled"
          checked={enabled}
          disabled={!connected || pending}
          onCheckedChange={(next) => (next ? setConfirm(true) : turnOff())}
        />
      </SettingRow>
      {enabled && !webhookReady && (
        <div className="py-4">
          <Callout tone="warning" title="The webhook is not set up">
            Payments and cancellations in Stripe do not reach this cloud until it is. Set it up below.
          </Callout>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Start charging for plans?"
        description="This takes effect right away for everyone."
        confirmLabel="Turn billing on"
        pendingLabel="Turning on…"
        successMessage="Billing is on"
        onConfirm={async () => {
          const result = await setBillingEnabledAction(true);
          if (result.ok) {
            setEnabled(true);
            router.refresh();
          }
          return result;
        }}
      >
        <ul className="space-y-2 text-sm">
          <li>
            <span className="font-mono tabular-nums">{formatNumber(preview.people)}</span>{" "}
            {preview.people === 1 ? "person" : "people"} without a subscription or granted plan move to the{" "}
            <span className="font-medium">{preview.freePlan.name}</span> plan ({freeText}).
          </li>
          <li>
            <span className="font-mono tabular-nums">{formatNumber(preview.computersOverLimit)}</span>{" "}
            {preview.computersOverLimit === 1 ? "computer goes" : "computers go"} over that plan's limit and{" "}
            {preview.computersOverLimit === 1 ? "stops" : "stop"} being reachable until the owner subscribes or removes other computers.
          </li>
          <li>Owners of this cloud keep everything.</li>
        </ul>
      </ConfirmDialog>
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------ */
/* Stripe key                                                           */
/* ------------------------------------------------------------------ */

function useSubmit<T>(run: () => Promise<ActionResult<T>>, onDone: (data: T) => void) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await run();
        if (!result.ok) {
          setError(result.fields ? Object.values(result.fields)[0] ?? result.error : result.error);
          return;
        }
        onDone(result.data);
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setError("Could not reach the server. Check your connection and try again.");
      }
    });
  };
  return { pending, error, submit, setError };
}

export function StripeCard({
  keySet: keySetInitial,
  accountName: accountInitial,
  livemode: livemodeInitial,
}: {
  keySet: boolean;
  accountName: string;
  livemode: boolean | null;
}) {
  const router = useRouter();
  const [keySet, setKeySet] = useState(keySetInitial);
  const [account, setAccount] = useState({ name: accountInitial, livemode: livemodeInitial });
  const [replacing, setReplacing] = useState(!keySetInitial);
  const [key, setKey] = useState("");
  const { pending, error, submit } = useSubmit(
    () => saveStripeKeyAction(key),
    (data) => {
      setKeySet(true);
      setAccount({ name: data.accountName, livemode: data.livemode });
      setReplacing(false);
      setKey("");
      toast.success(`Connected to ${data.accountName || "Stripe"} in ${data.livemode ? "live" : "test"} mode`);
      router.refresh();
    },
  );

  const mode =
    account.livemode === null ? null : account.livemode ? (
      <StatusBadge tone="positive">Live mode</StatusBadge>
    ) : (
      <StatusBadge tone="warning">Test mode</StatusBadge>
    );

  return (
    <SettingsGroup
      title="Stripe"
      description="Payments run through your Stripe account. Everything this cloud creates there is tagged godmode_cloud, so the account can be shared with other products."
      icon={<KeyRound />}
      actions={keySet ? mode : <StatusBadge>Not connected</StatusBadge>}
    >
      {keySet && (
        <>
          <InfoRow label="Account">{account.name || "—"}</InfoRow>
          <InfoRow label="Mode">
            {account.livemode ? "Live: real cards are charged." : account.livemode === false ? "Test: only Stripe test cards work." : "—"}
          </InfoRow>
        </>
      )}
      {keySet && !replacing ? (
        <SettingRow label="Secret key" description="Stored encrypted and never shown again. Replace it after rotating the key in Stripe.">
          <StatusBadge tone="info">Saved</StatusBadge>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </SettingRow>
      ) : (
        <form onSubmit={submit} className="py-4" noValidate>
          <SettingRow
            label="Secret key"
            htmlFor="billing-stripe-key"
            stacked
            className="py-0"
            description={
              <>
                From the Stripe Dashboard → Developers → API keys: a secret key (sk_…) or a restricted key (rk_…) that may manage products, prices,
                customers, subscriptions, checkout, the billing portal and webhooks. It is checked against Stripe before it is stored.
                {error && (
                  <span id="billing-stripe-key-error" role="alert" className="mt-1 block text-destructive">
                    {error}
                  </span>
                )}
              </>
            }
          >
            <div className="flex flex-col gap-2 @md:flex-row">
              <Input
                id="billing-stripe-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk_live_…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "billing-stripe-key-error" : undefined}
                className="font-mono"
              />
              <div className="flex gap-2 [&>*]:flex-1 @md:[&>*]:flex-none">
                {keySet && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setReplacing(false);
                      setKey("");
                    }}
                    disabled={pending}
                  >
                    Keep saved
                  </Button>
                )}
                <SubmitButton pending={pending} pendingLabel="Checking…" disabled={!key.trim()}>
                  Check and save
                </SubmitButton>
              </div>
            </div>
          </SettingRow>
        </form>
      )}
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------ */
/* Webhook                                                              */
/* ------------------------------------------------------------------ */

export function WebhookCard({
  connected,
  endpointId: endpointInitial,
  secretSet: secretInitial,
  url,
  events,
  lastEventAt,
}: {
  connected: boolean;
  endpointId: string;
  secretSet: boolean;
  url: string;
  events: string[];
  lastEventAt: string | null;
}) {
  const router = useRouter();
  const [endpointId, setEndpointId] = useState(endpointInitial);
  const [secretSet, setSecretSet] = useState(secretInitial);
  const [manual, setManual] = useState<{ reason: string | null } | null>(null);
  const [secret, setSecret] = useState("");
  const setup = useSubmit(setupWebhookAction, (data) => {
    if (data.status === "ready") {
      setEndpointId(data.endpointId);
      setSecretSet(true);
      setManual(null);
      toast.success("Webhook is set up");
      router.refresh();
    } else {
      setManual({ reason: data.reason });
    }
  });
  const save = useSubmit(
    () => saveWebhookSecretAction(secret),
    (data) => {
      setSecretSet(data.webhookSecretSet);
      setEndpointId("");
      setSecret("");
      setManual(null);
      toast.success("Signing secret saved");
      router.refresh();
    },
  );

  const status = !secretSet ? (
    <StatusBadge tone={connected ? "warning" : "neutral"}>Not set up</StatusBadge>
  ) : endpointId ? (
    <StatusBadge tone="positive">Set up</StatusBadge>
  ) : (
    <StatusBadge tone="positive">Secret saved</StatusBadge>
  );

  return (
    <SettingsGroup
      title="Webhook"
      description="Stripe tells this cloud about payments, renewals and cancellations through a webhook. Without it, plans never change after checkout."
      icon={<Webhook />}
      actions={status}
    >
      <InfoRow label="Endpoint" mono>
        {endpointId || (secretSet ? "Added in the Stripe Dashboard" : "—")}
      </InfoRow>
      <InfoRow label="Last event received">
        <RelativeTime date={lastEventAt} fallback="None yet" />
      </InfoRow>
      <SettingRow
        label={secretSet ? "Repair" : "Set up"}
        description={
          connected
            ? "Creates the endpoint in your Stripe account with the right address and events, or fixes an existing one, and stores its signing secret."
            : "Connect Stripe first."
        }
      >
        <Button type="button" variant={secretSet ? "outline" : "default"} onClick={() => setup.submit()} disabled={!connected || setup.pending} aria-busy={setup.pending || undefined}>
          {setup.pending ? "Setting up…" : secretSet ? "Repair webhook" : "Set up webhook"}
        </Button>
      </SettingRow>
      {setup.error && (
        <div className="py-4">
          <Callout tone="danger" title={setup.error} />
        </div>
      )}
      {(manual || (!secretSet && connected)) && (
        <div className="space-y-4 py-4">
          {manual?.reason ? (
            <Callout tone="warning" title="Stripe could not set up the webhook from here">
              {manual.reason}
            </Callout>
          ) : (
            !manual && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setManual({ reason: null })}>
                Add it in the Stripe Dashboard by hand instead
              </Button>
            )
          )}
          {manual && (
            <ol className="space-y-4 text-sm [counter-reset:step]">
              <li className="space-y-2">
                <p>
                  <span className="font-medium">1.</span> In the Stripe Dashboard open Developers → Webhooks and add an endpoint with this address:
                </p>
                <CopyField value={url} label="Copy webhook address" />
              </li>
              <li className="space-y-2">
                <p>
                  <span className="font-medium">2.</span> Select exactly these events:
                </p>
                <div className="flex flex-wrap items-start gap-2">
                  <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {events.map((event) => (
                      <li key={event} className="rounded-md border bg-paper-2 px-1.5 py-0.5 font-mono text-xs">
                        {event}
                      </li>
                    ))}
                  </ul>
                  <CopyButton value={events.join("\n")} label="Copy event list" size="sm" />
                </div>
              </li>
              <li>
                <form onSubmit={save.submit} className="space-y-2" noValidate>
                  <label htmlFor="billing-webhook-secret" className="block text-sm">
                    <span className="font-medium">3.</span> Paste the endpoint's signing secret here:
                  </label>
                  <div className="flex flex-col gap-2 @md:flex-row">
                    <Input
                      id="billing-webhook-secret"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="whsec_…"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      aria-invalid={save.error ? true : undefined}
                      aria-describedby={save.error ? "billing-webhook-secret-error" : undefined}
                      className="font-mono"
                    />
                    <SubmitButton pending={save.pending} pendingLabel="Saving…" disabled={!secret.trim()}>
                      Save secret
                    </SubmitButton>
                  </div>
                  {save.error && (
                    <p id="billing-webhook-secret-error" role="alert" className="text-xs text-destructive">
                      {save.error}
                    </p>
                  )}
                </form>
              </li>
            </ol>
          )}
        </div>
      )}
      {secretSet && !manual && (
        <div className="py-3 text-xs text-muted-foreground">
          Rotated the secret in Stripe, or added the endpoint by hand?{" "}
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setManual({ reason: null })}>
            Enter a signing secret
          </Button>
          . Plans are managed under{" "}
          <Link href="/admin/billing" className="font-medium text-foreground underline-offset-4 hover:underline">
            Billing
          </Link>
          .
        </div>
      )}
    </SettingsGroup>
  );
}
