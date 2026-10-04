"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Eye, Gauge, ListChecks, Plus, Receipt, X } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/data-display";
import { Callout, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { NumberRow, SaveBar, SwitchRow, TextRow, toNumber } from "../../settings/_components/fields";
import { useSettingsForm } from "../../settings/_components/use-settings-form";
import { archivePlanAction, createPlanAction, updatePlanAction, type PlanFormInput, type SyncOutcome } from "../actions";
import type { PlanFormValue } from "../_lib/plan-view";

export interface PlanFormProps {
  /** Editing an existing plan; absent when creating one. */
  plan: { id: string; archived: boolean; isFree: boolean; stripeProductId: string | null } | null;
  initial: PlanFormValue;
  /** Currency of each existing price (they keep it) and the default for new ones. */
  priceCurrency: { month: string | null; year: string | null };
  defaultCurrency: string;
  stripeConnected: boolean;
  /** Create only: whether a free plan already exists (there can be only one). */
  hasFreePlan: boolean;
}

const MAX_FEATURES = 20;

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function toInput(v: PlanFormValue, creating: boolean): PlanFormInput {
  return {
    ...(creating ? { key: v.key.trim() || slug(v.name), isFree: v.isFree } : {}),
    name: v.name,
    description: v.description,
    features: v.features,
    limits: {
      maxDevices: v.unlimitedDevices ? null : toNumber(v.maxDevices),
      relayGbPerMonth: v.unlimitedRelay ? null : toNumber(v.relayGb),
      browserAccess: v.browserAccess,
      phoneGateway: v.phoneGateway,
      sharing: v.sharing,
    },
    isPublic: v.isPublic,
    highlighted: v.highlighted,
    sort: toNumber(v.sort),
    priceMonth: v.priceMonth,
    priceYear: v.priceYear,
  };
}

/** Field errors arrive with the service's paths ("limits.maxDevices"); the form knows them by its own names. */
function mapFields(fields: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!fields) return fields;
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fields)) {
    const name =
      key === "limits.maxDevices" ? "maxDevices" : key === "limits.relayGbPerMonth" ? "relayGb" : key.startsWith("features") ? "features" : key.replace(/^limits\./, "");
    out[name] ??= message;
  }
  return out;
}

function toastSync(sync: SyncOutcome, saved: string) {
  if (sync.status === "failed") toast.warning(`${saved}, but Stripe was not updated`, { description: sync.error });
  else toast.success(sync.status === "synced" ? `${saved} and updated in Stripe` : saved);
}

