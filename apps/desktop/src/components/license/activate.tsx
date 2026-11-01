import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowUpRight, Check, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LICENSE_PRICING, LICENSE_SITE, LICENSE_YEARLY_SAVINGS, isLicenseKey, normalizeLicenseKey, type LicenseState } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { noteCheckoutOpened } from "./deep-link";

export type LicenseSource = "gate" | "onboarding" | "settings" | "banner" | "sidebar";
export type CheckoutPlan = "monthly" | "yearly";

export const SUPPORT_MAIL = "kontakt@codext.de";

/** Straight to a paid plan: the free trial in the app replaces the card trial (`trial=0`). */
export function checkoutUrl(source: LicenseSource, plan: CheckoutPlan = "monthly"): string {
  return `${LICENSE_SITE}/api/checkout?plan=${plan}&trial=0&utm_source=app&utm_medium=${source}`;
}

/** The licence key field: upper case as typed, checked before it goes to the core, errors right under it. */
export function LicenseKeyForm({
  onActivated,
  autoFocus,
  focusOnReturn,
  submitLabel,
  className,
}: {
  onActivated?: (state: LicenseState) => void;
  autoFocus?: boolean;
  /** Focus the field when the window comes back (from the checkout in the browser), ready for the pasted key. */
  focusOnReturn?: boolean;
  submitLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation("license");
  const qc = useQueryClient();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!focusOnReturn) return;
    const focus = () => input.current?.focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [focusOnReturn]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const value = normalizeLicenseKey(key);
    if (!isLicenseKey(value)) {
      setError(t("keyForm.invalid", { format: "GM-XXXXX-XXXXX-XXXXX-XXXXX" }));
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const state = await api.license.set(value);
      qc.setQueryData(qk.license, state);
      if (state.blocked) {
        setError(state.message ?? t("keyForm.cantUse"));
        setBusy(false);
        return;
      }
      setKey("");
      toast.success(state.status === "trial" ? t("keyForm.trialActive") : t("keyForm.activated"), {
        description: state.status === "unverified" ? (state.message ?? undefined) : undefined,
      });
      onActivated?.(state);
    } catch (err) {
      setError(errorMessage(err));
      input.current?.focus();
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className={cn("space-y-2", className)} noValidate>
      <Label htmlFor={id} className="text-[13px]">
        {t("keyForm.label")}
      </Label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={input}
            id={id}
            value={key}
            onChange={(e) => {
              setKey(e.target.value.toUpperCase());
              if (error) setError(null);
            }}
            placeholder="GM-XXXXX-XXXXX-XXXXX-XXXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={64}
            autoFocus={autoFocus}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            className="h-10 pl-9 font-mono text-[13px] md:text-[13px]"
          />
        </div>
        <Button type="submit" variant="outline" className="h-10 px-3.5" disabled={busy || !key.trim()}>
          {busy && <Spinner />}
          {submitLabel ?? t("keyForm.activate")}
        </Button>
      </div>
      {error && (
        <motion.p id={`${id}-error`} role="alert" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} className="text-[13px] text-destructive">
          {error}
        </motion.p>
      )}
    </form>
  );
}

