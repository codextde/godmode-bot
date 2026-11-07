import * as SecureStore from "expo-secure-store";
import { request } from "./api";

/**
 * The vault's password generator, like the desktop's (length, numbers, symbols; no look-alike characters). The phone has
 * no secure random source of its own, so the computer makes the password; nothing is stored until the login is saved.
 */
export interface GeneratorOptions {
  length: number;
  numbers: boolean;
  symbols: boolean;
}

export const DEFAULT_GENERATOR: GeneratorOptions = { length: 20, numbers: true, symbols: true };
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 64;

const KEY = "godmode.passwordGenerator";

export const generatePassword = (opts: GeneratorOptions) => request<{ password: string }>("POST", "/api/vault/generate-password", opts).then((r) => r.password);

export async function loadGeneratorOptions(): Promise<GeneratorOptions> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return DEFAULT_GENERATOR;
    const saved = JSON.parse(raw) as Partial<GeneratorOptions>;
    const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(Number(saved.length) || DEFAULT_GENERATOR.length)));
    return { length, numbers: saved.numbers !== false, symbols: saved.symbols !== false };
  } catch {
    return DEFAULT_GENERATOR;
  }
}

export function saveGeneratorOptions(opts: GeneratorOptions) {
  void SecureStore.setItemAsync(KEY, JSON.stringify(opts)).catch(() => undefined);
}

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

const COMMON = new Set([
  "password", "passw0rd", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwertz", "azerty", "letmein",
  "welcome", "admin", "iloveyou", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master",
  "shadow", "superman", "trustno1", "abc123", "111111", "000000", "login", "secret", "changeme", "godmode",
  "hallo", "passwort", "geheim", "test", "guest", "root", "starwars", "whatever", "freedom", "hello",
]);

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

/** Characters in runs (aaa), sequences (abc, 321) or keyboard walks (qwer). */
function patternChars(pw: string): number {
  const lower = pw.toLowerCase();
  const flagged: boolean[] = new Array(lower.length).fill(false);
  for (let i = 0; i < lower.length; ) {
    let j = i + 1;
    while (j < lower.length && lower[j] === lower[i]) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) flagged[k] = true;
    i = j;
  }
  for (let i = 0; i + 2 < lower.length; i++) {
    const d = lower.charCodeAt(i + 1) - lower.charCodeAt(i);
    if ((d === 1 || d === -1) && lower.charCodeAt(i + 2) - lower.charCodeAt(i + 1) === d) flagged[i] = flagged[i + 1] = flagged[i + 2] = true;
  }
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

/** How hard a password is to guess, 0 (too weak) to 4 (excellent): the desktop's estimate, without its hints. */
export function passwordStrength(pw: string, userInputs: string[] = []): StrengthScore {
  if (!pw) return 0;
  const lower = pw.toLowerCase();
  const perChar = Math.log2(poolSize(pw));
  const patterned = patternChars(pw);
  let bits = (pw.length - patterned) * perChar + patterned;
  if (new Set(pw).size <= Math.ceil(pw.length / 3)) bits *= 0.6;
  const stripped = lower.replace(/[^a-z]/g, "");
  const deLeet = lower.replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/\$/g, "s").replace(/@/g, "a");
  if (COMMON.has(lower) || COMMON.has(deLeet) || COMMON.has(stripped)) bits = Math.min(bits, 8);
  else {
    for (const word of COMMON) {
      if (word.length >= 5 && (lower.includes(word) || deLeet.includes(word))) {
        bits -= word.length * perChar * 0.8;
        break;
      }
    }
  }
  for (const input of userInputs) {
    const v = input.trim().toLowerCase();
    if (v.length >= 3 && lower.includes(v)) {
      bits -= v.length * perChar * 0.8;
      break;
    }
  }
  if (/(19|20)\d{2}/.test(pw)) bits -= 6;
  bits = Math.max(0, bits);
  return bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
}
