import * as SecureStore from "expo-secure-store";
import { Appearance } from "react-native";
import { create } from "zustand";
import { THEMES, type Theme } from "@godmode/shared";

const KEY = "godmode.theme";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

function apply(theme: Theme) {
  Appearance.setColorScheme(theme === "system" ? "unspecified" : theme);
}

interface AppearanceState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/** The computer's theme (Settings → General), light until the human picks another; kept on the phone for the next cold start. */
export const useAppearance = create<AppearanceState>((set, get) => ({
  theme: "light",
  setTheme: (theme) => {
    if (!THEMES.includes(theme) || get().theme === theme) return;
    apply(theme);
    set({ theme });
    void SecureStore.setItemAsync(KEY, theme, STORE_OPTIONS).catch(() => undefined);
  },
}));

apply("light");

/** Before the first screen, so the app never opens in the phone's scheme when the computer says otherwise. */
export async function loadAppearance(): Promise<void> {
  const saved = (await SecureStore.getItemAsync(KEY, STORE_OPTIONS).catch(() => null)) as Theme | null;
  if (saved && THEMES.includes(saved)) useAppearance.getState().setTheme(saved);
}