export function PlanForm({ plan, initial, priceCurrency, defaultCurrency, stripeConnected, hasFreePlan }: PlanFormProps) {
  const router = useRouter();
  const creating = plan === null;
  const [keyEdited, setKeyEdited] = useState(Boolean(initial.key));
  const form = useSettingsForm<PlanFormValue>(
    initial,
    async (v) => {
      const result = creating ? await createPlanAction(toInput(v, true)) : await updatePlanAction(plan.id, toInput(v, false));
      if (!result.ok) return { ...result, fields: mapFields(result.fields) };
      toastSync(result.data.sync, creating ? "Plan created" : "Saved");
      if (creating) router.push("/admin/billing");
      else router.refresh();
      return { ok: true, data: v };
    },
    { success: null },
  );
  const { value, set, fields } = form;
  const free = creating ? value.isFree : plan.isFree;
  const archived = plan?.archived ?? false;
  const priceNote = (interval: "month" | "year") => {
    const current = priceCurrency[interval];
    if (current && current !== defaultCurrency) {
      return `Currently in ${current.toUpperCase()}. A new amount is created in ${defaultCurrency.toUpperCase()}, the default from Settings → Billing.`;
    }
    return `In ${defaultCurrency.toUpperCase()}. ${current ? "A changed amount becomes a new Stripe price; people already subscribed keep theirs." : "Leave empty to not offer this interval."}`;
  };

  return (
    <form onSubmit={form.submit} className="flex flex-col gap-5" noValidate>
      {archived && (
        <Callout tone="muted" title="This plan is archived">
          Nobody can subscribe to it any more; people who already pay for it keep it. Name, description and limits can still be
          edited. Prices cannot.
        </Callout>
      )}

      <SettingsGroup title="Plan" description="What people see on the billing page." icon={<Receipt />}>
        <TextRow
          id="plan-name"
          label="Name"
          description={creating ? "Shown on the billing page and, prefixed with “Godmode Cloud”, as the product in Stripe." : "Also renames the Stripe product on the next sync."}
          value={value.name}
          onChange={(v) => {
            set("name", v);
            if (creating && !keyEdited) set("key", slug(v));
          }}
          error={fields.name}
          maxLength={60}
          autoComplete="off"
        />
        {creating && (
          <TextRow
            id="plan-key"
            label="Key"
            description="Lower-case letters, digits and underscores. Names the Stripe lookup keys (godmode_cloud_<key>_month_usd) and cannot change later."
            value={value.key}
            onChange={(v) => {
              setKeyEdited(true);
              set("key", v.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
            }}
            error={fields.key}
            maxLength={40}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            mono
          />
        )}
        <SettingRow
          label="Description"
          htmlFor="plan-description"
          stacked
          description={
            <>
              One sentence under the name.
              {fields.description && (
                <span id="plan-description-error" role="alert" className="mt-1 block text-destructive">
                  {fields.description}
                </span>
              )}
            </>
          }
        >
          <Textarea
            id="plan-description"
            value={value.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={500}
            rows={2}
            aria-invalid={fields.description ? true : undefined}
            aria-describedby={fields.description ? "plan-description-error" : undefined}
          />
        </SettingRow>
        <SettingRow
          label="Features"
          stacked
          description={
            <>
              Bullet points on the plan card, up to {MAX_FEATURES}. The limits below are enforced; these lines only describe them.
              {fields.features && (
                <span role="alert" className="mt-1 block text-destructive">
                  {fields.features}
                </span>
              )}
            </>
          }
        >
          <ul className="flex flex-col gap-2">
            {value.features.map((feature, i) => (
              <li key={i} className="flex gap-2">
                <Input
                  aria-label={`Feature ${i + 1}`}
                  value={feature}
                  maxLength={120}
                  onChange={(e) => set("features", value.features.map((f, j) => (j === i ? e.target.value : f)))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (value.features.length < MAX_FEATURES) set("features", [...value.features.slice(0, i + 1), "", ...value.features.slice(i + 1)]);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove feature ${i + 1}`}
                  onClick={() => set("features", value.features.filter((_, j) => j !== i))}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={value.features.length ? "mt-2" : undefined}
            disabled={value.features.length >= MAX_FEATURES}
            onClick={() => set("features", [...value.features, ""])}
          >
            <Plus />
            Add feature
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Limits" description="What an account on this plan may use. Computers shared with others count against their owner's plan." icon={<Gauge />}>
        <LimitRow
          id="plan-max-devices"
          label="Computers"
          description="Linked computers per account. Over the limit, the oldest ones stay reachable and the rest wait."
          value={value.maxDevices}
          onChange={(v) => set("maxDevices", v)}
          unlimited={value.unlimitedDevices}
          onUnlimited={(v) => set("unlimitedDevices", v)}
          error={fields.maxDevices}
          min={0}
          step={1}
          unit="computers"
        />
        <LimitRow
          id="plan-relay-gb"
          label="Relay traffic"
          description="Per calendar month across the account's computers, in GB (1 GB = 1,000,000,000 bytes). Over the quota, computers cannot be reached through the cloud until the next month."
          value={value.relayGb}
          onChange={(v) => set("relayGb", v)}
          unlimited={value.unlimitedRelay}
          onUnlimited={(v) => set("unlimitedRelay", v)}
          error={fields.relayGb}
          min={0}
          step={0.1}
          unit="GB / month"
        />
        <SwitchRow
          id="plan-browser"
          label="Open computers in the browser"
          checked={value.browserAccess}
          onChange={(v) => set("browserAccess", v)}
          error={fields.browserAccess}
        />
        <SwitchRow
          id="plan-phone"
          label="Phone gateway"
          description="The Godmode phone app reaches the computers through this cloud."
          checked={value.phoneGateway}
          onChange={(v) => set("phoneGateway", v)}
          error={fields.phoneGateway}
        />
        <SwitchRow
          id="plan-sharing"
          label="Share computers with other accounts"
          checked={value.sharing}
          onChange={(v) => set("sharing", v)}
          error={fields.sharing}
        />
      </SettingsGroup>

      {creating && (
        <SettingsGroup title="Free plan" description="Everyone without a subscription or a granted plan is on the free plan. There is exactly one, and it is decided when the plan is created." icon={<ListChecks />}>
          <SwitchRow
            id="plan-free"
            label="This is the free plan"
            description={hasFreePlan ? "A free plan already exists." : "A free plan has no prices and no Stripe product."}
            checked={value.isFree}
            onChange={(v) => set("isFree", v)}
            disabled={hasFreePlan}
            error={fields.isFree}
          />
        </SettingsGroup>
      )}

      {!free && (
        <SettingsGroup
          title="Prices"
          description={stripeConnected ? "Stripe prices are created on save. People already subscribed keep the price they signed up for." : "Stored here now; created in Stripe once it is connected under Settings → Billing."}
          icon={<Receipt />}
        >
          <PriceRow
            id="plan-price-month"
            label="Per month"
            description={priceNote("month")}
            currency={priceCurrency.month ?? defaultCurrency}
            value={value.priceMonth}
            onChange={(v) => set("priceMonth", v)}
            error={fields.priceMonth}
            disabled={archived}
          />
          <PriceRow
            id="plan-price-year"
            label="Per year"
            description={priceNote("year")}
            currency={priceCurrency.year ?? defaultCurrency}
            value={value.priceYear}
            onChange={(v) => set("priceYear", v)}
            error={fields.priceYear}
            disabled={archived}
          />
        </SettingsGroup>
      )}

      <SettingsGroup title="Visibility" description="Where the plan appears." icon={<Eye />}>
        <SwitchRow
          id="plan-public"
          label="Offer on the billing page"
          description="Off: nobody can pick it, but it can still be granted to people from the admin area."
          checked={value.isPublic}
          onChange={(v) => set("isPublic", v)}
          error={fields.isPublic}
        />
        <SwitchRow
          id="plan-highlighted"
          label="Highlight"
          description="Marks it as the recommended plan on the billing page."
          checked={value.highlighted}
          onChange={(v) => set("highlighted", v)}
          error={fields.highlighted}
        />
        <NumberRow id="plan-sort" label="Order" description="Plans are listed from the lowest number up." min={0} max={10_000} value={value.sort} onChange={(v) => set("sort", v)} error={fields.sort} />
      </SettingsGroup>

      <SaveBar form={form} label={creating ? "Create plan" : "Save"} pendingLabel={creating ? "Creating…" : "Saving…"} />

      {plan && !plan.isFree && !plan.archived && (
        <SettingsGroup
          title="Archive"
          description="Takes the plan off the billing page for good. Subscriptions to it continue until their owners cancel or change."
          icon={<Archive />}
          tone="danger"
        >
          <SettingRow label="Archive this plan" description="Cannot be undone. The Stripe product is deactivated on sync.">
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  Archive
                </Button>
              }
              title={`Archive “${value.name}”?`}
              description="Nobody can subscribe to it any more. People who already pay for it keep it until they change or cancel."
              confirmLabel="Archive plan"
              pendingLabel="Archiving…"
              tone="danger"
              onConfirm={async () => {
                const result = await archivePlanAction(plan.id);
                if (result.ok) {
                  toastSync(result.data.sync, "Plan archived");
                  router.push("/admin/billing");
                }
                return result;
              }}
            />
          </SettingRow>
        </SettingsGroup>
      )}
    </form>
  );
}

function LimitRow({
  id,
  label,
  description,
  value,
  onChange,
  unlimited,
  onUnlimited,
  error,
  min,
  step,
  unit,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  unlimited: boolean;
  onUnlimited: (v: boolean) => void;
  error?: string;
  min: number;
  step: number;
  unit: string;
}) {
  return (
    <SettingRow
      label={label}
      htmlFor={id}
      description={
        <>
          {description}
          {error && (
            <span id={`${id}-error`} role="alert" className="mt-1 block text-destructive">
              {error}
            </span>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={min}
            step={step}
            value={unlimited ? "" : value}
            placeholder={unlimited ? "∞" : undefined}
            disabled={unlimited}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="w-24 text-right font-mono tabular-nums"
          />
          <span className="w-20 text-xs text-muted-foreground">{unit}</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch size="sm" checked={unlimited} onCheckedChange={onUnlimited} aria-label={`Unlimited ${label.toLowerCase()}`} />
          Unlimited
        </label>
      </div>
    </SettingRow>
  );
}

function PriceRow({
  id,
  label,
  description,
  currency,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  currency: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <SettingRow
      label={label}
      htmlFor={id}
      disabled={disabled}
      description={
        <>
          {description}
          {error && (
            <span id={`${id}-error`} role="alert" className="mt-1 block text-destructive">
              {error}
            </span>
          )}
        </>
      }
    >
      <StatusBadge dot={false} className="font-mono uppercase">
        {currency}
      </StatusBadge>
      <Input
        id={id}
        inputMode="decimal"
        placeholder="9.90"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="w-28 text-right font-mono tabular-nums"
      />
    </SettingRow>
  );
}
