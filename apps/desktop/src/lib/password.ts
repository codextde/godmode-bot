/**
 * Password generation + a lightweight zxcvbn-style strength estimate.
 *
 * The estimator is intentionally small (no dictionaries beyond a short list of very common passwords):
 * it computes a character-pool entropy and then penalizes the patterns attackers try first —
 * repeats, sequences, keyboard walks, years/dates, common words and low variety.
 */

export interface GeneratorOptions {
  length: number;
  numbers: boolean;
  symbols: boolean;
  uppercase?: boolean;
  /** Skip look-alike characters (Il1O0) */
  avoidAmbiguous?: boolean;
}

export const DEFAULT_GENERATOR: GeneratorOptions = { length: 20, numbers: true, symbols: true, uppercase: true, avoidAmbiguous: true };

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/~";
const AMBIGUOUS = /[Il1O0o]/g;

function randomInt(max: number): number {
  // Rejection sampling for an unbiased index
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

export function generatePassword(opts: Partial<GeneratorOptions> = {}): string {
  const o = { ...DEFAULT_GENERATOR, ...opts };
  const strip = (s: string) => (o.avoidAmbiguous ? s.replace(AMBIGUOUS, "") : s);
  const sets = [strip(LOWER)];
  if (o.uppercase !== false) sets.push(strip(UPPER));
  if (o.numbers) sets.push(strip(DIGITS));
  if (o.symbols) sets.push(SYMBOLS);
  const all = sets.join("");
  const length = Math.max(Math.max(4, sets.length), Math.min(128, Math.round(o.length)));
  // Guarantee at least one char of every enabled set, then fill and shuffle.
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface StrengthResult {
  score: StrengthScore;
  label: "Too weak" | "Weak" | "Fair" | "Strong" | "Excellent";
  /** Estimated entropy in bits after pattern penalties */
  bits: number;
  /** Human readable offline crack time estimate (1e10 guesses/s) */
  crackTime: string;
  /** Short, actionable hints */
  feedback: string[];
}

const COMMON = new Set(
  [
    "password", "passw0rd", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwertz", "azerty", "letmein",
    "welcome", "admin", "iloveyou", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master",
    "shadow", "superman", "trustno1", "abc123", "111111", "000000", "login", "secret", "changeme", "godmode",
    "hallo", "passwort", "geheim", "test", "guest", "root", "starwars", "whatever", "freedom", "hello",
  ].map((s) => s.toLowerCase()),
);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "qwertzuiop", "yxcvbnm", "azertyuiop", "1234567890"];

function poolSize(pw: string): number {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  if (/[^\x00-\x7F]/.test(pw)) pool += 40;
  return Math.max(pool, 1);
}

/** Count characters that are part of runs (aaa), sequences (abc, 321) or keyboard walks (qwer). */
function patternChars(pw: string): number {
  const lower = pw.toLowerCase();
  const flagged = new Array(lower.length).fill(false);
  // Repeats of 3+
  for (let i = 0; i < lower.length; ) {
    let j = i + 1;
    while (j < lower.length && lower[j] === lower[i]) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) flagged[k] = true;
    i = j;
  }
  // Ascending/descending sequences of 3+
  for (let i = 0; i + 2 < lower.length; i++) {
    const a = lower.charCodeAt(i);
    const b = lower.charCodeAt(i + 1);
    const c = lower.charCodeAt(i + 2);
    const d1 = b - a;
    if ((d1 === 1 || d1 === -1) && c - b === d1) flagged[i] = flagged[i + 1] = flagged[i + 2] = true;
  }
  // Keyboard walks of 4+
  for (const row of KEYBOARD_ROWS) {
    for (let len = 4; len <= row.length; len++) {
      for (let s = 0; s + len <= row.length; s++) {
        const walk = row.slice(s, s + len);
        for (const w of [walk, [...walk].reverse().join("")]) {
          let idx = lower.indexOf(w);
          while (idx !== -1) {
            for (let k = idx; k < idx + w.length; k++) flagged[k] = true;
            idx = lower.indexOf(w, idx + 1);
          }
        }
      }
    }
  }
  return flagged.filter(Boolean).length;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds > 3.15e7 * 1e6) return "centuries";
  if (seconds < 1) return "instantly";
  const units: [number, string][] = [
    [3.15e7 * 100, "century"],
    [3.15e7, "year"],
    [2.6e6, "month"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.round(seconds / size);
      return `${n} ${name === "century" ? (n === 1 ? "century" : "centuries") : n === 1 ? name : `${name}s`}`;
    }
  }
  return "instantly";
}

export function estimateStrength(pw: string, userInputs: string[] = []): StrengthResult {
  const feedback: string[] = [];
  if (!pw) return { score: 0, label: "Too weak", bits: 0, crackTime: "instantly", feedback: [] };

  const lower = pw.toLowerCase();
  const unique = new Set(pw).size;
  const pool = poolSize(pw);
  // Characters in obvious patterns count as ~1 bit instead of log2(pool)
  const patterned = patternChars(pw);
  const perChar = Math.log2(pool);
  let bits = (pw.length - patterned) * perChar + patterned * 1;
  // Low variety penalty (e.g. "abababab")
  if (unique <= Math.ceil(pw.length / 3)) {
    bits *= 0.6;
    feedback.push("Use more different characters.");
  }

  const stripped = lower.replace(/[^a-z]/g, "");
  const deLeet = lower.replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/\$/g, "s").replace(/@/g, "a");
  if (COMMON.has(lower) || COMMON.has(deLeet) || COMMON.has(stripped)) {
    bits = Math.min(bits, 8);
    feedback.push("This is one of the most common passwords.");
  } else {
    for (const word of COMMON) {
      if (word.length >= 5 && (lower.includes(word) || deLeet.includes(word))) {
        bits -= word.length * perChar * 0.8;
        feedback.push(`Avoid common words like “${word}”.`);
        break;
      }
    }
  }
  for (const input of userInputs) {
    const v = input.trim().toLowerCase();
    if (v.length >= 3 && lower.includes(v)) {
      bits -= v.length * perChar * 0.8;
      feedback.push("Don't include your name or the site name.");
      break;
    }
  }
  if (/(19|20)\d{2}/.test(pw)) {
    bits -= 6;
    feedback.push("Years and dates are easy to guess.");
  }
  if (patterned >= 3) feedback.push("Avoid sequences, repeats and keyboard patterns.");
  if (pw.length < 12) feedback.push("Use at least 12 characters — length matters most.");
  if (pool <= 26 && pw.length < 16) feedback.push("Mix in numbers, symbols or uppercase letters.");

  bits = Math.max(0, bits);
  const score: StrengthScore = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  const labels = ["Too weak", "Weak", "Fair", "Strong", "Excellent"] as const;
  const seconds = 2 ** bits / 2 / 1e10;
  return { score, label: labels[score], bits: Math.round(bits), crackTime: formatDuration(seconds), feedback: Array.from(new Set(feedback)).slice(0, 3) };
}
