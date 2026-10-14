import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Conversation, ConversationWithMessages } from "@godmode/shared";
import { ArrowRight, Laptop, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { followupWhen } from "@/components/chat/followup";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import type { Place } from "@/lib/places";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { RunnerStateDot } from "./runner-parts";

/** Why a runner's chat can't move right now (its run works or stands still there), or null. */
export function moveBlocker(chat: { running: boolean; paused: boolean }): string | null {
  if (chat.running) return "Stop the run or let it finish first";
  if (chat.paused) return "Stop the paused run first";
  return null;
}

function PlaceTag({ place, active }: { place: Place | null; active?: boolean }) {
  const Icon = place?.here ? Laptop : MonitorSmartphone;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5",
        active ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", !active && "text-muted-foreground")} aria-hidden />
      <span className="truncate font-medium">{place?.name ?? "Another computer"}</span>
      {place && !active && <RunnerStateDot state={place.state} />}
    </span>
  );
}

/**
 * Asks before a chat moves to another computer, then moves it with its Claude session. While a run works the move
 * stops it and the agent continues there (`working`).
 */
export function MoveChatDialog({
  conversation,
  from,
  targets,
  initial,
  working,
  agentName,
  open,
  onOpenChange,
}: {
  conversation: Pick<Conversation, "id" | "followup">;
  from: Place | null;
  /** Where it can go: online places other than where it is. */
  targets: Place[];
  initial: Place | null;
  working: boolean;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [to, setTo] = useState<Place | null>(initial);
  useEffect(() => {
    if (open) setTo(initial ?? targets[0] ?? null);
  }, [open, initial, targets]);
  // Once moved the chat works elsewhere: the closing dialog keeps saying where it came from.
  const shown = useRef(from);
  if (open) shown.current = from;
  const origin = shown.current;
  const name = origin?.name ?? "The other computer";
  const away = !!origin && origin.state !== "online";
  const dest = to?.here ? "this Mac" : (to?.name ?? "the other computer");
  const move = useMutation({
    mutationFn: () => api.conversations.move(conversation.id, { to: to!.runnerId, force: working || undefined }),
    onSuccess: (moved) => {
      qc.setQueryData<ConversationWithMessages>(qk.conversation(conversation.id), (old) => (old ? { ...old, ...moved } : old));
      void qc.invalidateQueries({ queryKey: qk.conversation(conversation.id) });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      void qc.invalidateQueries({ queryKey: qk.runners });
      onOpenChange(false);
      toast.success(`Moved to ${dest}`, {
        description: working ? `${agentName} continues there where it stopped.` : `${agentName} continues this chat there, with the whole conversation.`,
      });
    },
    onError: (err) => toastApiError(err, "Couldn't move the chat", qc),
  });

  return (
    <AlertDialog open={open} onOpenChange={(next) => !move.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move this chat to {dest}?</AlertDialogTitle>
          <AlertDialogDescription>
            {working
              ? `${agentName} is working on it right now. The run stops on ${name}, and ${agentName} picks up on ${dest} with the whole conversation.`
              : `${agentName} picks it up on ${dest} with the whole conversation.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-paper-2 p-2 text-[13px]">
          <PlaceTag place={origin} />
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <PlaceTag place={to} active />
        </div>

        {targets.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Move to">
            {targets.map((t) => (
              <button
                key={t.runnerId ?? "primary"}
                type="button"
                role="radio"
                aria-checked={to === t}
                onClick={() => setTo(t)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  to === t ? "border-foreground/20 bg-accent font-medium" : "text-muted-foreground",
                )}
              >
                {t.here ? <Laptop className="size-3" /> : <MonitorSmartphone className="size-3" />}
                {t.name}
              </button>
            ))}
          </div>
        )}

        <ul className="space-y-1.5 text-[13px] text-muted-foreground">
          <li>
            {away
              ? `${name} can't be reached right now. It drops its copy once it's back — anything it still does in this chat until then is lost.`
              : `Files the agent made outside its repository stay on ${name}.`}
          </li>
          {conversation.followup && <li>The follow-up {followupWhen(conversation.followup.dueAt)} comes along.</li>}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={move.isPending}>Cancel</AlertDialogCancel>
          <Button onClick={() => move.mutate()} disabled={move.isPending || !to}>
            {move.isPending ? <Spinner /> : to?.here ? <Laptop /> : <MonitorSmartphone />} {working ? "Move and continue" : "Move"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
