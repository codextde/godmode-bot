import { contextGauge, type ConversationContext, type ContextGauge } from "@godmode/shared";
import { api } from "./api";
import { newQueueId } from "./pending-queue";
import { qk, queryClient } from "./query";
import { useSettings } from "./setup";

export function useContextGauge(context: ConversationContext | null | undefined): ContextGauge | null {
  return contextGauge(context, useSettings().data?.runner.autoCompactPercent);
}

/** Sends /compress: Claude Code summarizes the chat so far (queued behind work that is running). */
export async function compressChat(conversationId: string): Promise<void> {
  await api.conversations.send(conversationId, { content: "/compress", attachments: [], queueId: newQueueId() });
  void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
}

export function isCompressCommand(text: string): boolean {
  return /^\/(compress|compact)\b/.test(text.trim());
}
