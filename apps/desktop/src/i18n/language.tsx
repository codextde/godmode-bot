import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppLanguage, TimeFormat } from "@godmode/shared";
import { useSharedChoice } from "@/components/theme-provider";
import { isTauri } from "@/lib/core";
import i18n, {
  LANGUAGE_KEY,
  TIME_FORMAT_KEY,
  applyTimeFormat,
  currentSystemClock,
  dateLocale,
  intlLocale,
  isAppLanguage,
  isTimeFormat,
  resolveLanguage,
  storedLanguage,
  storedTimeFormat,
  systemHour12,
  type SystemClock,
  type UiLanguage,
} from "./index";

type LanguageState = {
  language: AppLanguage;
  resolved: UiLanguage;
  setLanguage: (l: AppLanguage) => void;
  timeFormat: TimeFormat;
  systemHour12: boolean;
  setTimeFormat: (f: TimeFormat) => void;
};

const LanguageContext = createContext<LanguageState>({
  language: "system",
  resolved: "en",
  setLanguage: () => {},
  timeFormat: "system",
  systemHour12: false,
  setTimeFormat: () => {},
});

const remember = (l: AppLanguage) => {
  try {
    localStorage.setItem(LANGUAGE_KEY, l);
  } catch {
    /* ignore */
  }
};

const rememberTimeFormat = (f: TimeFormat) => {
  try {
    localStorage.setItem(TIME_FORMAT_KEY, f);
  } catch {
    /* ignore */
  }
};

/** The language is a setting of this Godmode like the theme; localStorage only remembers it for the first paint. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useSharedChoice("language", storedLanguage, isAppLanguage, remember);
  const [system, setSystem] = useState(() => resolveLanguage("system"));
  const resolved = language === "system" ? system : language;
  const [timeFormat, setTimeFormat] = useSharedChoice("timeFormat", storedTimeFormat, isTimeFormat, rememberTimeFormat);
  const [clock, setClock] = useState<SystemClock>(currentSystemClock);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<SystemClock>("system_clock"))
      .then((c) => !cancelled && setClock(c))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => applyTimeFormat(timeFormat, clock), [timeFormat, clock]);

  useEffect(() => {
    const onChange = () => setSystem(resolveLanguage("system"));
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);

  useEffect(() => {
    if (i18n.language !== resolved) void i18n.changeLanguage(resolved);
    if (!isTauri) return;
    const tr = i18n.getFixedT(resolved, "common");
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_tray_labels", { open: tr("tray.open"), newChat: tr("tray.newChat"), quit: tr("tray.quit"), checkUpdates: tr("tray.checkUpdates") }))
      .catch(() => {});
  }, [resolved]);

  return (
    <LanguageContext.Provider value={{ language, resolved, setLanguage, timeFormat, systemHour12: systemHour12(clock), setTimeFormat }}>{children}</LanguageContext.Provider>
  );
}

export const useLanguage = () => useContext(LanguageContext);

/** Locales for date-fns and Intl that follow the app language and re-render when it changes. */
export function useLocale() {
  const { i18n: instance } = useTranslation();
  void instance.language;
  return { dateLocale: dateLocale(), intlLocale: intlLocale() };
}
