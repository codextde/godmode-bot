import { useColorScheme, type TextStyle } from "react-native";
import { DarkTheme, DefaultTheme, type Theme } from "expo-router";

/** Godmode's tokens (apps/desktop/src/index.css): warm paper and anthracite, one quiet green accent. */
const light = {
  background: "#FAF9F5",
  surface: "#FFFFFF",
  surfaceAlt: "#F4F2ED",
  sunken: "#F1EEE9",
  accent: "#EFEBE4",
  popover: "#FFFFFF",
  text: "#1A1A1A",
  textMuted: "#75716A",
  /** muted-foreground/70, the desktop's quietest text. */
  textFaint: "#9D9A94",
  border: "rgba(38, 32, 22, 0.09)",
  borderStrong: "rgba(38, 32, 22, 0.13)",
  input: "rgba(38, 32, 22, 0.13)",
  ring: "rgba(38, 32, 22, 0.28)",
  primary: "#1C1C1C",
  onPrimary: "#FAF9F5",
  brand: "#0ECA7B",
  brandStrong: "#087F4D",
  brandSoft: "rgba(14, 202, 123, 0.12)",
  success: "#087F4D",
  successSoft: "rgba(8, 127, 77, 0.08)",
  danger: "#D4101F",
  dangerSoft: "rgba(212, 16, 31, 0.06)",
  warning: "#9A5A00",
  warningSoft: "rgba(154, 90, 0, 0.07)",
  dream: "#5552C9",
  dreamSoft: "rgba(85, 82, 201, 0.09)",
  /** Task and run states, like the desktop's amber / emerald / rose / sky / violet: `*Mark` for glyphs, the plain one for text. */
  amber: "#B45309",
  amberMark: "#F59E0B",
  emerald: "#047857",
  emeraldMark: "#10B981",
  rose: "#E11D48",
  roseMark: "#F43F5E",
  sky: "#0369A1",
  skyMark: "#0EA5E9",
  violet: "#7C3AED",
  shadowCard: "0px 1px 2px rgba(38, 32, 22, 0.04), 0px 0px 0px 0.5px rgba(38, 32, 22, 0.02)",
  shadowFloat: "0px 1px 2px rgba(38, 32, 22, 0.04), 0px 8px 24px -12px rgba(38, 32, 22, 0.12)",
  glassFallback: "rgba(255, 255, 255, 0.92)",
  scrim: "rgba(0, 0, 0, 0.4)",
};

const dark: typeof light = {
  background: "#1C1B19",
  surface: "#232220",
  surfaceAlt: "#211F1D",
  sunken: "#2A2926",
  accent: "#2E2D2A",
  popover: "#262523",
  text: "#F4F2ED",
  textMuted: "#A29E96",
  textFaint: "#7A7770",
  border: "rgba(255, 250, 240, 0.085)",
  borderStrong: "rgba(255, 250, 240, 0.12)",
  input: "rgba(255, 250, 240, 0.12)",
  ring: "rgba(255, 250, 240, 0.3)",
  primary: "#F4F2ED",
  onPrimary: "#1C1B19",
  brand: "#2FD690",
  brandStrong: "#3DDC97",
  brandSoft: "rgba(47, 214, 144, 0.14)",
  success: "#2FD690",
  successSoft: "rgba(47, 214, 144, 0.08)",
  danger: "#F0525B",
  dangerSoft: "rgba(240, 82, 91, 0.06)",
  warning: "#E8A53A",
  warningSoft: "rgba(232, 165, 58, 0.07)",
  dream: "#A9A6FF",
  dreamSoft: "rgba(169, 166, 255, 0.11)",
  amber: "#FCD34D",
  amberMark: "#F59E0B",
  emerald: "#6EE7B7",
  emeraldMark: "#10B981",
  rose: "#FB7185",
  roseMark: "#F43F5E",
  sky: "#7DD3FC",
  skyMark: "#0EA5E9",
  violet: "#A78BFA",
  shadowCard: "0px 1px 2px rgba(0, 0, 0, 0.25), 0px 0px 0px 0.5px rgba(255, 250, 240, 0.02)",
  shadowFloat: "0px 1px 2px rgba(0, 0, 0, 0.3), 0px 12px 32px -12px rgba(0, 0, 0, 0.55)",
  glassFallback: "rgba(38, 37, 35, 0.94)",
  scrim: "rgba(0, 0, 0, 0.55)",
};

