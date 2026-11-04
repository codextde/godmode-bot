/**
 * The owner's phone PIN: what proves a caller is the owner, from any phone. The voice never knows it. It sits hashed in
 * the vault and Godmode checks what the caller said against it after the call, so nobody can talk it out of the voice,
 * and the voice can't be talked into saying it was right.
 */
import type { CallTurn, OwnerPinStatus } from "@godmode/shared";
import { OWNER_PIN_LENGTH, isWeakOwnerPin, toE164 } from "@godmode/shared";
import { deleteMeta, getMeta, setMeta } from "../db";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import { badRequest } from "../util";
import { hashPassword, verifyPassword } from "../vault/crypto";
import * as vault from "../vault/vault";

/** Has a dot, so the vault's secrets routes can neither set nor delete it. */
export const OWNER_PIN_SECRET = "calls.owner_pin";
const META_FAILS = "calls.pinFails";
const META_LAST_FAIL = "calls.pinLastFail";
const META_LOCKED = "calls.pinLockedUntil";
/** Only this many different numbers count per call, so reading out a list on one call gets nowhere. */
const TRIES_PER_CALL = 3;
/** This many wrong tries in a row lock the PIN: one hour first, doubling up to a day. */
const TRIES_PER_LOCK = 5;
const MAX_LOCK_HOURS = 24;
/** How many digits of stray number words a run may have around the PIN. */
const STRAY_DIGITS = 2;
/** Wrong tries are forgotten after this long without one. */
const FORGET_MS = 7 * 86_400_000;
/** Fewer digits say nothing about the PIN; more may be a part of it. */
const MIN_MASKED = 3;
const MASK = "••••••";

export function pinRequired(): boolean {
  return vault.hasAppSecret(OWNER_PIN_SECRET);
}

function lockedUntil(): string | null {
  const until = getMeta(META_LOCKED);
  return until && Date.parse(until) > Date.now() ? until : null;
}

export function ownerPinStatus(): OwnerPinStatus {
  return { set: pinRequired(), lockedUntil: lockedUntil() };
}

function clearFails() {
  deleteMeta(META_FAILS);
  deleteMeta(META_LAST_FAIL);
  deleteMeta(META_LOCKED);
}

export function setOwnerPin(pin: string): void {
  if (!new RegExp(`^\\d{${OWNER_PIN_LENGTH}}$`).test(pin)) throw badRequest(`The PIN has ${OWNER_PIN_LENGTH} digits`);
  if (isWeakOwnerPin(pin) || toE164(getSettings().phone.ownerNumber)?.endsWith(pin)) throw badRequest("That PIN is too easy to guess. Pick another one.");
  vault.setAppSecret(OWNER_PIN_SECRET, hashPassword(pin));
  clearFails();
  audit("user", "calls.pin_set", "owner");
}

export function removeOwnerPin(): void {
  vault.setAppSecret(OWNER_PIN_SECRET, null);
  clearFails();
  audit("user", "calls.pin_remove", "owner");
}

/* ------------------------------------------------------------------ */
/* Numbers in what was said                                            */
/* ------------------------------------------------------------------ */

const UNITS: Record<string, string> = {
  null: "0", zero: "0", oh: "0",
  eins: "1", one: "1",
  zwei: "2", zwo: "2", two: "2",
  drei: "3", three: "3",
  vier: "4", four: "4",
  fünf: "5", fuenf: "5", five: "5",
  sechs: "6", six: "6",
  sieben: "7", seven: "7",
  acht: "8", eight: "8",
  neun: "9", nine: "9",
};
const TEENS: Record<string, string> = {
  zehn: "10", ten: "10",
  elf: "11", eleven: "11",
  zwölf: "12", zwoelf: "12", twelve: "12",
  dreizehn: "13", thirteen: "13",
  vierzehn: "14", fourteen: "14",
  fünfzehn: "15", fuenfzehn: "15", fifteen: "15",
  sechzehn: "16", sixteen: "16",
  siebzehn: "17", seventeen: "17",
  achtzehn: "18", eighteen: "18",
  neunzehn: "19", nineteen: "19",
};
const TENS: Record<string, string> = {
  zwanzig: "2", twenty: "2",
  dreißig: "3", dreissig: "3", thirty: "3",
  vierzig: "4", forty: "4",
  fünfzig: "5", fuenfzig: "5", fifty: "5",
  sechzig: "6", sixty: "6",
  siebzig: "7", seventy: "7",
  achtzig: "8", eighty: "8",
  neunzig: "9", ninety: "9",
};

