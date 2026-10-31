import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { isCallActive, type CallStatus, type PhoneCall } from "@godmode/shared";
import { Badge, tap } from "./ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Events refresh the calls; while one is on it is polled as well, so its status never lags. */
const LIVE_POLL = 5_000;

export const callListQuery = {
  queryKey: ["calls", "list"],
  queryFn: () => api.calls.list(200),
  refetchInterval: (q: { state: { data?: PhoneCall[] } }) => (q.state.data?.some(isCallActive) ? LIVE_POLL : false),
};

export const callQuery = (id: string) => ({
  queryKey: ["calls", "detail", id],
  queryFn: () => api.calls.get(id),
  refetchInterval: (q: { state: { data?: PhoneCall } }) => (q.state.data && isCallActive(q.state.data) ? LIVE_POLL : false),
});

export const CALL_STATUS: Record<CallStatus, { tone: "neutral" | "brand" | "warning" | "danger"; live?: boolean }> = {
  calling: { tone: "brand", live: true },
  in_progress: { tone: "brand", live: true },
  processing: { tone: "warning", live: true },
  done: { tone: "brand" },
  no_answer: { tone: "neutral" },
  voicemail: { tone: "neutral" },
  failed: { tone: "danger" },
};

export function CallStatusBadge({ status }: { status: CallStatus }) {
  const { t } = useTranslation("components");
  const known = CALL_STATUS[status] ? status : "done";
  const meta = CALL_STATUS[known];
  return <Badge label={t(`callParts.status.${known}`)} tone={meta.tone} live={meta.live} />;
}

/** Who the call was with: the contact's name, else the number. */
export function callName(c: Pick<PhoneCall, "contactName" | "number" | "direction">): string {
  return c.contactName || c.number || (c.direction === "inbound" ? t("components:callParts.unknownCaller") : t("components:callParts.unknownNumber"));
}

/** Seconds as a call timer: 0:07, 3:12, 1:02:03. */
export function formatCallTime(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return "–";
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

export function openCall(id: string) {
  tap();
  router.push({ pathname: "/call/[id]", params: { id } });
}
