/**
 * Agent characters: every agent is a small, cute creature with a body, a face, a few accessories, a colour and a
 * personality. The look is framework-agnostic — `renderCharacterSvg` returns plain SVG markup the desktop app, the
 * phone app and the website all render — and animation (blinking, looking around, bouncing) is CSS driven by the
 * classes and `data-mood` attribute on that markup.
 *
 * Features on the body are always dark ink; hats, antennas, headphones and the sleeping z's stick out past the body
 * and use `currentColor`, so give the <svg> (or an ancestor) a text colour that contrasts with the background —
 * character.css defaults to ink and switches to a light outline in `.dark`, overridable with `--gm-outline`.
 *
 * Geometry lives in a 100×100 box. Bodies sit roughly between y≈18 and y≈94, leaving headroom for hats and antennas.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

export const CHARACTER_BODIES = ["blob", "gumdrop", "squircle", "cloud", "ghost", "pebble", "drop", "kitty"] as const;
export const CHARACTER_EYES = ["dots", "wide", "happy", "sleepy", "wink", "lines"] as const;
export const CHARACTER_MOUTHS = ["smile", "grin", "cat", "o", "flat", "none"] as const;
export const CHARACTER_TOPS = ["none", "bolt", "antenna", "sprout", "beret", "cap", "crown", "bow", "party", "headphones"] as const;
export const CHARACTER_FACES = ["none", "glasses", "shades", "blush"] as const;
export const CHARACTER_NECKS = ["none", "bowtie", "scarf"] as const;

export type CharacterBody = (typeof CHARACTER_BODIES)[number];
export type CharacterEyes = (typeof CHARACTER_EYES)[number];
export type CharacterMouth = (typeof CHARACTER_MOUTHS)[number];
export type CharacterTop = (typeof CHARACTER_TOPS)[number];
export type CharacterFace = (typeof CHARACTER_FACES)[number];
export type CharacterNeck = (typeof CHARACTER_NECKS)[number];

/** What an agent looks like. Its colour is the agent's `color` (one of AGENT_COLORS). */
export interface AgentCharacter {
  body: CharacterBody;
  eyes: CharacterEyes;
  mouth: CharacterMouth;
  /** Hat, antenna or headphones. */
  top: CharacterTop;
  /** Glasses, sunglasses or rosy cheeks. */
  face: CharacterFace;
  neck: CharacterNeck;
}

/**
 * A momentary expression layered over the character's own face:
 * idle (blinks), thinking (looks up, pondering), working (eyes scan, focused), happy (just finished),
 * attention (needs the human: wide eyes), error (something went wrong), sleeping (disabled).
 */
export const CHARACTER_MOODS = ["idle", "thinking", "working", "happy", "attention", "error", "sleeping"] as const;
export type CharacterMood = (typeof CHARACTER_MOODS)[number];

export const CHARACTER_LABELS = {
  body: {
    blob: "Mochi",
    gumdrop: "Gumdrop",
    squircle: "Cube",
    cloud: "Cloud",
    ghost: "Ghost",
    pebble: "Pebble",
    drop: "Drop",
    kitty: "Kitty",
  },
  eyes: { dots: "Dots", wide: "Sparkly", happy: "Happy", sleepy: "Content", wink: "Wink", lines: "Chill" },
  mouth: { smile: "Smile", grin: "Grin", cat: "Cat", o: "Ooh", flat: "Neutral", none: "None" },
  top: {
    none: "None",
    bolt: "Bolt",
    antenna: "Antenna",
    sprout: "Sprout",
    beret: "Beret",
    cap: "Cap",
    crown: "Crown",
    bow: "Bow",
    party: "Party hat",
    headphones: "Headphones",
  },
  face: { none: "None", glasses: "Glasses", shades: "Shades", blush: "Blush" },
  neck: { none: "None", bowtie: "Bow tie", scarf: "Scarf" },
} as const satisfies {
  body: Record<CharacterBody, string>;
  eyes: Record<CharacterEyes, string>;
  mouth: Record<CharacterMouth, string>;
  top: Record<CharacterTop, string>;
  face: Record<CharacterFace, string>;
  neck: Record<CharacterNeck, string>;
};

/** Godmode's own mascot — the built-in main agent. */
export const MASCOT_CHARACTER: AgentCharacter = {
  body: "blob",
  eyes: "dots",
  mouth: "smile",
  top: "bolt",
  face: "blush",
  neck: "none",
};
export const MASCOT_COLOR = "emerald";

/* ------------------------------------------------------------------ */
/* Colours                                                              */
/* ------------------------------------------------------------------ */

