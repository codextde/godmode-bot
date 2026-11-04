import { useTranslation } from "react-i18next";
import type { CallStatus, PhoneCall } from "@godmode/shared";
import { intlLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Languages a call can start in (ISO 639-1). */
export const CALL_LANGUAGES: { code: string; readonly label: string }[] = [
  "en", "de", "fr", "es", "it", "nl", "pl", "pt", "tr", "sv", "da", "no", "fi", "cs", "ro", "el", "uk", "ru", "ar", "hi", "ja", "ko", "zh"
].map((code) => ({
  code,
  get label() {
    return new Intl.DisplayNames([intlLocale()], { type: "language" }).of(code) ?? code;
  },
}));

export const CALL_STATUS = {
  calling: { labelKey: "status.calling", dot: "bg-brand animate-live-dot", text: "text-foreground" },
  in_progress: { labelKey: "status.inProgress", dot: "bg-success animate-live-dot", text: "text-foreground" },
  processing: { labelKey: "status.processing", dot: "bg-warning animate-pulse", text: "text-muted-foreground" },
  done: { labelKey: "status.done", dot: "bg-success", text: "text-foreground/80" },
  no_answer: { labelKey: "status.noAnswer", dot: "bg-muted-foreground/45", text: "text-muted-foreground" },
  voicemail: { labelKey: "status.voicemail", dot: "bg-sky-500", text: "text-foreground/80" },
  failed: { labelKey: "status.failed", dot: "bg-destructive", text: "text-destructive" },
} as const satisfies Record<CallStatus, { labelKey: string; dot: string; text: string }>;

export function CallStatusPill({ status, className }: { status: CallStatus; className?: string }) {
  const { t } = useTranslation("calls");
  const meta = CALL_STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", meta.text, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {t(meta.labelKey)}
    </span>
  );
}

/** An incoming call from the owner's own number. */
const CALLER_BADGE = {
  pinVerified: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  pinWrong: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  ownerCall: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
} as const;

/** Who the caller proved to be: the PIN says more than the caller ID. */
export function CallerBadge({ call, className }: { call: Pick<PhoneCall, "ownerVerified" | "pinWrong" | "fromOwner">; className?: string }) {
  const { t } = useTranslation("calls");
  const kind = call.ownerVerified ? "pinVerified" : call.pinWrong ? "pinWrong" : call.fromOwner ? "ownerCall" : null;
  if (!kind) return null;
  return (
    <span title={t(`${kind}.title`)} className={cn("inline-flex items-center rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", CALLER_BADGE[kind], className)}>
      {t(`${kind}.label`)}
    </span>
  );
}

/** Who the call was with: the contact's name, else the number. */
export function callName(c: Pick<PhoneCall, "contactName" | "number" | "direction">): string {
  return c.contactName || c.number || (c.direction === "inbound" ? t("calls:unknownCaller") : t("calls:unknownNumber"));
}

/** Seconds as a call timer: 0:07, 3:12, 1:02:03. */
export function formatCallTime(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** What the telephony provider charged for a call. */
export function formatCallCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}