/** Words people say in the middle of a number. */
const FILLERS = new Set(["äh", "ähm", "öh", "hm", "hmm", "mhm", "uh", "um", "er", "erm"]);

const known = (table: Record<string, string>, word: string): string | undefined => (Object.hasOwn(table, word) ? table[word] : undefined);
const clean = (raw: string) => raw.normalize("NFC").toLowerCase();

function wordDigits(raw: string): string | null {
  const word = clean(raw);
  if (/^\d+$/.test(word)) return word;
  const plain = known(UNITS, word) ?? known(TEENS, word);
  if (plain) return plain;
  const tens = known(TENS, word);
  if (tens) return `${tens}0`;
  const compound = /^(.+)und(.+)$/.exec(word);
  if (compound) {
    const unit = compound[1] === "ein" ? "1" : known(UNITS, compound[1]!);
    const ten = known(TENS, compound[2]!);
    if (unit && ten) return `${ten}${unit}`;
  }
  const hundreds = /^(.*)hundert(?:und)?(.*)$/.exec(word);
  if (hundreds) {
    const unit = !hundreds[1] || hundreds[1] === "ein" ? "1" : known(UNITS, hundreds[1]);
    const rest = hundreds[2] ? wordDigits(hundreds[2]) : "00";
    if (unit && rest && rest.length <= 2) return `${unit}${rest.padStart(2, "0")}`;
  }
  return null;
}

interface SpokenNumber {
  digits: string;
  start: number;
  end: number;
}

/** "thirty four" is one number and "3 4" are two, so what was said in a row is kept number by number. */
function spokenRuns(text: string): SpokenNumber[][] {
  const runs: SpokenNumber[][] = [];
  let run: SpokenNumber[] | null = null;
  /** Trailing zeros of the number before that a following word fills: "thirty" + "four". */
  let open = 0;
  /** Where the last filler word ended: the number goes on after it. */
  let filled = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    const word = clean(m[0]);
    const last = run?.at(-1);
    const adjacent = !!last && /^[\s,.…;:\-–—/]*$/.test(text.slice(Math.max(last.end, filled), start));
    if (word === "hundred" && last && adjacent && last.digits.length === 1 && last.digits !== "0") {
      last.digits += "00";
      last.end = end;
      open = 2;
      continue;
    }
    if (last && (FILLERS.has(word) || (open && (word === "and" || word === "und")))) {
      if (adjacent) {
        filled = end;
        continue;
      }
    }
    const digits = wordDigits(m[0]);
    if (digits === null) {
      run = null;
      open = 0;
      continue;
    }
    const isWord = !/^\d/.test(word);
    if (last && adjacent && isWord && open && digits.length <= open && !/^0+$/.test(digits)) {
      last.digits = `${last.digits.slice(0, -digits.length)}${digits}`;
      last.end = end;
      open = known(TENS, word) ? 1 : 0;
      continue;
    }
    const number = { digits, start, end };
    if (run && adjacent) run.push(number);
    else runs.push((run = [number]));
    open = known(TENS, word) ? 1 : 0;
  }
  return runs;
}

const sumDigits = (numbers: SpokenNumber[]) => numbers.map((n) => n.digits).join("");
const span = (numbers: SpokenNumber[]): SpokenNumber => ({ digits: sumDigits(numbers), start: numbers[0]!.start, end: numbers.at(-1)!.end });

/**
 * Everything said that could be meant as the PIN: a whole run of its length, a number of its length on its own, or a run
 * with a stray number word before or after it ("482915. One more thing"). Longer runs are phone numbers, and a long list
 * of digits can't hide the PIN: every number here counts as a try.
 */
