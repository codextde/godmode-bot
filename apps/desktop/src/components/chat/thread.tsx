import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, Conversation, Message } from "@godmode/shared";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { dateLocale, t } from "@/i18n";
import type { LiveRun } from "@/stores/live";
import { AssistantMessage, LiveAssistantMessage, StartedMessage, SystemMessage, UserMessage } from "./messages";
import { useStickToBottom } from "./use-stick-to-bottom";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (isToday(d)) return t("common:words.today");
  if (isYesterday(d)) return t("common:words.yesterday");
  return format(d, d.getFullYear() === new Date().getFullYear() ? t("chat:thread.dayFormat") : t("chat:thread.dayFormatYear"), { locale: dateLocale() });
}

export interface ThreadProps {
  messages: Message[];
  agent?: Agent;
  /** In-flight turn: live blocks (or null while waiting for the first delta) */
  inflight: { live: LiveRun | null; startedAt: number; runId: string | null } | null;
  onStop?: () => void;
  stopping?: boolean;
  onPause?: () => void;
  pausing?: boolean;
  /** Rendered when there are no messages and nothing in flight */
  empty?: ReactNode;
  /** A handed-over chat: who asked (names the opening message). */
  delegatedFrom?: Conversation["delegatedFrom"];
  /** Under the last message while nothing is in flight (what to do about a turn that ended early). */
  after?: ReactNode;
  focusId?: string | null;
}

export function Thread({ messages, agent, inflight, onStop, stopping, onPause, pausing, empty, delegatedFrom, after, focusId }: ThreadProps) {
  const { t } = useTranslation("chat");
  const { scrollRef, contentRef, atBottom, scrollToBottom, unstick } = useStickToBottom();
  const [flash, setFlash] = useState<string | null>(null);
  const focusPresent = !!focusId && messages.some((m) => m.id === focusId);
  useEffect(() => {
    if (!focusId || !focusPresent) return;
    const el = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(focusId)}"]`);
    if (!el) return;
    unstick();
    const frame = requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
    setFlash(focusId);
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [focusId, focusPresent, scrollRef, unstick]);
  // Messages present on first render don't animate in
  const initialIds = useRef<Set<string> | null>(null);
  if (initialIds.current === null) initialIds.current = new Set(messages.map((m) => m.id));

  const isEmpty = messages.length === 0 && !inflight;
  let lastDay = "";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain" tabIndex={-1} aria-label={t("thread.messages")}>
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6 pb-10 @xl:px-6">
          {isEmpty && empty}
          {messages.map((m) => {
            const day = dayLabel(m.createdAt);
            const showDay = day && day !== lastDay;
            lastDay = day || lastDay;
            const animate = !initialIds.current!.has(m.id);
            return (
              <Fragment key={m.id}>
                {showDay && (
                  <div className="eyebrow flex items-center gap-3 text-[10.5px]" role="separator">
                    <span className="h-px flex-1 bg-border" />
                    {day}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <motion.div
                  data-message-id={m.id}
                  className={`rounded-xl transition-shadow duration-700 ${flash === m.id ? "ring-2 ring-primary/40 ring-offset-4 ring-offset-background" : "ring-0"}`}
                  initial={animate ? { opacity: 0, y: 8 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  {m.role === "user" && m.source ? (
                    <StartedMessage message={m} delegatedFrom={delegatedFrom} />
                  ) : m.role === "user" ? (
                    <UserMessage message={m} pending={m.id.startsWith("pending-")} />
                  ) : m.role === "assistant" ? (
                    <AssistantMessage message={m} agent={agent} />
                  ) : (
                    <SystemMessage message={m} />
                  )}
                </motion.div>
              </Fragment>
            );
          })}
          {!inflight && after}
          {inflight && (
            <LiveAssistantMessage
              key={inflight.runId ?? "pending"}
              agent={agent}
              live={inflight.live}
              startedAt={inflight.startedAt}
              onStop={inflight.runId ? onStop : undefined}
              stopping={stopping}
              onPause={inflight.runId ? onPause : undefined}
              pausing={pausing}
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {!atBottom && !isEmpty && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            onClick={() => scrollToBottom()}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md glass px-3 py-1.5 text-xs font-medium transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ArrowDown className="size-3.5" />
            {inflight ? t("thread.jumpToLive") : t("thread.jumpToLatest")}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