/** Body fill, shade (lower half) and highlight per agent colour. Features are always drawn in ink. */
export const CHARACTER_PALETTE: Record<string, { fill: string; shade: string; light: string }> = {
  violet: { fill: "#b69cff", shade: "#9a7bf2", light: "#d7c9ff" },
  indigo: { fill: "#8f9bff", shade: "#7481f0", light: "#c3c9ff" },
  sky: { fill: "#7fcdf7", shade: "#5db6ea", light: "#bfe6fb" },
  cyan: { fill: "#6fdbe3", shade: "#4cc2cd", light: "#b6eef1" },
  emerald: { fill: "#5fdca6", shade: "#3fc48b", light: "#aeeed2" },
  lime: { fill: "#bde66a", shade: "#a1cf4a", light: "#def4b3" },
  amber: { fill: "#ffcd57", shade: "#f2b631", light: "#ffe6aa" },
  orange: { fill: "#ffa367", shade: "#f5864a", light: "#ffd1b2" },
  rose: { fill: "#ff97ad", shade: "#f47490", light: "#ffcbd6" },
  fuchsia: { fill: "#ef99f6", shade: "#de75e8", light: "#f7ccfa" },
};

const INK = "#24211d";
const BLUSH = "#ff6f8e";

export function characterPalette(color: string | undefined) {
  return CHARACTER_PALETTE[color ?? ""] ?? CHARACTER_PALETTE.violet!;
}

/* ------------------------------------------------------------------ */
/* Normalising, defaults and randomness                                 */
/* ------------------------------------------------------------------ */

function pick<T extends readonly string[]>(list: T, value: unknown, fallback: T[number]): T[number] {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T[number]) : fallback;
}

/** FNV-1a — a small, stable hash so an agent's default look never changes between launches. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choose<T>(rand: () => number, list: readonly T[], weights?: number[]): T {
  if (!weights) return list[Math.floor(rand() * list.length)]!;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i]!;
    if (r < 0) return list[i]!;
  }
  return list[list.length - 1]!;
}

/** A pleasant random character — faces favour friendly combinations; accessories are optional. */
export function randomCharacter(seed?: string): AgentCharacter {
  const rand = rng(seed === undefined ? Math.floor(Math.random() * 2 ** 32) : hash(seed));
  return {
    body: choose(rand, CHARACTER_BODIES),
    eyes: choose(rand, CHARACTER_EYES, [5, 3, 2, 2, 1, 2]),
    mouth: choose(rand, CHARACTER_MOUTHS, [5, 2, 2, 1, 1, 2]),
    top: choose(rand, CHARACTER_TOPS, [5, 0, 2, 2, 1, 1, 1, 1, 1, 2]),
    face: choose(rand, CHARACTER_FACES, [4, 1, 1, 3]),
    neck: choose(rand, CHARACTER_NECKS, [6, 1, 1]),
  };
}

/** The look an agent gets before anyone customises it — derived from its id so it is stable. */
export function defaultCharacter(seed: string): AgentCharacter {
  return randomCharacter(`gm-character:${seed}`);
}

/** Coerce anything (stored JSON, API input) into a valid character; missing or unknown parts fall back to `base`. */
export function normalizeCharacter(value: unknown, base: AgentCharacter = MASCOT_CHARACTER): AgentCharacter {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    body: pick(CHARACTER_BODIES, v.body, base.body),
    eyes: pick(CHARACTER_EYES, v.eyes, base.eyes),
    mouth: pick(CHARACTER_MOUTHS, v.mouth, base.mouth),
    top: pick(CHARACTER_TOPS, v.top, base.top),
    face: pick(CHARACTER_FACES, v.face, base.face),
    neck: pick(CHARACTER_NECKS, v.neck, base.neck),
  };
}

/** Parse a stored character (JSON text or null) — null/invalid gets the agent's stable default look. */
export function parseCharacter(raw: string | null | undefined, seed: string): AgentCharacter {
  const base = defaultCharacter(seed);
  if (!raw) return base;
  try {
    return normalizeCharacter(JSON.parse(raw), base);
  } catch {
    return base;
  }
}

