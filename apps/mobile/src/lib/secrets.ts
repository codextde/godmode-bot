import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { confirmWithBiometrics } from "@/components/full-access";
import { ApiError } from "./api";
import { useSession } from "./session";
import { fullVaultApi } from "./vault";

/**
 * Secrets on a phone with full access. Revealing one takes Face ID first, then a grant: the computer's proof that the
 * vault password was typed lately (10 minutes). The grant lives in memory only; revealed values live in the state of the
 * screen that shows them and are dropped when it hides, leaves the screen or the app goes to the background.
 */

const EXPIRY_MARGIN_MS = 15_000;
const MAX_GRANT_MS = 10 * 60_000;
const CLEAR_CLIPBOARD_MS = 60_000;

let cached: { grant: string; expiresAt: number; token: string } | null = null;
let pending: { promise: Promise<string>; resolve: (grant: string) => void; reject: (err: Error) => void } | null = null;

/** The human closed Face ID or the password sheet: callers stop without an error. */
export class RevealCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "RevealCancelled";
  }
}

export const isCancelled = (err: unknown) => err instanceof RevealCancelled;

const token = () => useSession.getState().connection?.token ?? "";

function validGrant(): string | undefined {
  if (cached && cached.token === token() && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cached.grant;
  cached = null;
  return undefined;
}

/** A grant the computer just gave for the vault password. */
export function keepGrant(res: { grant: string; expiresAt: string }) {
  cached = { grant: res.grant, expiresAt: Math.min(Date.parse(res.expiresAt) || 0, Date.now() + MAX_GRANT_MS), token: token() };
}

/** Asks for the vault password in a sheet (one at a time); rejects with RevealCancelled when it is closed. */
function askForGrant(): Promise<string> {
  if (pending) return pending.promise;
  let resolve!: (grant: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending = { promise, resolve, reject };
  router.push({ pathname: "/vault/passphrase", params: { mode: "grant" } });
  return promise;
}

/** The password sheet is done: with the grant it got, or null when it was closed. */
export function settleGrant(grant: string | null) {
  const current = pending;
  pending = null;
  if (!current) return;
  if (grant) current.resolve(grant);
  else current.reject(new RevealCancelled());
}

/** Sends the kept grant; if the computer wants a (new) one, asks for the vault password and tries once more. */
export async function withGrant<T>(call: (grant: string | undefined) => Promise<T>): Promise<T> {
  try {
    return await call(validGrant());
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "grant_required")) throw err;
    cached = null;
    return call(await askForGrant());
  }
}

/**
 * For changes that loosen something (a card's limits, unfreezing): sent without a grant first; when the computer wants
 * one, Face ID comes first, every time, then the kept grant or the vault password.
 */
export async function withConfirmedGrant<T>(reason: string, call: (grant: string | undefined) => Promise<T>): Promise<T> {
  try {
    return await call(undefined);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "grant_required")) throw err;
    if (!(await confirmWithBiometrics(reason))) throw new RevealCancelled();
    return withGrant(call);
  }
}

/** Face ID, then the call with a grant. Rejects with RevealCancelled when either is cancelled. */
export async function reveal<T>(reason: string, call: (grant: string | undefined) => Promise<T>): Promise<T> {
  if (!(await confirmWithBiometrics(reason))) throw new RevealCancelled();
  return withGrant(call);
}

/**
 * Copies a secret: kept on this phone only (no Universal Clipboard), marked sensitive on Android, and cleared after a
 * minute (iOS clears it itself; Android only when the clipboard still holds it).
 */
export async function copySecret(value: string) {
  await Clipboard.setStringAsync(value, {
    ios: { localOnly: true, expiresAt: new Date(Date.now() + CLEAR_CLIPBOARD_MS) },
    android: { isSensitive: true },
  });
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  if (process.env.EXPO_OS === "android") {
    // In the background Android reads the clipboard as empty: then it is cleared anyway, a lingering secret is worse.
    setTimeout(() => {
      void Clipboard.getStringAsync()
        .catch(() => "")
        .then((current) => (current === value || !current ? Clipboard.setStringAsync("") : undefined))
        .catch(() => undefined);
    }, CLEAR_CLIPBOARD_MS);
  }
}

/** Copies something that isn't secret (a username, a public key). */
export async function copyPlain(value: string) {
  await Clipboard.setStringAsync(value);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/**
 * A revealed value that hides itself: after `ttlMs`, when the screen loses focus and when the app leaves the
 * foreground. `shownAt` lets a countdown follow it.
 */
export function useRevealed<V>(ttlMs: number) {
  const [state, setState] = useState<{ value: V; at: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState(null);
  }, []);

  const show = useCallback(
    (value: V) => {
      // A reveal that answers after the app left the foreground stays hidden.
      if (AppState.currentState === "background") return;
      if (timer.current) clearTimeout(timer.current);
      setState({ value, at: Date.now() });
      timer.current = setTimeout(() => {
        timer.current = null;
        setState(null);
      }, ttlMs);
    },
    [ttlMs],
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") hide();
    });
    return () => {
      sub.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hide]);

  useFocusEffect(useCallback(() => hide, [hide]));

  return { value: state?.value ?? null, shownAt: state?.at ?? null, show, hide };
}

export interface LiveCode {
  id: string;
  code: string;
  period: number;
  /** When this code stops working (epoch ms). */
  expiresAt: number;
}

/**
 * Current 2FA codes while `enabled` (all of them, or `ids`), fetched again right after the earliest one runs out. Kept in
 * this hook's state only, and dropped when it is switched off.
 */
export function useLiveCodes(enabled: boolean, ids?: string[]) {
  const [codes, setCodes] = useState<Map<string, LiveCode>>(() => new Map());
  const [error, setError] = useState<unknown>(null);
  const key = ids?.join(",") ?? "";

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wanted = key ? key.split(",") : undefined;
    const load = async () => {
      try {
        const list = await fullVaultApi.totpCodes(wanted);
        if (cancelled) return;
        const now = Date.now();
        const next = new Map(list.map((c) => [c.id, { id: c.id, code: c.code, period: c.period, expiresAt: now + c.remaining * 1000 }] as const));
        setCodes(next);
        setError(null);
        const earliest = Math.min(...[...next.values()].map((c) => c.expiresAt), now + 30_000);
        timer = setTimeout(() => void load(), Math.min(Math.max(0, earliest - Date.now()) + 300, 60_000));
      } catch (err) {
        if (cancelled) return;
        setError(err);
        timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setCodes(new Map());
      setError(null);
    };
  }, [enabled, key]);

  return { codes, error };
}

/** "123456" → "123 456", "12345678" → "1234 5678". */
export function formatCode(code: string): string {
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length >= 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

/** Dots shaped like a code of `digits`. */
export const maskedCode = (digits = 6) => formatCode("•".repeat(digits));
