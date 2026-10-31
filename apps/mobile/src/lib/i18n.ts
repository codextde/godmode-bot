import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Locale } from "date-fns";
import { de as deLocale, enUS } from "date-fns/locale";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { APP_LANGUAGES, type AppLanguage } from "@godmode/shared";
import { NAMESPACES, resources } from "@/locales";

export type UiLanguage = Exclude<AppLanguage, "system">;

const KEY = "godmode.language";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** The phone's own language when the app speaks it; English otherwise. */
export function deviceLanguage(): UiLanguage {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    return tag.startsWith("de") ? "de" : "en";
  } catch {
    return "en";
  }
}

const resolve = (choice: AppLanguage): UiLanguage => (choice === "system" ? deviceLanguage() : choice);

void i18n.use(initReactI18next).init({
  resources,
  lng: deviceLanguage(),
  fallbackLng: "en",
  supportedLngs: ["en", "de"],
  ns: [...NAMESPACES],
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

interface LanguageState {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
}

/** The computer's language (Settings → General); "system" follows this phone. Kept on the phone for the next cold start. */
export const useLanguage = create<LanguageState>((set, get) => ({
  language: "system",
  setLanguage: (language) => {
    if (!APP_LANGUAGES.includes(language)) return;
    const next = resolve(language);
    if (i18n.language !== next) void i18n.changeLanguage(next);
    if (get().language === language) return;
    set({ language });
    void SecureStore.setItemAsync(KEY, language, STORE_OPTIONS).catch(() => undefined);
  },
}));

export async function loadLanguage(): Promise<void> {
  const saved = (await SecureStore.getItemAsync(KEY, STORE_OPTIONS).catch(() => null)) as AppLanguage | null;
  if (saved && APP_LANGUAGES.includes(saved)) useLanguage.getState().setLanguage(saved);
}

export const currentLanguage = (): UiLanguage => (i18n.language === "de" ? "de" : "en");

/** BCP 47 tag for Intl and toLocale* calls. */
export const intlLocale = (): string => (currentLanguage() === "de" ? "de-DE" : "en-US");

/** The date-fns locale for format, formatDistance and friends. */
export const dateLocale = (): Locale => (currentLanguage() === "de" ? deLocale : enUS);

export const t = i18n.t.bind(i18n);

export default i18n;
