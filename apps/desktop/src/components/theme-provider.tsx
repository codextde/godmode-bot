import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { THEMES, type Bootstrap, type Settings } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { cloudContext, isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";

export type Theme = Settings["general"]["theme"];
type Resolved = "dark" | "light";

const DEFAULT_THEME: Theme = "light";
const STORAGE_KEY = "godmode-theme";

const ThemeContext = createContext<{ theme: Theme; resolved: Resolved; setTheme: (t: Theme) => void; toggle: () => void }>({
  theme: DEFAULT_THEME,
  resolved: "light",
  setTheme: () => {},
  toggle: () => {},
});

/** Paper / anthracite — must match --background in index.css. */
const WINDOW_BG = { light: "#faf9f5", dark: "#1c1b19" } as const;

/** Desktop: keep the native window (title bar, resize fill) in step with the app theme. Best effort. */
function syncNativeWindow(theme: Resolved) {
  if (!isTauri) return;
  void import("@tauri-apps/api/webviewWindow")
    .then(async ({ getCurrentWebviewWindow }) => {
      const win = getCurrentWebviewWindow();
      await Promise.allSettled([win.setBackgroundColor(WINDOW_BG[theme]), win.setTheme(theme)]);
    })
    .catch(() => {});
}

const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");

function systemTheme(): Resolved {
  return darkQuery()?.matches ? "dark" : "light";
}

function readStored(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "dark" || t === "system" ? t : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function store(t: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* ignore */
  }
}

/** The palette the page should show; a crossfade that runs late still paints the newest one. */
let target: Resolved = "light";

/** Swaps the palette in one step: no half-faded controls, and a soft crossfade where the webview can do it. */
function applyTheme(r: Resolved, animate: boolean) {
  const root = document.documentElement;
  target = r;
  const swap = () => {
    const t = target;
    root.classList.add("theme-switching");
    root.classList.toggle("dark", t === "dark");
    // aicss components key their palette off data-theme; without it they follow the OS instead of the app.
    root.dataset.theme = t;
    root.style.colorScheme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", WINDOW_BG[t]);
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  };
  const changed = root.classList.contains("dark") !== (r === "dark") || root.dataset.theme !== r;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (changed && animate && !calm && typeof document.startViewTransition === "function") document.startViewTransition(swap);
  else swap();
  syncNativeWindow(r);
}

const isTheme = (t: unknown): t is Theme => THEMES.includes(t as Theme);

/** People the owner let into the cloud dashboard keep a theme of their own in their browser. */
const personal = !!cloudContext && cloudContext.role !== "owner";

/**
 * The theme is a setting of this Godmode (Settings → General), so the desktop app, the browser dashboard, the phone and
 * agents all see the same one. localStorage only remembers it for the first paint (public/theme-init.js).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [system, setSystem] = useState<Resolved>(systemTheme);
  const resolved: Resolved = theme === "system" ? system : theme;
  const painted = useRef(false);
  /** Saves still on their way: until the last one is answered, a refresh may still carry the old theme. */
  const saving = useRef(0);

  // Reads the setting from whatever the app already loaded; never asks the core itself (e.g. on the sign-in page).
  const { data: saved } = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap, enabled: false, select: (b) => b.settings.general.theme });

  const adopt = useCallback((t: unknown) => {
    if (personal || !isTheme(t)) return;
    setThemeState(t);
    store(t);
  }, []);

  useEffect(() => {
    if (saving.current === 0) adopt(saved);
  }, [saved, adopt]);

  useEffect(() => {
    const mq = darkQuery();
    if (!mq) return;
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolved, painted.current);
    painted.current = true;
  }, [resolved]);

  const { mutate: persist } = useMutation({
    scope: { id: "theme" },
    mutationFn: (t: Theme) => api.settings.update({ general: { theme: t } }),
    onSuccess: async () => {
      if (--saving.current > 0) return;
      await Promise.all([qc.invalidateQueries({ queryKey: qk.settings }), qc.invalidateQueries({ queryKey: qk.bootstrap })]);
      if (saving.current === 0) adopt(qc.getQueryData<Bootstrap>(qk.bootstrap)?.settings.general.theme);
    },
    // Not saved (a secondary computer while its primary is away, a dashboard that may only look): the choice stays here.
    onError: (err) => {
      saving.current--;
      const status = (err as { status?: number }).status;
      if (status !== 403 && status !== 409) toast.error("Could not save the theme", { description: errorMessage(err) });
    },
  });

  const setTheme = useCallback(
    (t: Theme) => {
      setThemeState(t);
      store(t);
      if (personal) return;
      saving.current++;
      persist(t);
    },
    [persist],
  );

  const toggle = useCallback(() => setTheme(resolved === "dark" ? "light" : "dark"), [resolved, setTheme]);

  return <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
