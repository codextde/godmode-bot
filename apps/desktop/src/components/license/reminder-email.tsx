import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { BellRing, CircleCheck, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { currentLanguage } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/**
 * The optional address for a heads-up before the free trial ends, plus a few tips. Nothing leaves the computer until
 * the human types it in and sends it; the core passes it to usegodmode.com.
 */
export function ReminderEmailForm({ onSkip, onSaved, className }: { onSkip?: () => void; onSaved?: () => void; className?: string }) {
  const { t } = useTranslation("license");
  const qc = useQueryClient();
  const id = useId();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!EMAIL.test(email.trim())) {
      setError(t("reminders.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(qk.license, await api.license.setReminders({ email: email.trim(), locale: currentLanguage() }));
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} noValidate className={cn("space-y-2.5", className)}>
      <label htmlFor={id} className="flex items-start gap-2.5">
        <BellRing className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm">
          <span className="font-medium">{t("reminders.title")}</span>{" "}
          <span className="text-muted-foreground">{t("reminders.body")}</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2 pl-6.5">
        <div className="relative min-w-48 flex-1">
          <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id={id}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder={t("reminders.placeholder")}
            autoComplete="email"
            spellCheck={false}
            maxLength={254}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            className="h-9 pl-9 text-[13px] md:text-[13px]"
          />
        </div>
        <Button type="submit" variant="outline" className="h-9 px-3.5" disabled={busy || !email.trim()}>
          {busy && <Spinner />}
          {t("reminders.save")}
        </Button>
        {onSkip && (
          <Button type="button" variant="ghost" className="h-9 px-3 text-muted-foreground" onClick={onSkip}>
            {t("reminders.skip")}
          </Button>
        )}
      </div>
      {error && (
        <motion.p id={`${id}-error`} role="alert" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} className="pl-6.5 text-[13px] text-destructive">
          {error}
        </motion.p>
      )}
    </form>
  );
}

/** "Reminders go to x@y" with a way to take it back (unsubscribes on usegodmode.com too). */
export function ReminderEmailSet({ email, className }: { email: string; className?: string }) {
  const { t } = useTranslation("license");
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(qk.license, await api.license.removeReminders());
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
        <span className="min-w-0 truncate">{t("reminders.goTo", { email })}</span>
        <Button type="button" variant="ghost" size="xs" className="ml-auto h-7 px-2 text-muted-foreground" onClick={remove} disabled={busy}>
          {busy && <Spinner />}
          {t("reminders.remove")}
        </Button>
      </div>
      {error && <p role="alert" className="mt-1.5 pl-6.5 text-[13px] text-destructive">{error}</p>}
    </div>
  );
}
