import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Conversation } from "@godmode/shared";
import { ArrowRight, Laptop, MonitorSmartphone } from "lucide-react";
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
import { t as translate } from "@/i18n";
import { placeName, type Place } from "@/lib/places";
import { cn } from "@/lib/utils";
import { useChatMoves } from "@/stores/chatMoves";
import { startChatMove } from "./chat-move-progress";
import { RunnerStateDot, RunnerTag, thisComputerInline } from "./runner-parts";

/** Why a runner's chat can't move right now (its run works or stands still there), or null. */
export function moveBlocker(chat: { running: boolean; paused: boolean }): string | null {
  if (chat.running) return translate("runners:move.blockRunning");
  if (chat.paused) return translate("runners:move.blockPaused");
  return null;
}

function PlaceTag({ place, active }: { place: Place | null; active?: boolean }) {
  const { t } = useTranslation("runners");
  const Icon = place?.here ? Laptop : MonitorSmartphone;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5",
        active ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", !active && "text-muted-foreground")} aria-hidden />
      <span className="truncate font-medium">{place?.name ?? t("move.anotherComputer")}</span>
      {place?.twinOf && <RunnerTag className={cn(active && "border-brand/25 bg-transparent text-brand-strong")} />}
      {place && !active && <RunnerStateDot state={place.state} />}
    </span>
  );
}

/**
 * Asks before a chat moves to another computer, then moves it with its Claude session in the background (a card in the
 * corner shows how far it is). While a run works the move stops it and the agent continues there (`working`).
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
  const { t } = useTranslation(["runners", "common"]);
  const qc = useQueryClient();
  const [to, setTo] = useState<Place | null>(initial);
  useEffect(() => {
    if (open) setTo(initial ?? targets[0] ?? null);
  }, [open, initial, targets]);
  // Once moved the chat works elsewhere: the closing dialog keeps saying where it came from.
  const [shown, setShown] = useState(from);
  if (open && shown !== from) setShown(from);
  const origin = open ? from : shown;
  const name = origin ? placeName(origin) : t("move.theOtherComputer");
  const away = !!origin && origin.state !== "online";
  const dest = to?.here ? thisComputerInline() : to ? placeName(to) : t("move.theOtherComputerInline");
  const moving = useChatMoves((s) => !!s.moves[conversation.id]);
  const move = () => {
    if (!to) return;
    startChatMove(qc, { conversationId: conversation.id, input: { to: to.runnerId, force: working || undefined }, from: name, dest, agentName, working });
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("move.dialogTitle", { dest })}</AlertDialogTitle>
          <AlertDialogDescription>
            {working
              ? t("move.dialogWorking", { agent: agentName, from: name, dest })
              : t("move.dialogIdle", { agent: agentName, dest })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-paper-2 p-2 text-[13px]">
          <PlaceTag place={origin} />
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <PlaceTag place={to} active />
        </div>

        {targets.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("move.moveTo")}>
            {targets.map((target) => (
              <button
                key={target.runnerId ?? "primary"}
                type="button"
                role="radio"
                aria-checked={to === target}
                onClick={() => setTo(target)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  to === target ? "border-foreground/20 bg-accent font-medium" : "text-muted-foreground",
                )}
              >
                {target.here ? <Laptop className="size-3" /> : <MonitorSmartphone className="size-3" />}
                {placeName(target)}
              </button>
            ))}
          </div>
        )}

        <ul className="space-y-1.5 text-[13px] text-muted-foreground">
          <li>
            {away
              ? t("move.away", { name })
              : t("move.filesStay", { name })}
          </li>
          {conversation.followup && <li>{t("move.followup", { when: followupWhen(conversation.followup.dueAt) })}</li>}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <Button onClick={move} disabled={moving || !to}>
            {moving ? <Spinner /> : to?.here ? <Laptop /> : <MonitorSmartphone />} {moving ? t("move.moving") : working ? t("move.moveAndContinue") : t("move.move")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
