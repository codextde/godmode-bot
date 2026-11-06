import { create } from "zustand";

/** Chats where the human asked to go on in a new chat (when): the new chat opens as soon as it exists. */
export const useHandoffAsked = create<Record<string, number>>(() => ({}));

const WAIT_MS = 10 * 60_000;

export function askHandoff(conversationId: string) {
  useHandoffAsked.setState({ [conversationId]: Date.now() });
}

/** True once per ask, while it is fresh. */
export function takeHandoff(conversationId: string): boolean {
  const at = useHandoffAsked.getState()[conversationId];
  if (at === undefined) return false;
  useHandoffAsked.setState((s) => {
    const { [conversationId]: _, ...rest } = s;
    return rest;
  }, true);
  return Date.now() - at < WAIT_MS;
}
