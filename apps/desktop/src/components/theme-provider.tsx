import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@/lib/core";

type Theme = "dark" | "light" | "system";

const DEFAULT_THEME: Theme = "light";

const ThemeContext = createContext<{ theme: Theme; resolved: "dark" | "light"; setTheme: (t: Theme) => void }>({
  theme: DEFAULT_THEME,
  resolved: "light",
  setTheme: () => {},
});

/** Paper / anthracite — must match --background in index.css. */
const WINDOW_BG = { light: "#faf9f5", dark: "#1c1b19" } as const;

/** Desktop: keep the native window (title bar, resize fill) in step with the app theme. Best effort. */
function syncNativeWindow(theme: "dark" | "light") {
  if (!isTauri) return;
  void import("@tauri-apps/api/webviewWindow")
    .then(async ({ getCurrentWebviewWindow }) => {
      const win = getCurrentWebviewWindow();
      await Promise.allSettled([win.setBackgroundColor(WINDOW_BG[theme]), win.setTheme(theme)]);
    })
    .catch(() => {});
}

function systemTheme(): "dark" | "light" {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("godmode-theme") as Theme) || DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });
  const [resolved, setResolved] = useState<"dark" | "light">(theme === "system" ? systemTheme() : theme);

  useEffect(() => {
    const apply = () => {
      const r = theme === "system" ? systemTheme() : theme;
      setResolved(r);
      const root = document.documentElement;
      root.classList.toggle("dark", r === "dark");
      // aicss components key their palette off data-theme; without it they follow the OS instead of the app.
      root.dataset.theme = r;
      root.style.colorScheme = r;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", WINDOW_BG[r]);
      syncNativeWindow(r);
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem("godmode-theme", t);
    } catch {
      /* ignore */
    }
  };

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
