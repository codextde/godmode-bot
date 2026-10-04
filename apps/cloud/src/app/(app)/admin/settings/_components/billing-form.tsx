"use client";

import Link from "next/link";
import { Percent, ShoppingCart } from "lucide-react";
import { Segmented } from "@/components/controls";
import { SettingRow, SettingsGroup } from "@/components/settings-kit";
import type { BillingSettings } from "@/server/settings/registry";
import { saveBillingOptionsAction, type BillingOptionsInput } from "../actions";
import { NumberRow, SaveBar, SwitchRow, TextRow, toNumber } from "./fields";
import { useSettingsForm } from "./use-settings-form";

type BillingFormValue = Omit<BillingOptionsInput, "trialDays" | "pastDueGraceDays"> & { trialDays: string; pastDueGraceDays: string };

function toForm(s: BillingSettings): BillingFormValue {
  return {
    currency: s.currency,
    trialDays: String(s.trialDays),
    allowPromotionCodes: s.allowPromotionCodes,
    automaticTax: s.automaticTax,
    taxBehavior: s.taxBehavior,
    taxIdCollection: s.taxIdCollection,
    requireTermsConsent: s.requireTermsConsent,
    pastDueGraceDays: String(s.pastDueGraceDays),
  };
}

export function BillingOptionsForm({
  initial,
  termsUrl,
  canEditGeneral,
}: {
  initial: BillingSettings;
  termsUrl: string;
  /** Whether this person may open Settings → General (to add a terms link). */
  canEditGeneral: boolean;
}) {
  const form = useSettingsForm<BillingFormValue>(toForm(initial), async (v) => {
    const result = await saveBillingOptionsAction({ ...v, trialDays: toNumber(v.trialDays), pastDueGraceDays: toNumber(v.pastDueGraceDays) });
    return result.ok ? { ok: true, data: toForm(result.data) } : result;
  });
  const { value, set, fields } = form;

  return (
    <form onSubmit={form.submit} className="flex flex-col gap-5" noValidate>
      <SettingsGroup title="Checkout" description="What people see and get when they subscribe." icon={<ShoppingCart />}>
        <TextRow
          id="billing-currency"
          label="Currency"
          description="Three-letter code (usd, eur, gbp, …) for new prices. Prices that already exist keep their currency; Stripe never changes a price."
          value={value.currency}
          onChange={(v) => set("currency", v.toLowerCase())}
          error={fields.currency}
          maxLength={3}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          mono
          className="w-28"
        />
        <NumberRow
          id="billing-trial-days"
          label="Free trial"
          description="Days a new subscriber uses a paid plan before the first charge. 0 means no trial."
          unit="days"
          min={0}
          max={365}
          value={value.trialDays}
          onChange={(v) => set("trialDays", v)}
          error={fields.trialDays}
        />
        <SwitchRow
          id="billing-promo"
          label="Promotion codes"
          description="Checkout shows a field for codes you create in Stripe."
          checked={value.allowPromotionCodes}
          onChange={(v) => set("allowPromotionCodes", v)}
          error={fields.allowPromotionCodes}
        />
        <SwitchRow
          id="billing-terms"
          label="Ask people to accept your terms"
          description={
            termsUrl ? (
              <>
                Checkout shows a checkbox linking to{" "}
                <a href={termsUrl} target="_blank" rel="noreferrer" className="font-medium text-foreground underline-offset-4 hover:underline">
                  your terms
                </a>
                .
              </>
            ) : canEditGeneral ? (
              <>
                Needs a link to your terms under{" "}
                <Link href="/admin/settings/general" className="font-medium text-foreground underline-offset-4 hover:underline">
                  Settings → General
                </Link>{" "}
                first.
              </>
            ) : (
              "Needs a link to your terms under Settings → General first, which an owner or admin can add."
            )
          }
          checked={value.requireTermsConsent}
          onChange={(v) => set("requireTermsConsent", v)}
          disabled={!termsUrl && !value.requireTermsConsent}
          error={fields.requireTermsConsent}
        />
        <NumberRow
          id="billing-grace"
          label="Keep the plan after a failed payment for"
          description="Stripe retries failed payments for a while. During these days the account keeps its plan; afterwards it drops to the free plan until the payment goes through. 0 to 60 days."
          unit="days"
          min={0}
          max={60}
          value={value.pastDueGraceDays}
          onChange={(v) => set("pastDueGraceDays", v)}
          error={fields.pastDueGraceDays}
        />
      </SettingsGroup>

      <SettingsGroup title="Tax" description="Needs Stripe Tax in your Stripe account to do anything." icon={<Percent />}>
        <SwitchRow
          id="billing-auto-tax"
          label="Calculate tax at checkout"
          description="Stripe Tax works out the tax from the customer's address. Without Stripe Tax set up in your account, checkout fails with this on."
          checked={value.automaticTax}
          onChange={(v) => set("automaticTax", v)}
          error={fields.automaticTax}
        />
        <SettingRow
          label="Plan prices are"
          description="Whether the amounts on your plans already include tax. Applies to prices created from now on."
        >
          <Segmented
            aria-label="Tax behaviour"
            value={value.taxBehavior}
            onChange={(v) => set("taxBehavior", v)}
            options={[
              { value: "inclusive", label: "Including tax" },
              { value: "exclusive", label: "Plus tax" },
            ]}
          />
        </SettingRow>
        <SwitchRow
          id="billing-tax-id"
          label="Ask businesses for their tax ID"
          description="Checkout offers a field for a VAT or other tax ID, which then appears on invoices."
          checked={value.taxIdCollection}
          onChange={(v) => set("taxIdCollection", v)}
          error={fields.taxIdCollection}
        />
      </SettingsGroup>

      <SaveBar form={form} />
    </form>
  );
}
