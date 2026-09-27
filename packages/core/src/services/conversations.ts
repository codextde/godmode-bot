/**
 * CONTRACT (owner: runner agent). Conversations + messages + chat entry points.
 */
import type { Conversation, ConversationOrigin, Message } from "@godmode/shared";
import type { ConversationWithMessages, SendMessageInput, SendMessageResult, StartChatResult } from "@godmode/shared";

export function createConversation(_input: { agentId: string; title?: string; origin?: ConversationOrigin }): Conversation {
  throw new Error("not implemented");
}
export function getConversation(_id: string): ConversationWithMessages {
  throw new Error("not implemented");
}
export function listConversations(_opts: { agentId?: string; search?: string; limit?: number; archived?: boolean } = {}): Conversation[] {
  throw new Error("not implemented");
}
/** Store the user message (+attachments) and start a run for it. */
export async function sendMessage(_conversationId: string, _input: SendMessageInput & { trigger?: import("@godmode/shared").RunTrigger; routineId?: string | null; parentRunId?: string | null; depth?: number }): Promise<SendMessageResult> {
  throw new Error("not implemented");
}
/** Create a conversation for the agent (default agent if omitted) and send the first message. */
export async function startChat(_input: { agentId?: string; content: string; origin?: ConversationOrigin; title?: string; attachments?: SendMessageInput["attachments"]; voice?: boolean }): Promise<StartChatResult> {
  throw new Error("not implemented");
}
export function listMessages(_conversationId: string): Message[] {
  throw new Error("not implemented");
}