export function KeyDivider({ className }: { className?: string }) {
  const { t } = useTranslation("license");
  return (
    <div className={cn("flex items-center gap-3 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase", className)}>
      <span className="h-px flex-1 bg-border" />
      {t("divider")}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** "$39/month" or "$348/year", in the app's language. */
export function usePrice() {
  const { t } = useTranslation("license");
  return (plan: CheckoutPlan) =>
    plan === "yearly" ? t("plans.perYear", { price: LICENSE_PRICING.yearly.price }) : t("plans.perMonth", { price: LICENSE_PRICING.monthly.price });
}

/** Monthly or yearly, and the button that opens the checkout in the browser. */
export function PlanPicker({
  source,
  cta,
  onCheckout,
  className,
}: {
  source: LicenseSource;
  /** "keep": the end of the free trial ("Keep Godmode"); "subscribe" everywhere else. */
  cta: "keep" | "subscribe";
  onCheckout?: () => void;
  className?: string;
}) {
  const { t } = useTranslation("license");
  const price = usePrice();
  const [plan, setPlan] = useState<CheckoutPlan>("monthly");
  const [opened, setOpened] = useState(false);
  const options: { plan: CheckoutPlan; title: string; perMonth: number; note: string; badge?: string }[] = [
    { plan: "monthly", title: t("plans.monthly"), perMonth: LICENSE_PRICING.monthly.perMonth, note: t("plans.billedMonthly") },
    {
      plan: "yearly",
      title: t("plans.yearly"),
      perMonth: LICENSE_PRICING.yearly.perMonth,
      note: t("plans.billedYearly", { price: LICENSE_PRICING.yearly.price }),
      badge: t("plans.save", { percent: LICENSE_YEARLY_SAVINGS }),
    },
  ];

  return (
    <div className={className}>
      <div role="radiogroup" aria-label={t("plans.label")} className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const selected = plan === o.plan;
          return (
            <button
              key={o.plan}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPlan(o.plan)}
              className={cn(
                "relative rounded-xl border bg-card px-4 py-3.5 text-left transition-[border-color,box-shadow,background-color] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                selected ? "border-brand-strong/50 bg-brand-soft/40 shadow-[0_0_0_1px_var(--brand-strong)]" : "hover:border-foreground/20",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                    selected ? "border-brand-strong bg-brand-strong text-white dark:text-background" : "border-foreground/25",
                  )}
                  aria-hidden
                >
                  {selected && <Check className="size-2.5" strokeWidth={3.5} />}
                </span>
                <span className="text-[13px] font-medium">{o.title}</span>
                {o.badge && <span className="ml-auto rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-strong">{o.badge}</span>}
              </span>
              <span className="mt-2 flex items-baseline gap-1">
                <span className="text-[26px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{t("plans.amount", { price: o.perMonth })}</span>
                <span className="text-[13px] text-muted-foreground">{t("plans.month")}</span>
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{o.note}</span>
            </button>
          );
        })}
      </div>

      <Button
        size="lg"
        className="mt-4 h-12 w-full rounded-xl text-[15px]"
        onClick={() => {
          setOpened(true);
          noteCheckoutOpened();
          onCheckout?.();
          void openExternal(checkoutUrl(source, plan));
        }}
      >
        <span>{cta === "keep" ? t("plans.keep") : t("plans.subscribe")}</span>
        <span className="font-normal opacity-60">·</span>
        <span className="font-normal opacity-85">{price(plan)}</span>
        <ArrowUpRight className="opacity-70" />
      </Button>
      <p className="mt-3 text-center text-xs leading-relaxed text-pretty text-muted-foreground">
        {opened ? t("plans.finishCheckout") : t("plans.guarantee", { days: LICENSE_PRICING.guaranteeDays })}
      </p>
    </div>
  );
}

/** Everything it takes to get a licence: the plans, a key, and help when the key is lost. */
export function ActivatePanel({
  source,
  cta = "subscribe",
  onActivated,
  autoFocus,
}: {
  source: LicenseSource;
  cta?: "keep" | "subscribe";
  onActivated?: (state: LicenseState) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("license");
  const [checkingOut, setCheckingOut] = useState(false);
  return (
    <div>
      <PlanPicker source={source} cta={cta} onCheckout={() => setCheckingOut(true)} />

      <KeyDivider className="my-6" />

      <LicenseKeyForm onActivated={onActivated} autoFocus={autoFocus} focusOnReturn={checkingOut} />

      <p className="mt-4 text-xs text-muted-foreground">
        <button
          type="button"
          className="font-medium text-foreground underline-offset-4 hover:underline"
          onClick={() => void openExternal(`mailto:${SUPPORT_MAIL}?subject=${encodeURIComponent("Lost Godmode licence key")}`)}
        >
          {t("panel.lostKey")}
        </button>{" "}
        {t("panel.lostKeyHint")}
      </p>
    </div>
  );
}
