import type { ReactNode } from "react";
import type { Conversation } from "@godmode/shared";
import { AlarmClock, Hourglass, MessageCircleQuestion, Pause } from "lucide-react";
import { t } from "@/i18n";
import { followupWhen } from "./followup";

type ChatState = Pick<Conversation, "paused" | "followup">;

/** What a chat still has ahead, the way chat lists say it: working, standing still, or continuing by itself later. Null: nothing. */
export function chatStatus(c: ChatState, live: { running?: boolean; queued?: boolean }): ReactNode {
  if (live.running && !c.paused) return <span className="text-shimmer font-medium">{t("chat:status.working")}</span>;
  if (live.queued && !c.paused) return <span>{t("chat:status.queuedWaiting")}</span>;
  if (c.paused?.reason === "question") {
    return (
      <span className="flex items-center gap-1 text-foreground" title={c.paused.question?.title}>
        <MessageCircleQuestion className="size-3 shrink-0 text-warning" aria-hidden />
        <span className="truncate">
          {c.paused.question?.kind === "approval" ? t("chat:status.needsOk") : t("chat:status.needsAnswer")}
          {c.paused.question?.title ? ` · ${c.paused.question.title}` : ""}
        </span>
      </span>
    );
  }
  if (c.paused) {
    return (
      <span className="flex items-center gap-1">
        {c.paused.reason === "limit" ? <Hourglass className="size-3 shrink-0 text-warning" aria-hidden /> : <Pause className="size-3 shrink-0 fill-current" aria-hidden />}
        <span className="truncate">
          {c.paused.reason === "user"
            ? t("chat:status.paused")
            : c.paused.auto && c.paused.resumeAt
              ? t("chat:followup.continuesWhen", { when: followupWhen(c.paused.resumeAt) })
              : t("chat:status.waitingForLimit")}
        </span>
      </span>
    );
  }
  if (c.followup) {
    return (
      <span className="flex items-center gap-1" title={c.followup.note}>
        <AlarmClock className="size-3 shrink-0 text-brand-strong" aria-hidden />
        <span className="truncate">{t("chat:followup.continuesWhen", { when: followupWhen(c.followup.dueAt) })}</span>
      </span>
    );
  }
  return null;
}

/** What archiving a chat leaves untouched, for the toast: "continues today at 18:00", "still working". Null: nothing. */
export function stillAhead(c: ChatState, running: boolean): string | null {
  const p = c.paused;
  if (p?.reason === "question") return p.question?.kind === "approval" ? t("chat:stillAhead.needsOk") : t("chat:stillAhead.needsAnswer");
  if (p?.reason === "user") return t("chat:stillAhead.paused");
  if (p) return p.auto && p.resumeAt ? t("chat:stillAhead.continues", { when: followupWhen(p.resumeAt) }) : t("chat:stillAhead.afterLimit");
  if (running) return t("chat:stillAhead.working");
  return c.followup ? t("chat:stillAhead.continues", { when: followupWhen(c.followup.dueAt) }) : null;
}
