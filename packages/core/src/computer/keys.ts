/**
 * Key names for computer use. The model writes keys the way it learned them — xdotool keysyms ("Return",
 * "Page_Down", "ctrl+shift+t"), browser names ("ArrowLeft", "Enter"), Mac symbols ("cmd+⇧+4") — and every engine
 * needs one canonical form: modifiers `cmd | ctrl | alt | shift | fn` plus a named key or a single character.
 */

export type Modifier = "cmd" | "ctrl" | "alt" | "shift" | "fn";

export interface KeyCombo {
  /** Named key ("enter", "left", "f5", …) or a single character ("a", "A", "1", "/"). */
  key: string;
  modifiers: Modifier[];
}

export const NAMED_KEYS = new Set([
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "escape",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "capslock",
  "kpenter",
  "volumeup",
  "volumedown",
  "mute",
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
]);

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  win: "cmd",
  windows: "cmd",
  "⌘": "cmd",
  meta_l: "cmd",
  meta_r: "cmd",
  super_l: "cmd",
  super_r: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  "^": "ctrl",
  "⌃": "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  "⌥": "alt",
  alt_l: "alt",
  alt_r: "alt",
  shift: "shift",
  "⇧": "shift",
  shift_l: "shift",
  shift_r: "shift",
  fn: "fn",
};

const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  ret: "enter",
  cr: "enter",
  kp_enter: "kpenter",
  numpadenter: "kpenter",
  esc: "escape",
  back_space: "backspace",
  bksp: "backspace",
  bs: "backspace",
  del: "delete",
  forwarddelete: "delete",
  forward_delete: "delete",
  arrowleft: "left",
  leftarrow: "left",
  left_arrow: "left",
  arrowright: "right",
  rightarrow: "right",
  right_arrow: "right",
  arrowup: "up",
  uparrow: "up",
  up_arrow: "up",
  arrowdown: "down",
  downarrow: "down",
  down_arrow: "down",
  pgup: "pageup",
  page_up: "pageup",
  prior: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  page_down: "pagedown",
  next: "pagedown",
  spacebar: "space",
  ins: "insert",
  caps_lock: "capslock",
  caps: "capslock",
  audiovolumeup: "volumeup",
  xf86audioraisevolume: "volumeup",
  audiovolumedown: "volumedown",
  xf86audiolowervolume: "volumedown",
  audiovolumemute: "mute",
  xf86audiomute: "mute",
};

/** Named punctuation (xdotool keysyms and spelled-out names) → the character. */
const CHAR_ALIASES: Record<string, string> = {
  plus: "+",
  minus: "-",
  comma: ",",
  period: ".",
  dot: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  colon: ":",
  apostrophe: "'",
  quote: "'",
  quotedbl: '"',
  grave: "`",
  backtick: "`",
  bracketleft: "[",
  bracketright: "]",
  braceleft: "{",
  braceright: "}",
  parenleft: "(",
  parenright: ")",
  equal: "=",
  equals: "=",
  underscore: "_",
  asterisk: "*",
  ampersand: "&",
  at: "@",
  numbersign: "#",
  hash: "#",
  dollar: "$",
  percent: "%",
  exclam: "!",
  question: "?",
  less: "<",
  greater: ">",
  bar: "|",
  asciitilde: "~",
  asciicircum: "^",
};

export class KeyError extends Error {}

export function normalizeModifier(name: string): Modifier | null {
  return MODIFIER_ALIASES[name.trim().toLowerCase()] ?? null;
}

/** One key name → canonical key (named key or single character). Throws KeyError. */
export function normalizeKey(name: string): string {
  if (name === " ") return "space";
  const raw = name.trim();
  if (!raw) throw new KeyError("Empty key name");
  if ([...raw].length === 1) return raw;
  const lower = raw.toLowerCase();
  if (NAMED_KEYS.has(lower)) return lower;
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]!;
  if (CHAR_ALIASES[lower]) return CHAR_ALIASES[lower]!;
  // "KP_1", "Numpad1" → "1"
  const numpad = /^(?:kp_|numpad)(\d)$/.exec(lower);
  if (numpad) return numpad[1]!;
  // "Key_A" / "KeyA" (browser code names), "Digit1"
  const code = /^key_?([a-z])$/.exec(lower) ?? /^digit(\d)$/.exec(lower);
  if (code) return code[1]!;
  throw new KeyError(`Unknown key "${raw}"`);
}

/** "cmd+shift+t" / "ctrl+Return" / "cmd++" / "F5" → canonical combo. Throws KeyError. */
export function parseKeyCombo(input: string): KeyCombo {
  const text = input.trim();
  if (!text) throw new KeyError("Empty key combination");
  let parts: string[];
  if (text === "+") parts = ["+"];
  else if (text.endsWith("++")) parts = [...text.slice(0, -2).split("+"), "+"];
  else parts = text.split("+");
  if (parts.some((p) => p.trim() === "")) throw new KeyError(`Invalid key combination "${input}"`);

  const modifiers: Modifier[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const mod = normalizeModifier(part);
    if (mod && !keys.length) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
    } else keys.push(part);
  }
  // A lone modifier ("shift") is pressed as a key.
  if (!keys.length) {
    const last = modifiers.pop()!;
    return { key: last, modifiers };
  }
  if (keys.length > 1) throw new KeyError(`"${input}" has more than one non-modifier key — send them one after another`);
  return { key: normalizeKey(keys[0]!), modifiers };
}

/** "ctrl+a Delete" (space-separated, like xdotool) → combos pressed one after another. */
export function parseKeySequence(input: string): KeyCombo[] {
  const text = input.trim();
  if (!text) throw new KeyError("No keys given");
  if (text === " ") return [{ key: "space", modifiers: [] }];
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map(parseKeyCombo);
}

export function formatKeyCombo(combo: KeyCombo): string {
  return [...combo.modifiers, combo.key].join("+");
}
