import type { QueuedMessage } from "@godmode/shared";

/** Queued messages this phone is still sending: they stay in the queue until the computer answers. */
export const pendingQueued = new Map<string, QueuedMessage>();

/** The computer's queue of a chat plus what this phone is still sending to it. */
export function withPending(conversationId: string, queue: QueuedMessage[]): QueuedMessage[] {
  const sending = [...pendingQueued.values()].filter((m) => m.conversationId === conversationId && !queue.some((q) => q.id === m.id));
  return sending.length ? [...queue, ...sending] : queue;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Id for a message about to be queued, so its row keeps its identity until the agent picks it up. */
export function newQueueId(): string {
  return `qmsg_${Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;
}
