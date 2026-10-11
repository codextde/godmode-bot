import type { ReactNode } from "react";
import type { Conversation } from "@godmode/shared";
import { AlarmClock, Hourglass, MessageCircleQuestion, Pause } from "lucide-react";
import { followupWhen } from "./followup";

type ChatState = Pick<Conversation, "paused" | "followup">;

/** What a chat still has ahead, the way chat lists say it: working, standing still, or continuing by itself later. Null: nothing. */
export function chatStatus(c: ChatState, live: { running?: boolean; queued?: boolean }): ReactNode {
  if (live.running && !c.paused) return <span className="text-shimmer font-medium">Working…</span>;
  if (live.queued && !c.paused) return <span>Queued — waiting for a free slot</span>;
  if (c.paused?.reason === "question") {
    return (
      <span className="flex items-center gap-1 text-foreground" title={c.paused.question?.title}>
        <MessageCircleQuestion className="size-3 shrink-0 text-warning" aria-hidden />
        <span className="truncate">
          {c.paused.question?.kind === "approval" ? "Needs your OK" : "Needs your answer"}
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
            ? "Paused"
            : c.paused.reason === "budget"
              ? "Held — budget used up"
              : c.paused.auto && c.paused.resumeAt
                ? `Continues ${followupWhen(c.paused.resumeAt)}`
                : "Waiting for the limit"}
        </span>
      </span>
    );
  }
  if (c.followup) {
    return (
      <span className="flex items-center gap-1" title={c.followup.note}>
        <AlarmClock className="size-3 shrink-0 text-brand-strong" aria-hidden />
        <span className="truncate">Continues {followupWhen(c.followup.dueAt)}</span>
      </span>
    );
  }
  return null;
}

/** What archiving a chat leaves untouched, for the toast: "continues today at 18:00", "still working". Null: nothing. */
export function stillAhead(c: ChatState, running: boolean): string | null {
  const p = c.paused;
  if (p?.reason === "question") return p.question?.kind === "approval" ? "still needs your OK" : "still needs your answer";
  if (p?.reason === "user") return "still paused";
  if (p?.reason === "budget") return "held until the budget has room";
  if (p) return p.auto && p.resumeAt ? `continues ${followupWhen(p.resumeAt)}` : "waits for you after the limit";
  if (running) return "still working";
  return c.followup ? `continues ${followupWhen(c.followup.dueAt)}` : null;
}
