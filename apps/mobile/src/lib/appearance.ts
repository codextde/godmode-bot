import * as SecureStore from "expo-secure-store";
import { Appearance } from "react-native";
import { create } from "zustand";
import { DEFAULT_PALETTE, THEMES, isPalette, type Palette, type Theme } from "@godmode/shared";

const KEY = "godmode.theme";
const PALETTE_KEY = "godmode.palette";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

function apply(theme: Theme) {
  Appearance.setColorScheme(theme === "system" ? "unspecified" : theme);
}

interface AppearanceState {
  theme: Theme;
  palette: Palette;
  setTheme: (theme: Theme) => void;
  setPalette: (palette: Palette) => void;
}

/** The computer's theme (Settings → General) and this phone's own palette, light Paper until the human picks others; kept on the phone for the next cold start. */
export const useAppearance = create<AppearanceState>((set, get) => ({
  theme: "light",
  palette: DEFAULT_PALETTE,
  setTheme: (theme) => {
    if (!THEMES.includes(theme) || get().theme === theme) return;
    apply(theme);
    set({ theme });
    void SecureStore.setItemAsync(KEY, theme, STORE_OPTIONS).catch(() => undefined);
  },
  setPalette: (palette) => {
    if (!isPalette(palette) || get().palette === palette) return;
    set({ palette });
    void SecureStore.setItemAsync(PALETTE_KEY, palette, STORE_OPTIONS).catch(() => undefined);
  },
}));

apply("light");

/** Before the first screen, so the app never opens in the phone's scheme or another palette when the computer says otherwise. */
export async function loadAppearance(): Promise<void> {
  const [saved, palette] = await Promise.all([
    SecureStore.getItemAsync(KEY, STORE_OPTIONS).catch(() => null),
    SecureStore.getItemAsync(PALETTE_KEY, STORE_OPTIONS).catch(() => null),
  ]);
  if (saved && THEMES.includes(saved as Theme)) useAppearance.getState().setTheme(saved as Theme);
  if (isPalette(palette)) useAppearance.getState().setPalette(palette);
}
