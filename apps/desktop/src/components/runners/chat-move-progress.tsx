import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ChatMove, ConversationWithMessages, MoveChatInput } from "@godmode/shared";
import { ArrowRightLeft, X } from "lucide-react";
import { toast } from "sonner";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { setChatMove, useChatMoves } from "@/stores/chatMoves";

const MB = 1024 * 1024;

function size(n: number): string {
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
}

/** Copy speed from the first bytes of the copy on, once there is enough to tell. */
function useRate(move: ChatMove | undefined): number | null {
  const first = useRef<{ at: number; bytes: number } | null>(null);
  const copying = move?.stage === "copying";
  if (!copying) first.current = null;
  else if (!first.current && move.bytes > 0) first.current = { at: Date.now(), bytes: move.bytes };
  if (!copying || !first.current) return null;
  const seconds = (Date.now() - first.current.at) / 1000;
  return seconds >= 1.5 ? (move.bytes - first.current.bytes) / seconds : null;
}

function useElapsed(since: number): number {
  const [at, setAt] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (at - since) / 1000;
}

function ChatMoveToast({ toastId, conversationId, dest, agentName }: { toastId: string; conversationId: string; dest: string; agentName: string }) {
  const move = useChatMoves((s) => s.moves[conversationId]);
  const started = useRef(Date.now());
  const seen = useRef(false);
  if (move) seen.current = true;
  const finishing = !move && seen.current;
  const elapsed = useElapsed(started.current);
  const rate = useRate(move);

  const percent = move?.stage === "copying" && move.total ? Math.min(100, (move.bytes / move.total) * 100) : finishing || move?.stage === "saving" || move?.stage === "continuing" ? 100 : null;
  const left = move?.stage === "copying" && move.total && rate ? (move.total - move.bytes) / rate : null;

  let detail: string;
  if (finishing) detail = "Almost there";
  else if (!move) detail = "Starting";
  else if (move.stage === "checking") detail = `Checking the chat on ${move.from}`;
  else if (move.stage === "copying") detail = move.total ? `Copying the conversation · ${size(move.bytes)} of ${size(move.total)}` : `Copying the conversation · ${size(move.bytes)}`;
  else if (move.stage === "sending") detail = `Sending it to ${move.to}`;
  else if (move.stage === "saving") detail = `Saving it on ${dest}`;
  else detail = `${agentName} picks up where it stopped`;

  return (
    <div className="w-[356px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg" role="status" aria-live="polite">
      <div className="flex items-start gap-3 p-3.5 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-strong">
          <ArrowRightLeft className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 text-[13px] font-medium">
            <span className="truncate text-shimmer">Moving chat to {dest}</span>
            {move?.stage === "copying" && percent !== null && <span className="ml-auto shrink-0 font-mono text-[11px] font-normal text-muted-foreground tabular-nums">{Math.floor(percent)}%</span>}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">{detail}</p>
        </div>
        <button
          type="button"
          onClick={() => toast.dismiss(toastId)}
          aria-label="Hide"
          className="-mt-0.5 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="px-3.5 pb-3.5">
        <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden>
          <div
            className={cn("h-full rounded-full bg-brand transition-[width] duration-300 ease-out", percent === null && "w-1/3 animate-indeterminate", percent === 100 && "animate-pulse")}
            style={percent === null ? undefined : { width: `${Math.max(2, percent)}%` }}
          />
        </div>
        <p className="mt-2 flex justify-between gap-3 text-[11px] text-muted-foreground tabular-nums">
          <span className="truncate">Keep working, you'll see when it's there.</span>
          <span className="shrink-0">{left !== null ? `${clock(left)} left · ${size(rate!)}/s` : clock(elapsed)}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Moves a chat without holding anything up: the dialog closes and a card in the corner shows how far the move is
 * (from the server's `chat.move` events) until it arrived or failed.
 */
export function startChatMove(
  qc: QueryClient,
  opts: { conversationId: string; input: MoveChatInput; from: string; dest: string; agentName: string; working: boolean },
) {
  const { conversationId, dest, agentName, working } = opts;
  const id = `chat-move:${conversationId}`;
  setChatMove(conversationId, { conversationId, from: opts.from, to: dest, stage: "checking", bytes: 0, total: null, startedAt: new Date().toISOString() });
  toast.custom((t) => <ChatMoveToast toastId={String(t)} conversationId={conversationId} dest={dest} agentName={agentName} />, { id, duration: Infinity, unstyled: true });
  api.conversations.move(conversationId, opts.input).then(
    (moved) => {
      setChatMove(conversationId, null);
      qc.setQueryData<ConversationWithMessages>(qk.conversation(conversationId), (old) => (old ? { ...old, ...moved } : old));
      void qc.invalidateQueries({ queryKey: qk.conversation(conversationId) });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      void qc.invalidateQueries({ queryKey: qk.runners });
      toast.dismiss(id);
      toast.success(`Moved to ${dest}`, {
        id: `${id}:done`,
        description: working ? `${agentName} continues there where it stopped.` : `${agentName} continues this chat there, with the whole conversation.`,
      });
    },
    (err) => {
      setChatMove(conversationId, null);
      toast.dismiss(id);
      toastApiError(err, "Couldn't move the chat", qc);
    },
  );
}
