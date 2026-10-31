import type { Palette } from "./models";

export type PaletteMode = "light" | "dark";

export interface Seeds {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  primary: string;
  brand: string;
  sidebar: string;
}

export interface PaletteDef {
  label: string;
  blurb: string;
  light: Seeds;
  dark: Seeds;
}

export const DEFAULT_PALETTE: Palette = "paper";

export const PALETTE_DEFS: Record<Palette, PaletteDef> = {
  paper: {
    label: "Paper",
    blurb: "Warm paper by day, anthracite by night",
    light: { background: "#faf9f5", foreground: "#1a1a1a", card: "#ffffff", muted: "#f1eee9", mutedForeground: "#75716a", primary: "#1c1c1c", brand: "#0eca7b", sidebar: "#f4f2ed" },
    dark: { background: "#1c1b19", foreground: "#f4f2ed", card: "#232220", muted: "#2a2926", mutedForeground: "#a29e96", primary: "#f4f2ed", brand: "#2fd690", sidebar: "#171614" },
  },
  graphite: {
    label: "Graphite",
    blurb: "Cool neutral greys with a blue accent",
    light: { background: "#f7f7f8", foreground: "#18181b", card: "#ffffff", muted: "#efeff1", mutedForeground: "#6b6b74", primary: "#18181b", brand: "#2563eb", sidebar: "#f0f0f2" },
    dark: { background: "#18181b", foreground: "#f4f4f5", card: "#1f1f23", muted: "#27272a", mutedForeground: "#a1a1aa", primary: "#f4f4f5", brand: "#60a5fa", sidebar: "#131316" },
  },
  nord: {
    label: "Nord",
    blurb: "Arctic blue-greys and frost",
    light: { background: "#eceff4", foreground: "#2e3440", card: "#f8f9fb", muted: "#e2e6ee", mutedForeground: "#5e6779", primary: "#3b4252", brand: "#5e81ac", sidebar: "#e5e9f0" },
    dark: { background: "#2e3440", foreground: "#eceff4", card: "#353c4a", muted: "#3b4252", mutedForeground: "#a3abbb", primary: "#88c0d0", brand: "#88c0d0", sidebar: "#2a2f3a" },
  },
  solarized: {
    label: "Solarized",
    blurb: "Ethan Schoonover's classic cream and teal",
    light: { background: "#fdf6e3", foreground: "#073642", card: "#fffbef", muted: "#eee8d5", mutedForeground: "#657b83", primary: "#073642", brand: "#268bd2", sidebar: "#f5eedb" },
    dark: { background: "#002b36", foreground: "#eee8d5", card: "#073642", muted: "#0b3d4a", mutedForeground: "#93a1a1", primary: "#eee8d5", brand: "#2aa198", sidebar: "#00232c" },
  },
  rose: {
    label: "Rosé",
    blurb: "Soft blush with a raspberry accent",
    light: { background: "#fbf7f6", foreground: "#2a1f22", card: "#ffffff", muted: "#f4ecea", mutedForeground: "#7d6a6e", primary: "#2a1f22", brand: "#d6457a", sidebar: "#f6efed" },
    dark: { background: "#1f1a1c", foreground: "#f5eef0", card: "#272124", muted: "#30292c", mutedForeground: "#ab9ea2", primary: "#f5eef0", brand: "#f07aa5", sidebar: "#191517" },
  },
  forest: {
    label: "Forest",
    blurb: "Moss, fern and bark",
    light: { background: "#f6f7f2", foreground: "#1d231c", card: "#ffffff", muted: "#ebeee4", mutedForeground: "#69725f", primary: "#1f3a2a", brand: "#2f855a", sidebar: "#eef1e8" },
    dark: { background: "#161b17", foreground: "#eef2ea", card: "#1d231e", muted: "#262d27", mutedForeground: "#9aa596", primary: "#eef2ea", brand: "#6fcf97", sidebar: "#121613" },
  },
  ocean: {
    label: "Ocean",
    blurb: "Sea glass and deep water",
    light: { background: "#f4f8fa", foreground: "#10212b", card: "#ffffff", muted: "#e7eff3", mutedForeground: "#5d717c", primary: "#0f2a3a", brand: "#0891b2", sidebar: "#ecf3f6" },
    dark: { background: "#0e1a22", foreground: "#e8f1f5", card: "#14222c", muted: "#1b2b36", mutedForeground: "#8fa5b1", primary: "#e8f1f5", brand: "#22d3ee", sidebar: "#0b151c" },
  },
  dracula: {
    label: "Dracula",
    blurb: "Purple night, and a pale day to match",
    light: { background: "#f8f8f2", foreground: "#282a36", card: "#ffffff", muted: "#eeeef5", mutedForeground: "#6272a4", primary: "#282a36", brand: "#7c5cdb", sidebar: "#f1f1f6" },
    dark: { background: "#282a36", foreground: "#f8f8f2", card: "#2f3241", muted: "#383a4a", mutedForeground: "#a4acc8", primary: "#bd93f9", brand: "#bd93f9", sidebar: "#21222c" },
  },
};

export const isPalette = (p: unknown): p is Palette => typeof p === "string" && Object.hasOwn(PALETTE_DEFS, p);
