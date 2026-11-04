import { DEFAULT_PALETTE, PALETTE_DEFS, type Palette, type PaletteMode, type PaletteStyle, type Seeds } from "@godmode/shared";
import { t } from "@/i18n";

export { DEFAULT_PALETTE, PALETTE_DEFS, isPalette } from "@godmode/shared";
export type { PaletteDef, PaletteStyle, Seeds } from "@godmode/shared";

export type Mode = PaletteMode;

export const paletteLabel = (p: Palette): string => t(`system:palettes.${p}.label`);
export const paletteBlurb = (p: Palette): string => t(`system:palettes.${p}.blurb`);

const mix = (color: string, pct: number, into = "transparent") => `color-mix(in srgb, ${color} ${pct}%, ${into})`;

export function paletteTokens(s: Seeds, mode: Mode, style?: PaletteStyle): Record<string, string> {
  const fg = s.foreground;
  const border = style?.border ?? 9;
  const ring = style?.ring === "brand" ? s.brand : mix(fg, 28);
  const shadows = style?.shadows?.[mode];
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
    "--border": mix(fg, border),
    "--input": mix(fg, border + 4),
    "--ring": ring,
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
    "--sidebar-border": mix(fg, border - 1),
    "--sidebar-ring": ring,
    ...(shadows?.card ? { "--gm-shadow-card": shadows.card } : {}),
    ...(shadows?.float ? { "--gm-shadow-float": shadows.float } : {}),
  };
}

export function styleTokens(style: PaletteStyle | undefined): Record<string, string> {
  if (!style) return {};
  const tokens: Record<string, string> = {};
  if (style.radius) tokens["--radius"] = style.radius;
  if (style.fontSans) tokens["--gm-font-sans"] = style.fontSans;
  if (style.fontMono) tokens["--gm-font-mono"] = style.fontMono;
  if (style.fontScale) tokens["--gm-font-scale"] = String(style.fontScale);
  if (style.fontFeatures) tokens["--gm-font-features"] = style.fontFeatures;
  if (style.tracking) tokens["--gm-tracking"] = style.tracking;
  if (style.headingTracking) tokens["--gm-heading-tracking"] = style.headingTracking;
  if (style.strongWeight) tokens["--gm-strong-weight"] = String(style.strongWeight);
  return tokens;
}

const block = (selector: string, tokens: Record<string, string>) =>
  `${selector}{${Object.entries(tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

export function paletteCss(id: Palette): string {
  if (id === DEFAULT_PALETTE) return "";
  const def = PALETTE_DEFS[id];
  const sel = `:root[data-palette="${id}"]`;
  return block(sel, { ...styleTokens(def.style), ...paletteTokens(def.light, "light", def.style) }) + block(`${sel}.dark`, paletteTokens(def.dark, "dark", def.style));
}
