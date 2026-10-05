"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * Light by default, dark supported, "system" follows the OS. Stored in localStorage under "godmode-theme" — the same
 * key the Godmode dashboard uses under /d/…, so both stay in step (also across tabs). public/theme-init.js applies the
 * stored theme before first paint; this provider keeps <html> in sync afterwards.
 */
export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "godmode-theme";
const DEFAULT_THEME: Theme = "light";
const CHANGE_EVENT = "godmode-theme-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" || value === "system" ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function subscribeTheme(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function systemIsDark() {
  return window.matchMedia(DARK_QUERY).matches;
}

function subscribeSystem(onChange: () => void) {
  const mql = window.matchMedia(DARK_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function resolve(theme: Theme, dark: boolean): ResolvedTheme {
  return theme === "system" ? (dark ? "dark" : "light") : theme;
}

function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // The browser chrome (address bar, status bar) takes the page's own background.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(document.body).backgroundColor);
}

interface ThemeContextValue {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolved: "light",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => DEFAULT_THEME);
  const dark = useSyncExternalStore(subscribeSystem, systemIsDark, () => false);
  const resolved = resolve(theme, dark);

  useEffect(() => {
    // Read the stored value here rather than trusting the render: the hydration pass renders the server default,
    // and applying that would undo theme-init.js for a frame.
    applyTheme(resolve(readTheme(), systemIsDark()));
  }, [theme, dark]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode or storage disabled: the choice lasts for this page only.
    }
    applyTheme(resolve(next, systemIsDark()));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
