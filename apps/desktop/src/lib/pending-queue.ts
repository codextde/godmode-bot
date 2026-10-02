import type { QueuedMessage } from "@godmode/shared";

/** Queued messages this window is still sending: they stay in the queue until the core answers. */
export const pendingQueued = new Map<string, QueuedMessage>();

/** The core's queue of a chat plus what this window is still sending to it. */
export function withPending(conversationId: string, queue: QueuedMessage[]): QueuedMessage[] {
  const sending = [...pendingQueued.values()].filter((m) => m.conversationId === conversationId && !queue.some((q) => q.id === m.id));
  return sending.length ? [...queue, ...sending] : queue;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Id for a message about to be queued, so the row keeps its identity from the first keystroke to the pick-up. */
export function newQueueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `qmsg_${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}