/** Seconds of animation delay derived from a seed, so a crowd of characters doesn't blink in unison. */
export function characterPhase(seed: string | undefined): number {
  return seed ? (hash(seed) % 4000) / 1000 : 0;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                             */
/* ------------------------------------------------------------------ */

interface BodyGeometry {
  path: string;
  /** Centre of the eyes (y) and half the distance between them. */
  eyeY: number;
  eyeDx: number;
  mouthY: number;
  /** Top of the head at x=50 (hats sit here) and its half-width a little below the top. */
  top: number;
  topHalf: number;
  /** Half-width of the head at eye level (glasses, headphones). */
  half: number;
  /** Where a bow tie / scarf sits. */
  neckY: number;
  /** Highlight ellipse (cx, cy, rx, ry, rotate). */
  gloss: [number, number, number, number, number];
}

const BODIES: Record<CharacterBody, BodyGeometry> = {
  blob: {
    path: "M50 24C73 24 89 39 89 61C89 82 73 93 50 93C27 93 11 82 11 61C11 39 27 24 50 24Z",
    eyeY: 56,
    eyeDx: 13,
    mouthY: 67,
    top: 24,
    topHalf: 18,
    half: 38,
    neckY: 86,
    gloss: [30, 38, 7, 4.5, -35],
  },
  gumdrop: {
    path: "M50 20C57 20 61 25 66 34L87 72C93 84 86 93 73 93H27C14 93 7 84 13 72L34 34C39 25 43 20 50 20Z",
    eyeY: 64,
    eyeDx: 12,
    mouthY: 75,
    top: 20,
    topHalf: 8,
    half: 30,
    neckY: 88,
    gloss: [38, 38, 4, 7, 28],
  },
  squircle: {
    path: "M50 25C80 25 88 32 88 59C88 86 80 93 50 93C20 93 12 86 12 59C12 32 20 25 50 25Z",
    eyeY: 55,
    eyeDx: 14,
    mouthY: 67,
    top: 25,
    topHalf: 24,
    half: 38,
    neckY: 87,
    gloss: [25, 36, 6, 4, -30],
  },
  cloud: {
    path:
      "M29 93C16 93 8 85 8 74C8 64 15 57 24 56C23 43 32 33 45 33C49 25 57 21 65 23C76 25 83 35 81 46" +
      "C89 49 93 57 93 66C93 81 84 93 71 93Z",
    eyeY: 64,
    eyeDx: 13,
    mouthY: 75,
    top: 29,
    topHalf: 16,
    half: 36,
    neckY: 90,
    gloss: [36, 44, 6, 3.5, -30],
  },
  ghost: {
    path:
      "M50 20C71 20 86 35 86 56V88C86 93 81 95 77 91L72 87C69 84 65 84 62 87L58 91C55 94 51 94 50 94" +
      "C49 94 45 94 42 91L38 87C35 84 31 84 28 87L23 91C19 95 14 93 14 88V56C14 35 29 20 50 20Z",
    eyeY: 51,
    eyeDx: 13,
    mouthY: 63,
    top: 20,
    topHalf: 20,
    half: 36,
    neckY: 80,
    gloss: [29, 33, 6, 4, -40],
  },
  pebble: {
    path: "M50 36C76 36 93 47 93 65C93 84 75 93 50 93C25 93 7 84 7 65C7 47 24 36 50 36Z",
    eyeY: 62,
    eyeDx: 15,
    mouthY: 73,
    top: 36,
    topHalf: 26,
    half: 42,
    neckY: 90,
    gloss: [24, 49, 7, 3.5, -18],
  },
  drop: {
    path: "M50 15C58 30 85 47 85 67C85 84 70 94 50 94C30 94 15 84 15 67C15 47 42 30 50 15Z",
    eyeY: 64,
    eyeDx: 12,
    mouthY: 75,
    top: 15,
    topHalf: 5,
    half: 33,
    neckY: 90,
    gloss: [35, 50, 4.5, 7, 30],
  },
  kitty: {
    path:
      "M18 44L16 21C16 17 19 16 22 18L37 30C45 28 55 28 63 30L78 18C81 16 84 17 84 21L82 44" +
      "C87 51 89 58 89 64C89 83 72 93 50 93C28 93 11 83 11 64C11 58 13 51 18 44Z",
    eyeY: 60,
    eyeDx: 14,
    mouthY: 70,
    top: 29,
    topHalf: 14,
    half: 38,
    neckY: 88,
    gloss: [28, 45, 6, 3.5, -30],
  },
};

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

export interface CharacterRenderOptions {
  color?: string;
  mood?: CharacterMood;
  /** Unique prefix for ids inside the SVG (clip path). Required when several characters share a document. */
  uid?: string;
  /** Enlarge the face for tiny sizes (≤ 28px) so it still reads. Default 1. */
  faceScale?: number;
  /** Extra class names on the <svg>. */
  className?: string;
  /** Accessible label; omitted = decorative (aria-hidden). */
  title?: string;
}

const f = (n: number) => Math.round(n * 100) / 100;

/** Resolve the eyes/mouth actually drawn for a mood, keeping the character's own look where the mood allows it. */
function expression(c: AgentCharacter, mood: CharacterMood): { eyes: CharacterEyes | "x" | "closed"; mouth: CharacterMouth | "wavy" } {
  switch (mood) {
    case "happy":
      return { eyes: "happy", mouth: c.mouth === "none" ? "none" : "grin" };
    case "attention":
      return { eyes: "wide", mouth: "o" };
    case "error":
      return { eyes: "x", mouth: "wavy" };
    case "sleeping":
      return { eyes: "closed", mouth: c.mouth === "none" ? "none" : "flat" };
    case "working":
      return { eyes: c.eyes === "happy" || c.eyes === "sleepy" ? "dots" : c.eyes, mouth: c.mouth === "grin" ? "smile" : c.mouth };
    case "thinking":
      return { eyes: c.eyes === "happy" || c.eyes === "sleepy" ? "dots" : c.eyes, mouth: c.mouth === "none" ? "none" : "flat" };
    default:
      return { eyes: c.eyes, mouth: c.mouth };
  }
}

function eyeMarkup(kind: CharacterEyes | "x" | "closed", x: number, y: number, side: -1 | 1): string {
  const s = `stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"`;
  switch (kind) {
    case "dots":
      return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="4.4" ry="5.4" fill="${INK}"/><circle cx="${f(x + 1.4)}" cy="${f(y - 1.9)}" r="1.5" fill="#fff"/>`;
    case "wide":
      return (
        `<ellipse cx="${f(x)}" cy="${f(y)}" rx="5.8" ry="6.6" fill="${INK}"/>` +
        `<circle cx="${f(x + 1.9)}" cy="${f(y - 2.3)}" r="2.2" fill="#fff"/><circle cx="${f(x - 1.9)}" cy="${f(y + 2.4)}" r="1" fill="#fff"/>`
      );
    case "happy":
      return `<path d="M${f(x - 5)} ${f(y + 2)}Q${f(x)} ${f(y - 5.5)} ${f(x + 5)} ${f(y + 2)}" ${s}/>`;
    case "sleepy":
      return `<path d="M${f(x - 5)} ${f(y - 1)}Q${f(x)} ${f(y + 4.5)} ${f(x + 5)} ${f(y - 1)}" ${s}/>`;
    case "closed":
      return `<path d="M${f(x - 4.5)} ${f(y + 1)}H${f(x + 4.5)}" ${s}/>`;
    case "lines":
      return `<path d="M${f(x - 4.5)} ${f(y)}H${f(x + 4.5)}" ${s}/>`;
    case "wink":
      return side < 0 ? eyeMarkup("dots", x, y, side) : eyeMarkup("happy", x, y, side);
    case "x":
      return `<path d="M${f(x - 4)} ${f(y - 4)}L${f(x + 4)} ${f(y + 4)}M${f(x + 4)} ${f(y - 4)}L${f(x - 4)} ${f(y + 4)}" ${s}/>`;
  }
}

function mouthMarkup(kind: CharacterMouth | "wavy", x: number, y: number): string {
  const s = `stroke="${INK}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (kind) {
    case "smile":
      return `<path d="M${f(x - 4.5)} ${f(y)}Q${f(x)} ${f(y + 4.8)} ${f(x + 4.5)} ${f(y)}" ${s}/>`;
    case "grin":
      return (
        `<path d="M${f(x - 6)} ${f(y - 1)}Q${f(x)} ${f(y - 0.2)} ${f(x + 6)} ${f(y - 1)}Q${f(x + 5.5)} ${f(y + 7)} ${f(x)} ${f(y + 7)}Q${f(x - 5.5)} ${f(y + 7)} ${f(x - 6)} ${f(y - 1)}Z" fill="${INK}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>` +
        `<path d="M${f(x - 3)} ${f(y + 5.4)}Q${f(x)} ${f(y + 2.2)} ${f(x + 3)} ${f(y + 5.4)}Q${f(x)} ${f(y + 6.8)} ${f(x - 3)} ${f(y + 5.4)}Z" fill="${BLUSH}"/>`
      );
    case "cat":
      return `<path d="M${f(x - 6)} ${f(y)}Q${f(x - 3)} ${f(y + 4)} ${f(x)} ${f(y)}Q${f(x + 3)} ${f(y + 4)} ${f(x + 6)} ${f(y)}" ${s}/>`;
    case "o":
      return `<ellipse cx="${f(x)}" cy="${f(y + 1.5)}" rx="2.7" ry="3.2" fill="${INK}"/>`;
    case "flat":
      return `<path d="M${f(x - 3.5)} ${f(y + 1)}H${f(x + 3.5)}" ${s}/>`;
    case "wavy":
      return `<path d="M${f(x - 6)} ${f(y + 1.5)}Q${f(x - 3)} ${f(y - 1.5)} ${f(x)} ${f(y + 1.5)}Q${f(x + 3)} ${f(y + 4.5)} ${f(x + 6)} ${f(y + 1.5)}" ${s}/>`;
    case "none":
      return "";
  }
}

function topMarkup(kind: CharacterTop, g: BodyGeometry, shade: string): string {
  const t = g.top;
  // Parts that stick out past the body are drawn in currentColor: ink on light backgrounds, light on dark ones.
  const ink = "currentColor";
  switch (kind) {
    case "none":
      return "";
    case "bolt":
      return (
        `<path d="M50 ${t + 2}V${t - 6}" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>` +
        `<path d="M53.5 ${t - 21}L43.5 ${t - 8}H50L46.5 ${t - 0.5}L57 ${t - 13}H50.5Z" fill="#ffd23e" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>`
      );
    case "antenna":
      return (
        `<path d="M50 ${t + 2}Q48 ${t - 7} 53 ${t - 12}" stroke="${ink}" stroke-width="2.6" stroke-linecap="round" fill="none"/>` +
        `<circle cx="54" cy="${t - 14}" r="4.4" fill="#ff6f8e" stroke="${ink}" stroke-width="2"/>` +
        `<circle cx="55.3" cy="${t - 15.4}" r="1.2" fill="#fff"/>`
      );
    case "sprout":
      return (
        `<path d="M50 ${t + 2}V${t - 8}" stroke="#3a9a58" stroke-width="2.6" stroke-linecap="round"/>` +
        `<path d="M50 ${t - 7}C45 ${t - 7} 40 ${t - 11} 39 ${t - 17}C45 ${t - 17} 50 ${t - 13} 50 ${t - 7}Z" fill="#5cc97a" stroke="#3a9a58" stroke-width="1.6" stroke-linejoin="round"/>` +
        `<path d="M50 ${t - 5}C55 ${t - 5} 60 ${t - 9} 62 ${t - 15}C55 ${t - 15} 50 ${t - 11} 50 ${t - 5}Z" fill="#5cc97a" stroke="#3a9a58" stroke-width="1.6" stroke-linejoin="round"/>`
      );
    case "beret": {
      const w = Math.max(16, g.topHalf + 8);
      return (
        `<g transform="rotate(-12 50 ${t})">` +
        `<ellipse cx="50" cy="${t - 1}" rx="${w}" ry="7.5" fill="${ink}"/>` +
        `<ellipse cx="46" cy="${t - 4}" rx="${w * 0.45}" ry="2" fill="#fff" opacity=".12"/>` +
        `<path d="M50 ${t - 8}V${t - 12}" stroke="${ink}" stroke-width="3" stroke-linecap="round"/></g>`
      );
    }
    case "cap": {
      const w = Math.max(14, g.topHalf + 4);
      return (
        `<path d="M${50 - w} ${t + 5}C${50 - w} ${t - 11} ${50 + w} ${t - 11} ${50 + w} ${t + 5}Z" fill="#ff6b5e" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>` +
        `<path d="M${50 + w - 4} ${t + 4.5}C${50 + w + 8} ${t + 2} ${50 + w + 14} ${t + 4} ${50 + w + 13} ${t + 7}C${50 + w + 6} ${t + 8} ${50 + w} ${t + 7} ${50 + w - 4} ${t + 4.5}Z" fill="#ff6b5e" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>` +
        `<circle cx="50" cy="${t - 7}" r="2" fill="${ink}"/>`
      );
    }
    case "crown":
      return (
        `<path d="M39 ${t + 3}L37 ${t - 12}L44 ${t - 5}L50 ${t - 15}L56 ${t - 5}L63 ${t - 12}L61 ${t + 3}Z" fill="#ffd23e" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>` +
        `<circle cx="50" cy="${t - 3}" r="2" fill="#ff6f8e"/>`
      );
    case "bow": {
      const x = 50 + g.topHalf * 0.8 + 3;
      const y = t + 4 + (g.topHalf < 12 ? 10 : 2);
      return (
        `<g transform="rotate(18 ${x} ${y})">` +
        `<path d="M${x} ${y}L${x - 11} ${y - 7}C${x - 13} ${y - 1} ${x - 13} ${y + 3} ${x - 11} ${y + 7}Z" fill="#ff6f8e" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>` +
        `<path d="M${x} ${y}L${x + 11} ${y - 7}C${x + 13} ${y - 1} ${x + 13} ${y + 3} ${x + 11} ${y + 7}Z" fill="#ff6f8e" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>` +
        `<circle cx="${x}" cy="${y}" r="3.2" fill="#ff6f8e" stroke="${ink}" stroke-width="2"/></g>`
      );
    }
    case "party":
      return (
        `<g transform="rotate(10 50 ${t})">` +
        `<path d="M40 ${t + 3}L51 ${t - 20}L61 ${t + 3}Z" fill="#8f9bff" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>` +
        `<path d="M44.5 ${t - 6}L57 ${t - 3}M48 ${t - 13}L54 ${t - 11.5}" stroke="#ffd23e" stroke-width="2.4" stroke-linecap="round"/>` +
        `<circle cx="51" cy="${t - 21}" r="3.4" fill="#ff6f8e" stroke="${ink}" stroke-width="1.8"/></g>`
      );
    case "headphones": {
      const h = g.half + 1;
      const y = g.eyeY - 2;
      const bandTop = Math.min(t - 4, y - h * 1.05);
      return (
        `<path d="M${50 - h} ${y}C${50 - h} ${bandTop} ${50 + h} ${bandTop} ${50 + h} ${y}" stroke="${ink}" stroke-width="4" fill="none" stroke-linecap="round"/>` +
        `<rect x="${50 - h - 6}" y="${y - 9}" width="11" height="18" rx="5" fill="${ink}"/>` +
        `<rect x="${50 + h - 5}" y="${y - 9}" width="11" height="18" rx="5" fill="${ink}"/>` +
        `<rect x="${50 - h - 3.5}" y="${y - 6}" width="3" height="12" rx="1.5" fill="${shade}"/>` +
        `<rect x="${50 + h + 0.5}" y="${y - 6}" width="3" height="12" rx="1.5" fill="${shade}"/>`
      );
    }
  }
}

function faceMarkup(kind: CharacterFace, g: BodyGeometry, mood: CharacterMood): string {
  const y = g.eyeY;
  const dx = g.eyeDx;
  switch (kind) {
    case "none":
      return "";
    case "blush":
      return (
        `<ellipse cx="${f(50 - dx - 5.5)}" cy="${f(y + 8)}" rx="5" ry="3" fill="${BLUSH}" opacity=".45"/>` +
        `<ellipse cx="${f(50 + dx + 5.5)}" cy="${f(y + 8)}" rx="5" ry="3" fill="${BLUSH}" opacity=".45"/>`
      );
    case "glasses":
      return (
        `<g class="gm-glasses"><circle cx="${50 - dx}" cy="${y}" r="9" fill="#fff" fill-opacity=".28" stroke="${INK}" stroke-width="2.6"/>` +
        `<circle cx="${50 + dx}" cy="${y}" r="9" fill="#fff" fill-opacity=".28" stroke="${INK}" stroke-width="2.6"/>` +
        `<path d="M${50 - dx + 9} ${y - 1}Q50 ${y - 5} ${50 + dx - 9} ${y - 1}" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/></g>`
      );
    case "shades": {
      // Sunglasses hide the eyes; a surprised or sleepy mood peeks over the rim.
      const lift = mood === "attention" ? -3 : 0;
      return (
        `<g transform="translate(0 ${lift})">` +
        `<path d="M${50 - dx - 10} ${y - 5}H${50 - dx + 9}Q${50 - dx + 8} ${y + 7} ${50 - dx} ${y + 7}Q${50 - dx - 9} ${y + 7} ${50 - dx - 10} ${y - 5}Z" fill="${INK}"/>` +
        `<path d="M${50 + dx - 9} ${y - 5}H${50 + dx + 10}Q${50 + dx + 9} ${y + 7} ${50 + dx} ${y + 7}Q${50 + dx - 8} ${y + 7} ${50 + dx - 9} ${y - 5}Z" fill="${INK}"/>` +
        `<path d="M${50 - dx + 9} ${y - 4}H${50 + dx - 9}" stroke="${INK}" stroke-width="2.6"/>` +
        `<path d="M${50 - dx - 6} ${y - 2}L${50 - dx - 2} ${y + 3}" stroke="#fff" stroke-opacity=".5" stroke-width="1.8" stroke-linecap="round"/>` +
        `<path d="M${50 + dx - 5} ${y - 2}L${50 + dx - 1} ${y + 3}" stroke="#fff" stroke-opacity=".5" stroke-width="1.8" stroke-linecap="round"/></g>`
      );
    }
  }
}

function neckMarkup(kind: CharacterNeck, g: BodyGeometry): string {
  const y = g.neckY;
  switch (kind) {
    case "none":
      return "";
    case "bowtie":
      return (
        `<path d="M50 ${y}L40 ${y - 6}C38 ${y - 2} 38 ${y + 2} 40 ${y + 6}Z" fill="${INK}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M50 ${y}L60 ${y - 6}C62 ${y - 2} 62 ${y + 2} 60 ${y + 6}Z" fill="${INK}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<rect x="47" y="${y - 3.2}" width="6" height="6.4" rx="2" fill="${INK}" stroke="#fff" stroke-opacity=".25" stroke-width="1"/>`
      );
    case "scarf":
      return (
        `<path d="M24 ${y - 5}Q50 ${y + 4} 76 ${y - 5}L77 ${y + 2}Q50 ${y + 11} 23 ${y + 2}Z" fill="#ff6b5e" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
        `<path d="M60 ${y + 2}L63 ${y + 12}L69 ${y + 10}L66 ${y}" fill="#ff6b5e" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`
      );
  }
}

/** Where the eyes glance in a mood (static; CSS may animate over it). */
const LOOK: Partial<Record<CharacterMood, string>> = { thinking: "2.5 -3", working: "-1.5 1.5" };

function sparkle(x: number, y: number, r: number): string {
  const k = r * 0.28;
  return `<path d="M${f(x)} ${f(y - r)}L${f(x + k)} ${f(y - k)}L${f(x + r)} ${f(y)}L${f(x + k)} ${f(y + k)}L${f(x)} ${f(y + r)}L${f(x - k)} ${f(y + k)}L${f(x - r)} ${f(y)}L${f(x - k)} ${f(y - k)}Z"/>`;
}

/**
 * SVG markup for a character. Structure (for CSS animation):
 *   svg.gm-char[data-mood]
 *     g.gm-bob            — whole figure; bounces / wiggles by mood
 *       g.gm-squish       — body + face; gentle breathing
 *         g.gm-look       — eyes (translated by --gm-look-x / --gm-look-y and mood)
 *           g.gm-eyes     — blinks
 *       g.gm-z            — "z z" while sleeping
 */
export function renderCharacterSvg(character: AgentCharacter, opts: CharacterRenderOptions = {}): string {
  const c = normalizeCharacter(character);
  const g = BODIES[c.body];
  const pal = characterPalette(opts.color);
  const mood = opts.mood ?? "idle";
  const uid = (opts.uid ?? "gmc").replace(/[^\w-]/g, "");
  const scale = opts.faceScale ?? 1;
  const ex = expression(c, mood);
  const faceCx = 50;
  const faceCy = (g.eyeY + g.mouthY) / 2;
  const faceTf = scale === 1 ? "" : ` transform="translate(${f(faceCx)} ${f(faceCy)}) scale(${scale}) translate(${f(-faceCx)} ${f(-faceCy)})"`;
  const [gx, gy, grx, gry, grot] = g.gloss;

  const eyes = eyeMarkup(ex.eyes, 50 - g.eyeDx, g.eyeY, -1) + eyeMarkup(ex.eyes, 50 + g.eyeDx, g.eyeY, 1);
  const hideEyes = c.face === "shades" && mood !== "attention";
  const label = opts.title ? `<title>${opts.title.replace(/[<&>"]/g, "")}</title>` : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="gm-char${opts.className ? ` ${opts.className}` : ""}" data-mood="${mood}"` +
    (opts.title ? ` role="img" aria-label="${opts.title.replace(/[<&>"]/g, "")}"` : ` aria-hidden="true"`) +
    ` overflow="visible">${label}` +
    `<defs><clipPath id="${uid}-clip"><path d="${g.path}"/></clipPath></defs>` +
    `<g class="gm-bob"><g class="gm-squish">` +
    `<path d="${g.path}" fill="${pal.fill}" stroke="${pal.fill}" stroke-width="4" stroke-linejoin="round"/>` +
    `<g clip-path="url(#${uid}-clip)"><ellipse cx="50" cy="${g.neckY + 26}" rx="62" ry="30" fill="${pal.shade}"/></g>` +
    `<ellipse cx="${gx}" cy="${gy}" rx="${grx}" ry="${gry}" transform="rotate(${grot} ${gx} ${gy})" fill="#fff" opacity=".55"/>` +
    neckMarkup(c.neck, g) +
    `<g class="gm-face"${faceTf}>` +
    (c.face === "blush" ? faceMarkup("blush", g, mood) : "") +
    (hideEyes ? "" : `<g class="gm-look"${LOOK[mood] ? ` transform="translate(${LOOK[mood]})"` : ""}><g class="gm-eyes">${eyes}</g></g>`) +
    mouthMarkup(ex.mouth, 50, g.mouthY) +
    (c.face === "glasses" || c.face === "shades" ? faceMarkup(c.face, g, mood) : "") +
    `</g>` +
    topMarkup(c.top, g, pal.shade) +
    `</g>` +
    (mood === "attention"
      ? `<g class="gm-fx"><path d="M88 ${g.top - 4}L86.6 ${g.top + 9}" stroke="#f5a524" stroke-width="4.4" stroke-linecap="round"/><circle cx="86" cy="${g.top + 15.5}" r="2.4" fill="#f5a524"/></g>`
      : "") +
    (mood === "happy"
      ? `<g class="gm-fx" fill="#ffd23e" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">${sparkle(86, g.top + 4, 6)}${sparkle(13, g.top + 12, 4.5)}</g>`
      : "") +
    (mood === "sleeping"
      ? `<g class="gm-z" fill="currentColor" font-family="ui-rounded,system-ui,sans-serif" font-weight="700"><text x="76" y="${g.top + 2}" font-size="13">z</text><text x="86" y="${g.top - 8}" font-size="9">z</text></g>`
      : "") +
    `</g></svg>`
  );
}

/* ------------------------------------------------------------------ */
/* Personality                                                          */
/* ------------------------------------------------------------------ */

export interface PersonalityPreset {
  id: string;
  label: string;
  /** One line for pickers. */
  blurb: string;
  /** How the agent should sound — written into its CLAUDE.md. */
  prompt: string;
  /** First words in a new chat. `{name}` = the agent, `{human}` = the human's first name (dropped with its comma when unknown). */
  greetings: string[];
}

export const PERSONALITY_PRESETS: PersonalityPreset[] = [
  {
    id: "buddy",
    label: "Buddy",
    blurb: "Friendly, confident, a little playful",
    prompt:
      "Friendly, confident and a little playful — a capable coworker, not a corporate assistant. Warm but brief; " +
      "you enjoy the work, celebrate finished jobs in a sentence, and admit plainly when something went wrong.",
    greetings: [
      "Hey {human}! {name} here. What can I take off your plate?",
      "Hi {human} — ready when you are. What are we getting done?",
      "{name} reporting for duty. What's first, {human}?",
    ],
  },
  {
    id: "sunny",
    label: "Sunny",
    blurb: "Upbeat, encouraging, celebrates wins",
    prompt:
      "Upbeat and encouraging. You bring good energy, notice progress and celebrate wins, and keep bad news " +
      "constructive with a clear next step. A friendly exclamation mark is fine; forced cheer is not.",
    greetings: ["Hi {human}! I'm {name} ☀️ What should we tackle today?", "Good to see you, {human}! What's on the list?"],
  },
  {
    id: "calm",
    label: "Calm",
    blurb: "Steady, precise, reassuring",
    prompt:
      "Calm, steady and precise. You never rush or hype; you explain what you did and what you found in clear, " +
      "measured sentences, and you make even messy situations feel under control.",
    greetings: ["Hello {human}. I'm {name}. What would you like me to handle?", "I'm here, {human}. Take your time — what do you need?"],
  },
  {
    id: "witty",
    label: "Witty",
    blurb: "Dry humour, sharp, never in the way",
    prompt:
      "Sharp with a dry sense of humour: the occasional wry aside, never at the expense of clarity or the human. " +
      "Jokes are seasoning, not the meal — results always come first.",
    greetings: ["{name} here. I've alphabetised my thoughts. What do you need, {human}?", "Hey {human}. Hand me the boring stuff — I'll make it look easy."],
  },
  {
    id: "straight",
    label: "Straight shooter",
    blurb: "Bottom line first, no fluff",
    prompt:
      "Direct and to the point: bottom line first, then only the details that matter. No pleasantries, no filler, " +
      "no hedging — but never rude.",
    greetings: ["{name}. What's the task?", "Ready, {human}. What needs doing?"],
  },
  {
    id: "curious",
    label: "Curious",
    blurb: "Digs deep, asks sharp questions",
    prompt:
      "Genuinely curious. You dig beyond the obvious, ask one sharp question when it changes the outcome, and share " +
      "the interesting thing you found along the way (briefly).",
    greetings: ["Hi {human}, I'm {name}. What are we figuring out today?", "Ooh, a new day of puzzles. What's on your mind, {human}?"],
  },
  {
    id: "butler",
    label: "Butler",
    blurb: "Polished, courteous, quietly brilliant",
    prompt:
      "Polished and courteous with a touch of old-fashioned formality — a discreet, unflappable butler who " +
      "anticipates needs and reports back impeccably.",
    greetings: ["Good day, {human}. {name}, at your service. How may I assist?", "At your service, {human}. What shall I attend to?"],
  },
  {
    id: "hype",
    label: "Hype",
    blurb: "High energy, big momentum",
    prompt:
      "High energy and all momentum: you love shipping, keep things moving fast and make progress feel exciting — " +
      "while staying accurate and never overselling results.",
    greetings: ["LET'S GO, {human}! {name} is warmed up. What are we shipping?", "{name} online and fired up. Point me at something, {human}!"],
  },
];

export function personalityPreset(id: string | null | undefined): PersonalityPreset | undefined {
  return PERSONALITY_PRESETS.find((p) => p.id === id);
}

/** The tone text for an agent's CLAUDE.md: a preset's prompt, custom text as written, or "" for none. */
export function personalityPrompt(personality: string | null | undefined): string {
  const p = (personality ?? "").trim();
  if (!p) return "";
  return personalityPreset(p)?.prompt ?? p;
}

/** A greeting line in the agent's voice (deterministic per `seed`, e.g. the conversation id). */
export function characterGreeting(opts: { name: string; personality?: string | null; human?: string | null; seed?: string }): string {
  const preset = personalityPreset(opts.personality) ?? PERSONALITY_PRESETS[0]!;
  const lines = preset.greetings;
  const line = lines[opts.seed ? hash(opts.seed) % lines.length : 0]!;
  const human = (opts.human ?? "").trim().split(/\s+/)[0];
  const text = human ? line.replaceAll("{human}", human) : line.replace(/,? ?\{human\}/g, "");
  return text.replaceAll("{name}", opts.name);
}
