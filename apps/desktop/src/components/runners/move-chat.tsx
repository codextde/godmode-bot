import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Conversation, ConversationWithMessages, RemoteRunner } from "@godmode/shared";
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
import { qk } from "@/lib/queryKeys";
import { RunnerStateDot, THIS_COMPUTER, THIS_COMPUTER_INLINE } from "./runner-parts";

/** Why a runner's chat can't move right now (its run works or stands still there), or null. */
export function moveBlocker(chat: { running: boolean; paused: boolean }): string | null {
  if (chat.running) return "Stop the run or let it finish first";
  if (chat.paused) return "Stop the paused run first";
  return null;
}

/** Asks before a runner's chat moves to this computer, then moves it. */
export function MoveChatDialog({
  conversation,
  runner,
  agentName,
  open,
  onOpenChange,
}: {
  conversation: Pick<Conversation, "id" | "followup">;
  runner: RemoteRunner | null;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  // Once moved the chat has no runner: the closing dialog keeps saying where it came from.
  const shown = useRef(runner);
  if (open) shown.current = runner;
  const from = shown.current;
  const name = from?.name ?? "The runner";
  const away = !from || from.state !== "online";
  const move = useMutation({
    mutationFn: () => api.conversations.moveHere(conversation.id),
    onSuccess: (moved) => {
      qc.setQueryData<ConversationWithMessages>(qk.conversation(conversation.id), (old) => (old ? { ...old, ...moved } : old));
      void qc.invalidateQueries({ queryKey: qk.conversation(conversation.id) });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      void qc.invalidateQueries({ queryKey: qk.runners });
      onOpenChange(false);
      toast.success(`Moved to ${THIS_COMPUTER_INLINE}`, { description: `${agentName} continues this chat here, with the whole conversation.` });
    },
    onError: (err) => toastApiError(err, "Couldn't move the chat", qc),
  });

  return (
    <AlertDialog open={open} onOpenChange={(next) => !move.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move this chat to {THIS_COMPUTER_INLINE}?</AlertDialogTitle>
          <AlertDialogDescription>
            {agentName} picks it up here with the whole conversation, and can use your folders, screen and VMs again.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-paper-2 p-2 text-[13px]">
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
            <MonitorSmartphone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-medium">{name}</span>
            {from && <RunnerStateDot state={from.state} />}
          </span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-brand/25 bg-brand-soft px-2.5 py-1.5 text-brand-strong">
            <Laptop className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate font-medium">{THIS_COMPUTER}</span>
          </span>
        </div>

        <ul className="space-y-1.5 text-[13px] text-muted-foreground">
          <li>
            {away
              ? `${name} can't be reached right now. It removes its copy once it's back — anything it still does in this chat until then is lost.`
              : `${name} removes its copy. Files the agent saved there stay on it.`}
          </li>
          {conversation.followup && <li>The follow-up {followupWhen(conversation.followup.dueAt)} comes along.</li>}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={move.isPending}>Cancel</AlertDialogCancel>
          <Button onClick={() => move.mutate()} disabled={move.isPending}>
            {move.isPending ? <Spinner /> : <Laptop />} Move to {THIS_COMPUTER_INLINE}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
