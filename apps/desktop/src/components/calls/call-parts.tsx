import type { CallStatus, PhoneCall } from "@godmode/shared";
import { cn } from "@/lib/utils";

/** Languages a call can start in (ISO 639-1). */
export const CALL_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "tr", label: "Turkish" },
  { code: "sv", label: "Swedish" },
  { code: "da", label: "Danish" },
  { code: "no", label: "Norwegian" },
  { code: "fi", label: "Finnish" },
  { code: "cs", label: "Czech" },
  { code: "ro", label: "Romanian" },
  { code: "el", label: "Greek" },
  { code: "uk", label: "Ukrainian" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];

export const CALL_STATUS: Record<CallStatus, { label: string; dot: string; text: string }> = {
  calling: { label: "Ringing", dot: "bg-brand animate-live-dot", text: "text-foreground" },
  in_progress: { label: "On the line", dot: "bg-success animate-live-dot", text: "text-foreground" },
  processing: { label: "Wrapping up", dot: "bg-warning animate-pulse", text: "text-muted-foreground" },
  done: { label: "Done", dot: "bg-success", text: "text-foreground/80" },
  no_answer: { label: "No answer", dot: "bg-muted-foreground/45", text: "text-muted-foreground" },
  voicemail: { label: "Voicemail left", dot: "bg-sky-500", text: "text-foreground/80" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
};

export function CallStatusPill({ status, className }: { status: CallStatus; className?: string }) {
  const meta = CALL_STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", meta.text, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

/** An incoming call from the owner's own number. */
export function OwnerCallBadge({ className }: { className?: string }) {
  return (
    <span
      title="Came from your own number: its requests go to your agent as yours"
      className={cn("inline-flex items-center rounded-[5px] border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-sky-700 dark:text-sky-300", className)}
    >
      Owner call
    </span>
  );
}

/** Who the call was with: the contact's name, else the number. */
export function callName(c: Pick<PhoneCall, "contactName" | "number" | "direction">): string {
  return c.contactName || c.number || (c.direction === "inbound" ? "Unknown caller" : "Unknown number");
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
