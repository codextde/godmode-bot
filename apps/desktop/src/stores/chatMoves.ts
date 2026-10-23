import { create } from "zustand";
import type { ChatMove } from "@godmode/shared";

/** Chats on their way between computers, as the server tells them (`chat.move`). */
export const useChatMoves = create<{ moves: Record<string, ChatMove> }>(() => ({ moves: {} }));

export function setChatMove(conversationId: string, move: ChatMove | null) {
  useChatMoves.setState(({ moves }) => {
    const next = { ...moves };
    if (move) next[conversationId] = move;
    else delete next[conversationId];
    return { moves: next };
  });
}
