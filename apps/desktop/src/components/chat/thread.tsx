import { Fragment, useRef, useState, type DragEvent, type ReactNode } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, Conversation, Message } from "@godmode/shared";
import { ArrowDown, Paperclip } from "lucide-react";
import type { LiveRun } from "@/stores/live";
import { cn } from "@/lib/utils";
import { AssistantMessage, LiveAssistantMessage, StartedMessage, SystemMessage, UserMessage } from "./messages";
import { useStickToBottom } from "./use-stick-to-bottom";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, d.getFullYear() === new Date().getFullYear() ? "EEEE, MMMM d" : "MMMM d, yyyy");
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
}

export function Thread({ messages, agent, inflight, onStop, stopping, onPause, pausing, empty, delegatedFrom }: ThreadProps) {
  const { scrollRef, contentRef, atBottom, scrollToBottom } = useStickToBottom();
  // Messages present on first render don't animate in
  const initialIds = useRef<Set<string> | null>(null);
  if (initialIds.current === null) initialIds.current = new Set(messages.map((m) => m.id));

  const isEmpty = messages.length === 0 && !inflight;
  let lastDay = "";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain" tabIndex={-1} aria-label="Messages">
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
            {inflight ? "Jump to live" : "Jump to latest"}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Full-area file drop target with a friendly overlay. */
export function ChatDropZone({ onFiles, children, className }: { onFiles: (files: File[]) => void; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        depth.current = 0;
        setOver(false);
        // The composer handles drops on itself (and marks the event handled)
        if (e.defaultPrevented) return;
        e.preventDefault();
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
      <AnimatePresence>
        {over && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 z-50 grid place-items-center bg-background/70 p-6 backdrop-blur-md"
          >
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-foreground/25 bg-card px-12 py-10 text-center shadow-float">
              <span className="grid size-11 place-items-center rounded-lg border bg-secondary text-foreground">
                <Paperclip className="size-5" />
              </span>
              <div className="text-base font-medium">Drop files to attach</div>
              <div className="text-sm text-muted-foreground">Images, PDFs, spreadsheets… up to 25 MB each</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