export type Colors = typeof light;

/** "#RRGGBB" at an opacity, for tinted fills and borders (RN has no color-mix). */
export function alpha(hex: string, a: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * The desktop's tight corners (base 8: 4 · 6 · 8 · 12 · 14 · 16). `md` is the desktop base, `lg` a card, `xl` a sheet or
 * panel; `badge` the 5px of chips and pills.
 */
export const radius = { xs: 4, badge: 5, sm: 6, md: 8, lg: 12, xxl: 14, xl: 16, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };

/** Geist and Geist Mono (apps/desktop uses the variable fonts). One file per weight: Android can't pick weights of a variable font. */
export const fonts = {
  regular: "Geist-Regular",
  medium: "Geist-Medium",
  semibold: "Geist-SemiBold",
  bold: "Geist-Bold",
  mono: "GeistMono-Regular",
  monoMedium: "GeistMono-Medium",
} as const;

const SANS = new Set<string>([fonts.regular, fonts.medium, fonts.semibold, fonts.bold]);
const MONO = new Set<string>([fonts.mono, fonts.monoMedium]);

/** The Geist file for a weight (`mono`: Geist Mono, which ships 400 and 500). */
export function fontFor(weight: TextStyle["fontWeight"], mono = false): string {
  const w = weight === "bold" ? 700 : weight === "normal" || weight == null ? 400 : Number(weight) || 400;
  if (mono) return w >= 500 ? fonts.monoMedium : fonts.mono;
  return w >= 700 ? fonts.bold : w >= 600 ? fonts.semibold : w >= 500 ? fonts.medium : fonts.regular;
}

/**
 * A style's weight moved into its Geist family: a custom font plus `fontWeight` is synthesised (smeared) on Android.
 * Styles with another font (a screen's own) stay as they are.
 */
export function withFont<S extends TextStyle>(style: S): S {
  const family = style.fontFamily;
  const mono = !!family && MONO.has(family);
  if (family && !mono && !SANS.has(family)) return style;
  if (style.fontWeight == null && family) return style;
  return { ...style, fontFamily: fontFor(style.fontWeight, mono), fontWeight: undefined };
}

/** Headings in weight 500 with tight tracking, like the desktop's `heading-display` and page titles. */
export const type = {
  largeTitle: { fontFamily: fonts.medium, fontSize: 30, lineHeight: 34, letterSpacing: -0.9 },
  title: { fontFamily: fonts.medium, fontSize: 22, lineHeight: 27, letterSpacing: -0.55 },
  headline: { fontFamily: fonts.medium, fontSize: 17, lineHeight: 22, letterSpacing: -0.25 },
  body: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 23, letterSpacing: -0.1 },
  callout: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 20, letterSpacing: -0.05 },
  subhead: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 19 },
  footnote: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 17 },
  caption: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 15 },
  eyebrow: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 16, letterSpacing: 1.32, textTransform: "uppercase" },
  mono: { fontFamily: fonts.mono, fontSize: 13 },
} as const;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

export function useIsDark(): boolean {
  return useColorScheme() === "dark";
}

export function useNavigationTheme(): Theme {
  const isDark = useIsDark();
  const c = isDark ? dark : light;
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: { ...base.colors, background: c.background, card: c.background, text: c.text, border: c.border, primary: c.text },
    fonts: {
      regular: { fontFamily: fonts.regular, fontWeight: "400" },
      medium: { fontFamily: fonts.medium, fontWeight: "500" },
      bold: { fontFamily: fonts.semibold, fontWeight: "600" },
      heavy: { fontFamily: fonts.bold, fontWeight: "700" },
    },
  };
}
