import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowUpRight, KeyRound, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LICENSE_SITE, isLicenseKey, normalizeLicenseKey, type LicenseState } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export type LicenseSource = "gate" | "onboarding" | "settings" | "banner";

export const SUPPORT_MAIL = "kontakt@codext.de";

export function checkoutUrl(source: LicenseSource, plan: "monthly" | "yearly" = "monthly"): string {
  return `${LICENSE_SITE}/api/checkout?plan=${plan}&utm_source=app&utm_medium=${source}`;
}

export const PLANS_URL = `${LICENSE_SITE}/#pricing`;

/** The licence key field: upper case as typed, checked before it goes to the core, errors right under it. */
export function LicenseKeyForm({
  onActivated,
  autoFocus,
  submitLabel,
  className,
}: {
  onActivated?: (state: LicenseState) => void;
  autoFocus?: boolean;
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
    } finally {
      setBusy(false);
    }
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

/** Everything it takes to get a licence: the trial, the plans, a key, and help when the key is lost. */
export function ActivatePanel({
  source,
  onActivated,
  autoFocus,
}: {
  source: LicenseSource;
  onActivated?: (state: LicenseState) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("license");
  const [opened, setOpened] = useState(false);
  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          size="lg"
          className="flex-1"
          onClick={() => {
            setOpened(true);
            void openExternal(checkoutUrl(source));
          }}
        >
          <Sparkles /> {t("panel.startTrial")}
        </Button>
        <Button size="lg" variant="outline" className="sm:w-36" onClick={() => void openExternal(PLANS_URL)}>
          {t("panel.seePlans")} <ArrowUpRight className="text-muted-foreground" />
        </Button>
      </div>
      <p className="mt-2.5 text-center text-xs text-muted-foreground">
        {opened ? t("panel.finishCheckout") : t("panel.pricing")}
      </p>

      <KeyDivider className="my-6" />

      <LicenseKeyForm onActivated={onActivated} autoFocus={autoFocus} />

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
