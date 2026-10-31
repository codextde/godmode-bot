import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Locale } from "date-fns";
import { de as deLocale, enUS } from "date-fns/locale";
import { getCalendars } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { APP_LANGUAGES, TIME_FORMATS, type AppLanguage, type TimeFormat } from "@godmode/shared";
import { NAMESPACES, resources } from "@/locales";

export type UiLanguage = Exclude<AppLanguage, "system">;

const KEY = "godmode.language";
const TIME_FORMAT_KEY = "godmode.timeFormat";
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

/** Whether this phone shows 12-hour times by itself (its region and its 24-hour switch). */
export function deviceHour12(): boolean {
  try {
    const uses24 = getCalendars()[0]?.uses24hourClock;
    if (typeof uses24 === "boolean") return !uses24;
    const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12";
  } catch {
    return false;
  }
}

interface TimeFormatState {
  timeFormat: TimeFormat;
  hour12: boolean;
  setTimeFormat: (timeFormat: TimeFormat) => void;
}

const resolveHour12 = (choice: TimeFormat): boolean => (choice === "system" ? deviceHour12() : choice === "12h");

/** The computer's time format (Settings → General); "system" follows this phone. Kept on the phone for the next cold start. */
export const useTimeFormat = create<TimeFormatState>((set, get) => ({
  timeFormat: "system",
  hour12: resolveHour12("system"),
  setTimeFormat: (timeFormat) => {
    if (!TIME_FORMATS.includes(timeFormat)) return;
    const hour12 = resolveHour12(timeFormat);
    const changed = hour12 !== get().hour12;
    if (get().timeFormat !== timeFormat) void SecureStore.setItemAsync(TIME_FORMAT_KEY, timeFormat, STORE_OPTIONS).catch(() => undefined);
    set({ timeFormat, hour12 });
    if (changed) void i18n.emit("languageChanged", i18n.language);
  },
}));

export async function loadTimeFormat(): Promise<void> {
  const saved = (await SecureStore.getItemAsync(TIME_FORMAT_KEY, STORE_OPTIONS).catch(() => null)) as TimeFormat | null;
  if (saved && TIME_FORMATS.includes(saved)) useTimeFormat.getState().setTimeFormat(saved);
}

export const uses12Hour = (): boolean => useTimeFormat.getState().hour12;

/** BCP 47 tag for Intl and toLocale* calls. */
export const intlLocale = (): string => (currentLanguage() === "de" ? "de-DE" : "en-US");

const clockLocales = new Map<string, Locale>();

function withClock(base: Locale, hour12: boolean): Locale {
  const key = `${base.code}-${hour12}`;
  let locale = clockLocales.get(key);
  if (!locale) {
    const short = hour12 ? "h:mm a" : "HH:mm";
    const medium = hour12 ? "h:mm:ss a" : "HH:mm:ss";
    locale = { ...base, formatLong: { ...base.formatLong!, time: ({ width } = {}) => (width === "short" ? short : medium) } };
    clockLocales.set(key, locale);
  }
  return locale;
}

/** The date-fns locale for format, formatDistance and friends; "p" and "pp" follow the time format. */
export const dateLocale = (): Locale => withClock(currentLanguage() === "de" ? deLocale : enUS, uses12Hour());

export const t = i18n.t.bind(i18n);

export default i18n;
