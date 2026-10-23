import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { create } from "zustand";

/** Away this long, and Home sums up what the team did meanwhile (the desktop's rule). */
const AWAY_MS = 2 * 60 * 60_000;
const KEY = "godmode.lastSeen";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export interface AwayWindow {
  since: string;
  until: string;
}

interface AwayState {
  /** The human came back after a while: from when to when they were away. Not kept. */
  away: AwayWindow | null;
  dismiss: () => void;
}

export const useAwayStore = create<AwayState>((set) => ({
  away: null,
  dismiss: () => set({ away: null }),
}));

/**
 * Notices when the human comes back: the app in front again (or opened) at least two hours after it last left the
 * screen. When it left is kept on the phone, so a cold start agrees.
 */
export function trackAway(): () => void {
  let left: number | null = null;
  let stopped = false;
  const back = () => {
    const now = Date.now();
    if (left !== null && now - left >= AWAY_MS) useAwayStore.setState({ away: { since: new Date(left).toISOString(), until: new Date(now).toISOString() } });
    left = null;
  };
  void SecureStore.getItemAsync(KEY, STORE_OPTIONS)
    .catch(() => null)
    .then((saved) => {
      const at = Number(saved);
      // Left again before the saved time was read: that newer time counts.
      if (stopped || left !== null || !Number.isFinite(at) || at <= 0) return;
      left = at;
      if (AppState.currentState === "active") back();
    });
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") return back();
    if (left !== null) return;
    left = Date.now();
    void SecureStore.setItemAsync(KEY, String(left), STORE_OPTIONS).catch(() => undefined);
  });
  return () => {
    stopped = true;
    subscription.remove();
  };
}
