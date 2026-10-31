import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Locale } from "date-fns";
import { de as deLocale, enUS } from "date-fns/locale";
import type { AppLanguage } from "@godmode/shared";
import { NAMESPACES } from "./namespaces";

export type UiLanguage = Exclude<AppLanguage, "system">;

export const UI_LANGUAGES: readonly UiLanguage[] = ["en", "de"];
export const LANGUAGE_KEY = "godmode-language";

const files = import.meta.glob<Record<string, unknown>>("./locales/*/*.json", { eager: true, import: "default" });

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, data] of Object.entries(files)) {
  const [, lng, ns] = path.match(/\.\/locales\/(\w+)\/(\w+)\.json$/) ?? [];
  if (!lng || !ns) continue;
  (resources[lng] ??= {})[ns] = data;
}

export const isAppLanguage = (v: unknown): v is AppLanguage => v === "system" || UI_LANGUAGES.includes(v as UiLanguage);

/** The first language of this device the app speaks; English otherwise. */
export function systemLanguage(): UiLanguage {
  const wanted = typeof navigator === "undefined" ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]);
  for (const tag of wanted) {
    const base = tag?.toLowerCase().split("-")[0];
    if (UI_LANGUAGES.includes(base as UiLanguage)) return base as UiLanguage;
  }
  return "en";
}

export const resolveLanguage = (choice: AppLanguage): UiLanguage => (choice === "system" ? systemLanguage() : choice);

export function storedLanguage(): AppLanguage {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return isAppLanguage(v) ? v : "system";
  } catch {
    return "system";
  }
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(storedLanguage()),
  fallbackLng: "en",
  supportedLngs: UI_LANGUAGES,
  ns: [...NAMESPACES],
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

export const currentLanguage = (): UiLanguage => (i18n.language === "de" ? "de" : "en");

/** BCP 47 tag for Intl and toLocale* calls, so numbers and dates read like the rest of the app. */
export const intlLocale = (): string => (currentLanguage() === "de" ? "de-DE" : "en-US");

/** The date-fns locale for format, formatDistance and friends. */
export const dateLocale = (): Locale => (currentLanguage() === "de" ? deLocale : enUS);

export const t = i18n.t.bind(i18n);

export default i18n;
