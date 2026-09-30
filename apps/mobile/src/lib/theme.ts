import { useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, type Theme } from "expo-router";

/** Godmode's tokens (apps/desktop/src/index.css): warm paper and anthracite, one quiet green accent. */
const light = {
  background: "#FAF9F5",
  surface: "#FFFFFF",
  surfaceAlt: "#F4F2ED",
  sunken: "#F1EEE9",
  text: "#1A1A1A",
  textMuted: "#75716A",
  textFaint: "#A29E96",
  border: "rgba(38, 32, 22, 0.09)",
  borderStrong: "rgba(38, 32, 22, 0.16)",
  primary: "#1C1C1C",
  onPrimary: "#FAF9F5",
  brand: "#0ECA7B",
  brandStrong: "#087F4D",
  brandSoft: "rgba(14, 202, 123, 0.12)",
  danger: "#D4101F",
  dangerSoft: "rgba(212, 16, 31, 0.08)",
  warning: "#9A5A00",
  warningSoft: "rgba(154, 90, 0, 0.09)",
  dream: "#5552C9",
  glassFallback: "rgba(255, 255, 255, 0.92)",
  scrim: "rgba(0, 0, 0, 0.4)",
};

const dark: typeof light = {
  background: "#1C1B19",
  surface: "#232220",
  surfaceAlt: "#211F1D",
  sunken: "#2A2926",
  text: "#F4F2ED",
  textMuted: "#A29E96",
  textFaint: "#75716A",
  border: "rgba(255, 250, 240, 0.085)",
  borderStrong: "rgba(255, 250, 240, 0.14)",
  primary: "#F4F2ED",
  onPrimary: "#1C1B19",
  brand: "#2FD690",
  brandStrong: "#3DDC97",
  brandSoft: "rgba(47, 214, 144, 0.14)",
  danger: "#F0525B",
  dangerSoft: "rgba(240, 82, 91, 0.12)",
  warning: "#E8A53A",
  warningSoft: "rgba(232, 165, 58, 0.12)",
  dream: "#A9A6FF",
  glassFallback: "rgba(38, 37, 35, 0.94)",
  scrim: "rgba(0, 0, 0, 0.55)",
};

export type Colors = typeof light;

export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };

export const type = {
  largeTitle: { fontSize: 32, fontWeight: "700", letterSpacing: -0.6 },
  title: { fontSize: 22, fontWeight: "600", letterSpacing: -0.4 },
  headline: { fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 23, letterSpacing: -0.1 },
  callout: { fontSize: 15, lineHeight: 20 },
  subhead: { fontSize: 14, lineHeight: 19 },
  footnote: { fontSize: 13, lineHeight: 17 },
  caption: { fontSize: 12, lineHeight: 15 },
  eyebrow: { fontSize: 11, fontWeight: "600", letterSpacing: 1.1, textTransform: "uppercase" },
  mono: { fontFamily: process.env.EXPO_OS === "ios" ? "Menlo" : "monospace", fontSize: 13 },
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
  };
}
