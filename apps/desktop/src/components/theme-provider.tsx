import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { THEMES, type Bootstrap, type Palette, type Settings } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { cloudContext, isTauri } from "@/lib/core";
import { DEFAULT_PALETTE, PALETTE_DEFS, isPalette, paletteCss } from "@/lib/palettes";
import { qk } from "@/lib/queryKeys";

export type Theme = Settings["general"]["theme"];
type Resolved = "dark" | "light";
type General = Settings["general"];

const DEFAULT_THEME: Theme = "light";
const STORAGE_KEY = "godmode-theme";
const PALETTE_KEY = "godmode-palette";
const PALETTE_CSS_KEY = "godmode-palette-css";

const ThemeContext = createContext<{
  theme: Theme;
  resolved: Resolved;
  palette: Palette;
  setTheme: (t: Theme) => void;
  setPalette: (p: Palette) => void;
  toggle: () => void;
}>({
  theme: DEFAULT_THEME,
  resolved: "light",
  palette: DEFAULT_PALETTE,
  setTheme: () => {},
  setPalette: () => {},
  toggle: () => {},
});

const windowBg = (palette: Palette, theme: Resolved) => PALETTE_DEFS[palette][theme].background;

/** Desktop: keep the native window (title bar, resize fill) in step with the app theme. Best effort. */
function syncNativeWindow(theme: Resolved, background: string) {
  if (!isTauri) return;
  void import("@tauri-apps/api/webviewWindow")
    .then(async ({ getCurrentWebviewWindow }) => {
      const win = getCurrentWebviewWindow();
      await Promise.allSettled([win.setBackgroundColor(background), win.setTheme(theme)]);
    })
    .catch(() => {});
}

const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");

function systemTheme(): Resolved {
  return darkQuery()?.matches ? "dark" : "light";
}

const isTheme = (t: unknown): t is Theme => THEMES.includes(t as Theme);

function readStored<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function rememberPalette(p: Palette) {
  store(PALETTE_KEY, p);
  store(PALETTE_CSS_KEY, paletteCss(p));
}

function paletteStyle(): HTMLStyleElement {
  let el = document.getElementById("gm-palette") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "gm-palette";
    document.head.appendChild(el);
  }
  return el;
}

/** The look the page should show; a crossfade that runs late still paints the newest one. */
let target: { mode: Resolved; palette: Palette } = { mode: "light", palette: DEFAULT_PALETTE };

/** Swaps the palette in one step: no half-faded controls, and a soft crossfade where the webview can do it. */
function applyTheme(mode: Resolved, palette: Palette, animate: boolean) {
  const root = document.documentElement;
  target = { mode, palette };
  const swap = () => {
    const t = target;
    root.classList.add("theme-switching");
    const style = paletteStyle();
    const css = paletteCss(t.palette);
    if (style.textContent !== css) style.textContent = css;
    root.dataset.palette = t.palette;
    root.classList.toggle("dark", t.mode === "dark");
    // aicss components key their palette off data-theme; without it they follow the OS instead of the app.
    root.dataset.theme = t.mode;
    root.style.colorScheme = t.mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", windowBg(t.palette, t.mode));
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  };
  const changed = root.classList.contains("dark") !== (mode === "dark") || root.dataset.theme !== mode || root.dataset.palette !== palette;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (changed && animate && !calm && typeof document.startViewTransition === "function") document.startViewTransition(swap);
  else swap();
  syncNativeWindow(mode, windowBg(palette, mode));
}

/** People the owner let into the cloud dashboard keep a theme of their own in their browser. */
const personal = !!cloudContext && cloudContext.role !== "owner";

export function useSharedChoice<K extends "theme" | "palette" | "language">(
  key: K,
  initial: () => General[K],
  valid: (v: unknown) => v is General[K],
  remember: (v: General[K]) => void,
) {
  const qc = useQueryClient();
  const [value, setValue] = useState<General[K]>(initial);
  /** Saves still on their way: until the last one is answered, a refresh may still carry the old value. */
  const saving = useRef(0);

  // Reads the setting from whatever the app already loaded; never asks the core itself (e.g. on the sign-in page).
  const { data: saved } = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap, enabled: false, select: (b) => b.settings.general[key] });

  const adopt = useCallback(
    (v: unknown) => {
      if (personal || !valid(v)) return;
      setValue(v);
      remember(v);
    },
    [valid, remember],
  );

  useEffect(() => {
    if (saving.current === 0) adopt(saved);
  }, [saved, adopt]);

  const { mutate: persist } = useMutation({
    scope: { id: key },
    mutationFn: (v: General[K]) => api.settings.update({ general: { [key]: v } }),
    onSuccess: async () => {
      if (--saving.current > 0) return;
      await Promise.all([qc.invalidateQueries({ queryKey: qk.settings }), qc.invalidateQueries({ queryKey: qk.bootstrap })]);
      if (saving.current === 0) adopt(qc.getQueryData<Bootstrap>(qk.bootstrap)?.settings.general[key]);
    },
    // Not saved (a secondary computer while its primary is away, a dashboard that may only look): the choice stays here.
    onError: (err) => {
      saving.current--;
      const status = (err as { status?: number }).status;
      if (status !== 403 && status !== 409) toast.error(`Could not save the ${key}`, { description: errorMessage(err) });
    },
  });

  const set = useCallback(
    (v: General[K]) => {
      setValue(v);
      remember(v);
      if (personal) return;
      saving.current++;
      persist(v);
    },
    [persist, remember],
  );

  return [value, set] as const;
}

const readTheme = () => readStored(STORAGE_KEY, (t): t is Theme => t === "dark" || t === "system", DEFAULT_THEME);
const rememberTheme = (t: Theme) => store(STORAGE_KEY, t);
const readPalette = () => readStored(PALETTE_KEY, isPalette, DEFAULT_PALETTE);

/**
 * The theme (light, dark or system) and the palette are settings of this Godmode (Settings → General), so the desktop
 * app, the browser dashboard, the phone and agents all see the same ones. localStorage only remembers them for the first
 * paint (public/theme-init.js).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useSharedChoice("theme", readTheme, isTheme, rememberTheme);
  const [palette, setPalette] = useSharedChoice("palette", readPalette, isPalette, rememberPalette);
  const [system, setSystem] = useState<Resolved>(systemTheme);
  const resolved: Resolved = theme === "system" ? system : theme;
  const painted = useRef(false);

  useEffect(() => {
    const mq = darkQuery();
    if (!mq) return;
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolved, palette, painted.current);
    painted.current = true;
  }, [resolved, palette]);

  const toggle = useCallback(() => setTheme(resolved === "dark" ? "light" : "dark"), [resolved, setTheme]);

  return <ThemeContext.Provider value={{ theme, resolved, palette, setTheme, setPalette, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
