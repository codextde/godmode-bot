import { create } from "zustand";
import type { Conversation, MessageBlock } from "@godmode/shared";
import { handoffCommand } from "@godmode/shared";
import { api } from "./api";
import { newQueueId } from "./pending-queue";
import { qk, queryClient } from "./query";

/** Chats where the human asked to go on in a new chat (when): the new chat opens as soon as it exists. */
const useAsked = create<Record<string, number>>(() => ({}));

const WAIT_MS = 10 * 60_000;

export function askHandoff(conversationId: string) {
  useAsked.setState({ [conversationId]: Date.now() });
}

/** True once per ask, while it is fresh. */
export function takeHandoff(conversationId: string): boolean {
  const at = useAsked.getState()[conversationId];
  if (at === undefined) return false;
  useAsked.setState((s) => {
    const { [conversationId]: _, ...rest } = s;
    return rest;
  }, true);
  return Date.now() - at < WAIT_MS;
}

/** Only a plain chat on this computer goes on in a fresh one (not a private one, nor a task's, an app's or an agent's). */
export function canHandoff(conversation: Pick<Conversation, "origin" | "private" | "runnerId"> | undefined): boolean {
  return !!conversation && conversation.origin === "chat" && !conversation.private && !conversation.runnerId;
}

export function isHandoffCommand(text: string): boolean {
  return handoffCommand(text) !== null;
}

/** The chat a `chat_handoff` call in these blocks opened, the latest one first. */
export function handoffChatIn(blocks: readonly MessageBlock[] | undefined): string | null {
  if (!blocks) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type !== "tool_use" || b.isError) continue;
    const bare = b.name.includes("__") ? b.name.slice(b.name.lastIndexOf("__") + 2) : b.name;
    if (bare !== "chat_handoff") continue;
    const id = /\((cnv_[A-Za-z0-9_-]+)\)/.exec(b.result ?? "")?.[1];
    if (id) return id;
  }
  return null;
}

/** Sends /handoff: the agent writes a brief and goes on in a fresh chat (after the step it is on). */
export async function handoffChat(conversationId: string): Promise<void> {
  askHandoff(conversationId);
  await api.conversations.send(conversationId, { content: "/handoff", attachments: [], queueId: newQueueId() });
  void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
}
