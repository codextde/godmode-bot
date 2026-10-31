import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Locale } from "date-fns";
import { de as deLocale, enUS } from "date-fns/locale";
import { TIME_FORMATS, type AppLanguage, type TimeFormat } from "@godmode/shared";
import { NAMESPACES } from "./namespaces";

export type UiLanguage = Exclude<AppLanguage, "system">;

export const UI_LANGUAGES: readonly UiLanguage[] = ["en", "de"];
export const LANGUAGE_KEY = "godmode-language";
export const TIME_FORMAT_KEY = "godmode-time-format";

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

export const isTimeFormat = (v: unknown): v is TimeFormat => TIME_FORMATS.includes(v as TimeFormat);

export function storedTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem(TIME_FORMAT_KEY);
    return isTimeFormat(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** What the computer itself says about its clock: its region as a BCP 47 tag and a forced 12/24-hour switch. */
export type SystemClock = { locale?: string | null; hour12?: boolean | null };

const SYSTEM_CLOCK_KEY = "godmode-system-clock";

function storedSystemClock(): SystemClock {
  try {
    const v = JSON.parse(localStorage.getItem(SYSTEM_CLOCK_KEY) ?? "{}") as SystemClock;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let timeFormat: TimeFormat = storedTimeFormat();
let systemClock: SystemClock = storedSystemClock();

export function systemHour12(clock: SystemClock = systemClock): boolean {
  if (typeof clock.hour12 === "boolean") return clock.hour12;
  try {
    const cycle = new Intl.DateTimeFormat(clock.locale || undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12";
  } catch {
    return false;
  }
}

/** Whether clock times read "3:00 PM" rather than "15:00". */
export const currentSystemClock = (): SystemClock => systemClock;

export const uses12Hour = (): boolean => (timeFormat === "system" ? systemHour12() : timeFormat === "12h");

/** Switches the clock of every time the app shows; components re-render like after a language change. */
export function applyTimeFormat(choice: TimeFormat, clock?: SystemClock): void {
  const before = uses12Hour();
  timeFormat = choice;
  if (clock) {
    systemClock = clock;
    try {
      localStorage.setItem(SYSTEM_CLOCK_KEY, JSON.stringify(clock));
    } catch {
      /* ignore */
    }
  }
  if (uses12Hour() !== before) void i18n.emit("languageChanged", i18n.language);
}

/** BCP 47 tag for Intl and toLocale* calls, so numbers and dates read like the rest of the app (clock included). */
export const intlLocale = (): string => `${currentLanguage() === "de" ? "de-DE" : "en-US"}-u-hc-${uses12Hour() ? "h12" : "h23"}`;

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
