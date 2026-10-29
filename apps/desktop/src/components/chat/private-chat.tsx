import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ghost } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/common";
import { api } from "@/lib/api";
import { isMac, modKey } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export const PRIVATE_CHAT_HINT = "Nothing is saved: no history, no memory. It's gone when you leave.";

/** Switches the new chat to private (Home, top right). */
export function PrivateChatToggle({ value, onChange, className }: { value: boolean; onChange: (on: boolean) => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={value}
          aria-keyshortcuts={isMac ? "Meta+Shift+N" : "Control+Shift+N"}
          onClick={() => onChange(!value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium shadow-card transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            value
              ? "border-foreground bg-foreground text-background hover:bg-foreground/90"
              : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
            className,
          )}
        >
          <Ghost className="size-3.5" />
          {value ? "Private on" : "Private"}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-60 text-center">
        {value ? "Back to a normal chat" : "Start a private chat. Nothing is saved."}
        <span className="ml-1.5 inline-flex gap-0.5 align-middle opacity-80">
          <Kbd>⇧</Kbd>
          <Kbd>{modKey}N</Kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Next to the title of a private chat. */
export function PrivateChatBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-foreground/30 px-2 py-0.5 text-[11px] font-medium text-foreground/80">
          <Ghost className="size-3" /> Private
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-60 text-center">{PRIVATE_CHAT_HINT}</TooltipContent>
    </Tooltip>
  );
}

/** Above the thread of a private chat. */
export function PrivateChatNote() {
  return (
    <div className="flex shrink-0 items-center justify-center gap-1.5 border-b border-dashed bg-muted/30 px-4 py-1.5 text-center text-[12px] text-muted-foreground">
      <Ghost className="size-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground/80">Private chat.</span> {PRIVATE_CHAT_HINT}
      </span>
    </div>
  );
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function discard(id: string) {
  void api.conversations.discard(id).catch(() => {
    // Godmode wipes what is left of it when it starts again.
  });
}

/**
 * A private chat lives while it is open: leaving it (another chat, Home, closing the window) wipes it. A remount of the
 * same chat right after (React's strict mode, a layout switch) keeps it.
 */
export function usePrivateChatLifetime(conversationId: string, isPrivate: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!isPrivate) return;
    clearTimeout(pending.get(conversationId));
    pending.delete(conversationId);
    const onHide = () => discard(conversationId);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      pending.set(
        conversationId,
        setTimeout(() => {
          pending.delete(conversationId);
          discard(conversationId);
          qc.removeQueries({ queryKey: qk.conversation(conversationId) });
        }, 400),
      );
    };
  }, [conversationId, isPrivate, qc]);
}
