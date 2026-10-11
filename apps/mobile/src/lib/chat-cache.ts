import type { ConversationWithMessages, Message, QueuedMessage } from "@godmode/shared";
import { api } from "./api";
import { withPending } from "./pending-queue";
import { qk, queryClient } from "./query";

/** Messages a chat opens with; older ones come a page at a time when scrolling up. A long chat is megabytes. */
export const CHAT_WINDOW = 40;

interface Arrived {
  messages: Map<string, Message>;
  queue: QueuedMessage[] | null;
}

/** What live events brought while a chat was being fetched: the answer may predate them. */
const fetching = new Map<string, Set<Arrived>>();

export const isPending = (m: Message) => m.id.startsWith("pending-");

/** A stored message into a chat's list; the optimistic copy of a message the human just sent goes. */
export function mergeMessage(messages: Message[], message: Message): Message[] {
  if (messages.some((m) => m.id === message.id)) return messages.map((m) => (m.id === message.id ? message : m));
  let rest = messages;
  if (message.role === "user") {
    const optimistic = rest.findIndex((m) => isPending(m) && m.content.trim() === message.content.trim());
    if (optimistic >= 0) rest = rest.filter((_, i) => i !== optimistic);
  }
  const stored = rest.filter((m) => !isPending(m));
  const at = stored.findIndex((m) => m.createdAt > message.createdAt);
  const sorted = at < 0 ? [...stored, message] : [...stored.slice(0, at), message, ...stored.slice(at)];
  return [...sorted, ...rest.filter(isPending)];
}

/** A message event: into the cached chat, and into any fetch of it that is on its way. */
export function upsertMessage(message: Message) {
  for (const arrived of fetching.get(message.conversationId) ?? []) arrived.messages.set(message.id, message);
  queryClient.setQueryData<ConversationWithMessages>(qk.conversation(message.conversationId), (old) =>
    old ? { ...old, messages: mergeMessage(old.messages, message) } : old,
  );
}

export function noteQueue(conversationId: string, queue: QueuedMessage[]) {
  for (const arrived of fetching.get(conversationId) ?? []) arrived.queue = queue;
}

/**
 * A chat with its latest messages. Older pages that were loaded stay, and so does what arrived live meanwhile, so a
 * refetch never takes anything off the screen.
 */
export async function fetchConversation(id: string): Promise<ConversationWithMessages> {
  const arrived: Arrived = { messages: new Map(), queue: null };
  const waiting = fetching.get(id) ?? new Set<Arrived>();
  waiting.add(arrived);
  fetching.set(id, waiting);
  try {
    const fresh = await api.conversations.get(id, CHAT_WINDOW);
    const old = queryClient.getQueryData<ConversationWithMessages>(qk.conversation(id));
    let messages = fresh.messages;
    let hasMore = fresh.hasMore ?? false;
    if (old) {
      const known = new Set(messages.map((m) => m.id));
      const first = messages[0];
      // Only when the two overlap: otherwise more arrived than one window holds and there would be a hole in between.
      if (first && old.messages.some((m) => known.has(m.id))) {
        const earlier = old.messages.filter((m) => !isPending(m) && !known.has(m.id) && m.createdAt <= first.createdAt);
        if (earlier.length) {
          messages = [...earlier, ...messages];
          hasMore = old.hasMore ?? false;
        }
      }
      const sent = new Set(messages.filter((m) => m.role === "user").slice(-5).map((m) => m.content.trim()));
      messages = [...messages, ...old.messages.filter((m) => isPending(m) && !sent.has(m.content.trim()))];
    }
    for (const message of arrived.messages.values()) messages = mergeMessage(messages, message);
    return { ...fresh, messages, hasMore, queue: arrived.queue ? withPending(id, arrived.queue) : fresh.queue };
  } finally {
    waiting.delete(arrived);
    if (!waiting.size) fetching.delete(id);
  }
}

const loadingEarlier = new Set<string>();

/** The page before the oldest message on screen. False when there is nothing older (or it is loading already). */
export async function loadEarlier(id: string): Promise<boolean> {
  const key = qk.conversation(id);
  const have = queryClient.getQueryData<ConversationWithMessages>(key);
  const first = have?.messages.find((m) => !isPending(m));
  if (!have?.hasMore || !first || loadingEarlier.has(id)) return false;
  loadingEarlier.add(id);
  try {
    const page = await api.conversations.messages(id, first.id, CHAT_WINDOW);
    queryClient.setQueryData<ConversationWithMessages>(key, (old) => {
      if (!old) return old;
      const known = new Set(old.messages.map((m) => m.id));
      return { ...old, messages: [...page.messages.filter((m) => !known.has(m.id)), ...old.messages], hasMore: page.hasMore };
    });
    return true;
  } finally {
    loadingEarlier.delete(id);
  }
}
