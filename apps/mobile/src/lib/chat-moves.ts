import * as Haptics from "expo-haptics";
import { Alert } from "react-native";
import { create } from "zustand";
import type { ChatMove, Conversation, ConversationWithMessages, MoveChatInput } from "@godmode/shared";
import { ApiError, errorText } from "./api";
import { fetchConversation } from "./chat-cache";
import { chatExtrasApi } from "./chat-extras";
import { t } from "./i18n";
import { staysAwake } from "./keep-awake";
import { qk, queryClient } from "./query";

export interface MoveOnItsWay {
  dest: string;
  agentName: string;
  /** What the server told about it so far (`chat.move`). */
  move: ChatMove | null;
  /** The server's word of it ended, the answer is on its way. */
  finishing: boolean;
  hidden: boolean;
  startedAt: number;
}

/** Chats on their way to another computer: the request goes on when the sheet closes, the chat shows how far it is. */
export const useChatMoves = create<{ moves: Record<string, MoveOnItsWay> }>(() => ({ moves: {} }));

function change(conversationId: string, next: (move: MoveOnItsWay) => MoveOnItsWay | null) {
  useChatMoves.setState(({ moves }) => {
    const current = moves[conversationId];
    if (!current) return { moves };
    const updated = next(current);
    const rest = { ...moves };
    if (updated) rest[conversationId] = updated;
    else delete rest[conversationId];
    return { moves: rest };
  });
}

/** From the socket; a move another window of the human started isn't shown here, like the desktop's corner card. */
export function noteChatMove(conversationId: string, move: ChatMove | null) {
  change(conversationId, (m) => ({ ...m, move, finishing: !move && !!m.move }));
}

export const hideChatMove = (conversationId: string) => change(conversationId, (m) => ({ ...m, hidden: true }));

export function startChatMove(opts: { conversationId: string; input: MoveChatInput; dest: string; agentName: string; working: boolean }) {
  const { conversationId, dest, agentName, working } = opts;
  useChatMoves.setState(({ moves }) => ({ moves: { ...moves, [conversationId]: { dest, agentName, move: null, finishing: false, hidden: false, startedAt: Date.now() } } }));
  const moved = (chat: Conversation) => {
    change(conversationId, () => null);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    queryClient.setQueryData<ConversationWithMessages>(qk.conversation(conversationId), (old) => (old ? { ...old, ...chat } : old));
    void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
    void queryClient.invalidateQueries({ queryKey: qk.conversations });
    Alert.alert(t("chat:move.moved", { dest }), working ? t("chat:move.movedWorking", { name: agentName }) : t("chat:move.movedIdle", { name: agentName }));
  };
  staysAwake(`chat-move-${conversationId}`, () => chatExtrasApi.move(conversationId, opts.input)).then(moved, async (err: unknown) => {
    // Only the answer may have got lost: the chat itself says where it is now.
    if (err instanceof ApiError && err.code === "timeout") {
      const chat = await fetchConversation(conversationId).catch(() => null);
      if (chat && (chat.runnerId ?? null) === opts.input.to) return moved(chat);
    }
    change(conversationId, () => null);
    Alert.alert(t("chat:move.failed"), errorText(err));
  });
}
