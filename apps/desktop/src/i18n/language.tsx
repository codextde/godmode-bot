import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppLanguage } from "@godmode/shared";
import { useSharedChoice } from "@/components/theme-provider";
import { isTauri } from "@/lib/core";
import i18n, { LANGUAGE_KEY, dateLocale, intlLocale, isAppLanguage, resolveLanguage, storedLanguage, type UiLanguage } from "./index";

type LanguageState = { language: AppLanguage; resolved: UiLanguage; setLanguage: (l: AppLanguage) => void };

const LanguageContext = createContext<LanguageState>({ language: "system", resolved: "en", setLanguage: () => {} });

const remember = (l: AppLanguage) => {
  try {
    localStorage.setItem(LANGUAGE_KEY, l);
  } catch {
    /* ignore */
  }
};

/** The language is a setting of this Godmode like the theme; localStorage only remembers it for the first paint. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useSharedChoice("language", storedLanguage, isAppLanguage, remember);
  const [system, setSystem] = useState(() => resolveLanguage("system"));
  const resolved = language === "system" ? system : language;

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
      .then(({ invoke }) => invoke("set_tray_labels", { open: tr("tray.open"), newChat: tr("tray.newChat"), quit: tr("tray.quit") }))
      .catch(() => {});
  }, [resolved]);

  return <LanguageContext.Provider value={{ language, resolved, setLanguage }}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);

/** Locales for date-fns and Intl that follow the app language and re-render when it changes. */
export function useLocale() {
  const { i18n: instance } = useTranslation();
  void instance.language;
  return { dateLocale: dateLocale(), intlLocale: intlLocale() };
}