export function spokenPins(text: string): SpokenNumber[] {
  const out: SpokenNumber[] = [];
  const add = (n: SpokenNumber) => {
    if (!out.some((o) => o.start === n.start && o.end === n.end)) out.push(n);
  };
  for (const run of spokenRuns(text)) {
    const total = sumDigits(run).length;
    if (total === OWNER_PIN_LENGTH) {
      add(span(run));
      continue;
    }
    for (const n of run) if (n.digits.length === OWNER_PIN_LENGTH) add(n);
    if (total <= OWNER_PIN_LENGTH || total > OWNER_PIN_LENGTH + STRAY_DIGITS) continue;
    for (const part of [...run.map((_, i) => run.slice(0, i + 1)), ...run.map((_, i) => run.slice(i + 1))]) {
      if (part.length && sumDigits(part).length === OWNER_PIN_LENGTH) add(span(part));
    }
  }
  return out;
}

/** A pause can split the PIN over two turns, with no voice turn or only a "Mhm" in between: they are one. */
export function joinCallerTurns(turns: CallTurn[]): CallTurn[] {
  const out: CallTurn[] = [];
  turns.forEach((t, i) => {
    const last = out.at(-1);
    if (last?.speaker !== "other") {
      out.push({ ...t });
      return;
    }
    if (t.speaker === "other") last.text = `${last.text} ${t.text}`;
    else if (turns[i + 1]?.speaker !== "other" || t.text.trim().split(/\s+/).length > 2) out.push({ ...t });
  });
  return out;
}

/** What to mask: the PIN and parts of it once it is known, every number that could be part of it until then, or nothing. */
export type PinMask = { pin: string } | "all" | null;

function hides(digits: string, mask: Exclude<PinMask, null>): boolean {
  if (mask === "all") return digits.length >= MIN_MASKED;
  return digits.includes(mask.pin) || (digits.length >= MIN_MASKED && mask.pin.includes(digits));
}

export function maskPin(text: string, mask: PinMask): string {
  if (!mask) return text;
  let out = text;
  for (const r of spokenRuns(text).map(span).reverse()) {
    if (hides(r.digits, mask)) out = `${out.slice(0, r.start)}${MASK}${out.slice(r.end)}`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Checking a finished call                                            */
/* ------------------------------------------------------------------ */

export interface PinCheck {
  verified: boolean;
  /** Wrong numbers tried on this call. */
  wrong: number;
  /** This call's wrong tries locked the PIN. */
  lockedNow: boolean;
  mask: PinMask;
  /** The real PIN is, or may be, in the provider's copy of the call. */
  purge: boolean;
}

function noteWrong(): boolean {
  const forgotten = Date.now() - Number(getMeta(META_LAST_FAIL) ?? 0) > FORGET_MS;
  const fails = (forgotten ? 0 : Number(getMeta(META_FAILS) ?? 0)) + 1;
  setMeta(META_FAILS, String(fails));
  setMeta(META_LAST_FAIL, String(Date.now()));
  if (fails % TRIES_PER_LOCK !== 0) return false;
  const hours = Math.min(2 ** (fails / TRIES_PER_LOCK - 1), MAX_LOCK_HOURS);
  setMeta(META_LOCKED, new Date(Date.now() + hours * 3_600_000).toISOString());
  return true;
}

/** Only the caller's own turns count, never the voice's. A wrong try may be a near miss, so unless the PIN was right everything that could be part of it is masked. */
export function checkSpokenPin(turns: CallTurn[]): PinCheck {
  const stored = vault.getAppSecret(OWNER_PIN_SECRET);
  if (!stored) return { verified: false, wrong: 0, lockedNow: false, mask: null, purge: false };
  const heard = turns.filter((t) => t.speaker === "other");
  const pieces = heard.flatMap((t) => spokenRuns(t.text)).map(sumDigits).join("");
  const said = [...new Set([...heard.flatMap((t) => spokenPins(t.text).map((r) => r.digits)), ...(pieces.length === OWNER_PIN_LENGTH ? [pieces] : [])])];
  let wrong = 0;
  let lockedNow = false;
  for (const digits of said.slice(0, TRIES_PER_CALL)) {
    if (lockedUntil()) break;
    if (verifyPassword(digits, stored)) {
      clearFails();
      return { verified: true, wrong: 0, lockedNow: false, mask: { pin: digits }, purge: true };
    }
    wrong++;
    lockedNow = noteWrong() || lockedNow;
  }
  return { verified: false, wrong, lockedNow, mask: said.length ? "all" : null, purge: said.length > 0 };
}
