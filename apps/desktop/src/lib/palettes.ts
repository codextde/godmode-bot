import { DEFAULT_PALETTE, PALETTE_DEFS, type Palette, type PaletteMode, type Seeds } from "@godmode/shared";
import { t } from "@/i18n";

export { DEFAULT_PALETTE, PALETTE_DEFS, isPalette } from "@godmode/shared";
export type { PaletteDef, Seeds } from "@godmode/shared";

export type Mode = PaletteMode;

export const paletteLabel = (p: Palette): string => t(`system:palettes.${p}.label`);
export const paletteBlurb = (p: Palette): string => t(`system:palettes.${p}.blurb`);

const mix = (color: string, pct: number, into = "transparent") => `color-mix(in srgb, ${color} ${pct}%, ${into})`;

export function paletteTokens(s: Seeds, mode: Mode): Record<string, string> {
  const fg = s.foreground;
  return {
    "--background": s.background,
    "--foreground": fg,
    "--card": s.card,
    "--card-foreground": fg,
    "--popover": s.card,
    "--popover-foreground": fg,
    "--primary": s.primary,
    "--primary-foreground": s.background,
    "--secondary": s.muted,
    "--secondary-foreground": fg,
    "--muted": s.muted,
    "--muted-foreground": s.mutedForeground,
    "--accent": mix(fg, 4, s.muted),
    "--accent-foreground": fg,
    "--border": mix(fg, 9),
    "--input": mix(fg, 13),
    "--ring": mix(fg, 28),
    "--brand": s.brand,
    "--brand-strong": mode === "light" ? mix(s.brand, 72, "black") : mix(s.brand, 88, "white"),
    "--brand-soft": mix(s.brand, 13),
    "--paper-2": s.sidebar,
    "--chart-1": s.brand,
    "--sidebar": s.sidebar,
    "--sidebar-foreground": mix(fg, 85, s.sidebar),
    "--sidebar-primary": s.primary,
    "--sidebar-primary-foreground": s.background,
    "--sidebar-accent": mix(fg, 6),
    "--sidebar-accent-foreground": fg,
    "--sidebar-border": mix(fg, 8),
    "--sidebar-ring": mix(fg, 28),
  };
}

const block = (selector: string, tokens: Record<string, string>) =>
  `${selector}{${Object.entries(tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

export function paletteCss(id: Palette): string {
  if (id === DEFAULT_PALETTE) return "";
  const def = PALETTE_DEFS[id];
  const sel = `:root[data-palette="${id}"]`;
  return block(sel, paletteTokens(def.light, "light")) + block(`${sel}.dark`, paletteTokens(def.dark, "dark"));
}
