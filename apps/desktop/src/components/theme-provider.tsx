import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";

const DEFAULT_THEME: Theme = "light";

const ThemeContext = createContext<{ theme: Theme; resolved: "dark" | "light"; setTheme: (t: Theme) => void }>({
  theme: DEFAULT_THEME,
  resolved: "light",
  setTheme: () => {},
});

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
