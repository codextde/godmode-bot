import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import type { ConversationWithMessages, PauseReason, QueuedMessage } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { ArrowUp, Paperclip, Pencil, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/common";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { pendingQueued } from "@/lib/pending-queue";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CommandText } from "./slash-commands";

export interface QueueTrayHandle {
  /** Edit the newest queued message; false when nothing waits. */
  editLast: () => boolean;
}

const EASE = [0.2, 0.8, 0.2, 1] as const;

/**
 * Docked on top of the composer: the messages sent while the agent works. The agent takes them at its next step; until
 * then each one can be reworded or taken back.
 */
export function QueueTray({
  conversationId,
  queue,
  agentName,
  running,
  paused,
  onLost,
  onDone,
  ref,
}: {
  conversationId: string;
  queue: QueuedMessage[];
  agentName: string;
  /** The agent is working in this chat. */
  running: boolean;
  /** The chat's run stands still: the queue goes along when it continues. */
  paused?: PauseReason | null;
  /** A rewording came too late — the agent has the message already: hand the new wording back. */
  onLost: (text: string) => void;
  /** Done with a row: the composer takes the focus again. */
  onDone: () => void;
  ref?: Ref<QueueTrayHandle>;
}) {
  const qc = useQueryClient();
  const key = qk.conversation(conversationId);
  const [editing, setEditing] = useState<{ id: string; text: string; from: string } | null>(null);
  // Rows that are animating out still hold their old handlers.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Right away: moving the focus on blurs the editor, which must not save a second time.
  const closeEditor = () => {
    editingRef.current = null;
    setEditing(null);
  };
  const setQueue = (fn: (queue: QueuedMessage[]) => QueuedMessage[]) =>
    qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, queue: fn(old.queue) } : old));
  const gone = (err: unknown) => err instanceof ApiRequestError && err.status === 404;
  const lost = (text: string) => {
    onLost(text);
    toast(`${agentName} already has that message`, { description: "Your new wording is in the message box — send it as a follow-up." });
  };

  const edit = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => api.conversations.queue.edit(conversationId, id, content),
    onMutate: ({ id, content }) => setQueue((q) => q.map((m) => (m.id === id ? { ...m, content } : m))),
    onError: (err, { content }) => {
      void qc.invalidateQueries({ queryKey: key });
      if (gone(err)) lost(content);
      else toast.error("Couldn't change the message", { description: errorMessage(err) });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.conversations.queue.remove(conversationId, id),
    onMutate: (id) => setQueue((q) => q.filter((m) => m.id !== id)),
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: key });
      if (gone(err)) toast(`${agentName} already has that message`);
      else toast.error("Couldn't remove the message", { description: errorMessage(err) });
    },
  });

  const sendNow = useMutation({
    mutationFn: () => api.conversations.queue.sendNow(conversationId),
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: key });
      if (!gone(err)) toast.error("Couldn't send the queue", { description: errorMessage(err) });
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      editLast: () => {
        const last = queue.findLast((m) => !pendingQueued.has(m.id));
        if (last) setEditing({ id: last.id, text: last.content, from: last.content });
        return !!last;
      },
    }),
    [queue],
  );

  // The agent took the message while it was being reworded.
  const taken = !!editing && !queue.some((m) => m.id === editing.id);
  useEffect(() => {
    const current = editingRef.current;
    if (!taken || !current) return;
    closeEditor();
    const text = current.text.trim();
    if (text && text !== current.from) lost(text);
  });

  const first = queue[0];
  const many = queue.length > 1;
  const hint = sendNow.isPending
    ? running
      ? "Stopping the current step…"
      : "Sending…"
    : paused
      ? paused === "question"
        ? `${many ? "Go" : "Goes"} along with your answer`
        : paused === "limit"
          ? `${many ? "Go" : "Goes"} along when the limit resets`
          : `${many ? "Go" : "Goes"} along when you continue`
      : !running
        ? "Not sent yet"
        : first && parseSlashCommand(first.content)
          ? `Runs when ${agentName} is done`
          : `${agentName} picks ${many ? "these" : "this"} up at its next step`;

  return (
    <AnimatePresence initial={false}>
      {queue.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="overflow-hidden"
        >
          <div className="mx-3 overflow-hidden rounded-t-xl border border-b-0 bg-muted/60 @xl:mx-4" role="region" aria-label="Queued messages">
            <div className="flex h-9 items-center gap-2 pr-1.5 pl-3">
              <span className="eyebrow text-[10.5px]">Queued</span>
              <span className="grid h-[18px] min-w-[18px] place-items-center rounded-[5px] border bg-card px-1 text-[11px] font-medium tabular-nums">{queue.length}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
                {hint}
              </span>
              {/* A run that waits for an answer only continues with that answer. */}
              {paused !== "question" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant={running || paused ? "ghost" : "secondary"}
                      disabled={sendNow.isPending || queue.every((m) => pendingQueued.has(m.id))}
                      onClick={() => sendNow.mutate()}
                    >
                      {sendNow.isPending ? <Spinner className="size-3" /> : running || paused ? <Zap /> : <ArrowUp />}
                      {running || paused ? "Send now" : "Send"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {paused
                      ? `Continue now with ${many ? "these messages" : "this message"}`
                      : running
                        ? `Stop what ${agentName} is doing and start on ${many ? "these" : "this"}`
                        : `Send ${many ? "these messages" : "this message"} to ${agentName}`}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <ol className="max-h-44 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
              <AnimatePresence initial={false}>
                {queue.map((m, i) => (
                  <motion.li
                    key={m.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18, ease: EASE }}
                    className="overflow-hidden"
                  >
                    <QueueRow
                      index={i + 1}
                      message={m}
                      draft={editing?.id === m.id ? editing.text : null}
                      onDraft={(text) => setEditing((e) => e && { ...e, text })}
                      onEdit={() => setEditing({ id: m.id, text: m.content, from: m.content })}
                      onClose={(save, byKey) => {
                        const current = editingRef.current;
                        if (current?.id !== m.id) return;
                        const next = current.text.trim();
                        if (save && next !== m.content && (next || m.attachments.length > 0)) edit.mutate({ id: m.id, content: next });
                        closeEditor();
                        if (byKey) onDone();
                      }}
                      onRemove={() => {
                        if (editingRef.current?.id === m.id) closeEditor();
                        remove.mutate(m.id);
                        onDone();
                      }}
                    />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function QueueRow({
  index,
  message,
  draft,
  onDraft,
  onEdit,
  onClose,
  onRemove,
}: {
  index: number;
  message: QueuedMessage;
  /** The wording being typed; null = not being edited. */
  draft: string | null;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onClose: (save: boolean, byKey: boolean) => void;
  onRemove: () => void;
}) {
  const pending = pendingQueued.has(message.id);
  const editing = draft !== null;
  const files = message.attachments.length;
  return (
    <div className={cn("group/q flex items-start gap-2 rounded-lg py-1 pr-1 pl-1.5 transition-colors", editing ? "bg-card shadow-card" : "hover:bg-accent/60 focus-within:bg-accent/60")}>
      <span className="mt-[5px] w-4 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums" aria-hidden>
        {index}
      </span>
      {editing ? (
        <QueueEditor text={draft} onChange={onDraft} onClose={onClose} />
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={onEdit}
          title="Edit message"
          className={cn(
            "mt-px line-clamp-2 min-w-0 flex-1 cursor-text rounded-sm py-0.5 text-left text-[13px] leading-snug break-words whitespace-pre-wrap focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            pending && "opacity-60",
          )}
        >
          {message.content ? <CommandText text={message.content} /> : <span className="text-muted-foreground">{files > 1 ? `${files} files` : message.attachments[0]?.name}</span>}
        </button>
      )}
      {files > 0 && !editing && (
        <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums" title={message.attachments.map((a) => a.name).join(", ")}>
          <Paperclip className="size-3" aria-hidden /> {files}
        </span>
      )}
      {pending ? (
        <Spinner className="mt-1 mr-1.5 size-3 shrink-0 text-muted-foreground" />
      ) : (
        <div
          className={cn(
            "flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/q:opacity-100 group-hover/q:opacity-100 [@media(hover:none)]:opacity-100",
            editing && "opacity-100",
          )}
        >
          {!editing && (
            <Button size="icon-xs" variant="ghost" aria-label="Edit message" className="text-muted-foreground hover:text-foreground" onClick={onEdit}>
              <Pencil />
            </Button>
          )}
          {/* mousedown: before the editor's blur saves and closes. */}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove from the queue"
            className="text-muted-foreground hover:text-destructive"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRemove}
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

function QueueEditor({ text, onChange, onClose }: { text: string; onChange: (text: string) => void; onClose: (save: boolean, byKey: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onClose(true, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(false, true);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-end gap-2">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        aria-label="Queued message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onClose(true, false)}
        className="mt-px block min-w-0 flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-snug outline-none"
      />
      <span className="hidden shrink-0 items-center gap-1 pb-0.5 text-[11px] whitespace-nowrap text-muted-foreground @lg:flex">
        <Kbd>↵</Kbd> save <Kbd>esc</Kbd> cancel
      </span>
    </div>
  );
}
