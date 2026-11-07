import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const KEY = "godmode.totpAutolinkDismissed";
/** Only the latest few: each "Not now" hides the suggestions shown then, which are a handful at a time. */
const KEEP = 40;

/** A suggestion's key: the login and the 2FA code it pairs. */
export const pairKey = (p: { credentialId: string; totpId: string }) => `${p.credentialId}:${p.totpId}`;

interface DismissedState {
  keys: Set<string>;
  dismiss: (keys: string[]) => void;
}

/** 2FA link suggestions this phone said "Not now" to, like the desktop keeps its own. */
export const useDismissedLinks = create<DismissedState>((set, get) => ({
  keys: new Set(),
  dismiss: (keys) => {
    const next = [...get().keys, ...keys].slice(-KEEP);
    set({ keys: new Set(next) });
    void SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => undefined);
  },
}));

void SecureStore.getItemAsync(KEY)
  .catch(() => null)
  .then((saved) => {
    if (!saved) return;
    try {
      const list = JSON.parse(saved) as unknown;
      if (Array.isArray(list)) useDismissedLinks.setState({ keys: new Set([...list.filter((k): k is string => typeof k === "string"), ...useDismissedLinks.getState().keys]) });
    } catch {
      /* unreadable: show them again */
    }
  });
