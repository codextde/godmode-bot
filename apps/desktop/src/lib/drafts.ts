import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { storageKey } from "./core";

/**
 * Unsent input (chat messages, new agents, dialogs) outlives the component that shows it, so leaving a page,
 * switching a tab or clicking outside a dialog never throws work away. A draft only exists while it differs from
 * where the input started, and lives for the app session.
 */
const PREFIX = `${storageKey("gm-draft")}:`;

interface Stored {
  /** What the input started from: fields still equal to it follow the latest data when the draft comes back. */
  base: unknown;
  value: unknown;
}

const memory = new Map<string, Stored>();

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): Stored | undefined {
  const cached = memory.get(key);
  if (cached) return cached;
  const raw = session()?.getItem(PREFIX + key);
  if (raw == null) return undefined;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (!stored || typeof stored !== "object" || !("value" in stored)) return undefined;
    memory.set(key, stored);
    return stored;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `value` moved from `base` onto `next`: only the fields changed in it win, so edits made elsewhere meanwhile survive. */
function rebase<T>(value: unknown, base: unknown, next: T): T {
  if (!isRecord(value) || !isRecord(base) || !isRecord(next)) return (same(value, base) ? next : value) as T;
  const merged: Record<string, unknown> = { ...next };
  for (const k of Object.keys(value)) if (!same(value[k], base[k])) merged[k] = value[k];
  return merged as T;
}

export function loadDraft<T>(key: string | undefined, fallback: T): T {
  const stored = key ? read(key) : undefined;
  return stored ? rebase(stored.value, stored.base, fallback) : fallback;
}

/** `persist: false` keeps it in memory only: for values too big or not serialisable (attached files). */
export function saveDraft(key: string, value: unknown, base: unknown, persist = true) {
  const stored = { base, value };
  memory.set(key, stored);
  if (!persist) return;
  try {
    session()?.setItem(PREFIX + key, JSON.stringify(stored));
  } catch {
    /* storage full: the in-memory copy still survives navigation */
  }
}

export function clearDraft(key: string) {
  memory.delete(key);
  try {
    session()?.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

export function draftKeys(prefix: string): string[] {
  const keys = new Set([...memory.keys()].filter((k) => k.startsWith(prefix)));
  const s = session();
  for (let i = 0; s && i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(PREFIX + prefix)) keys.add(k.slice(PREFIX.length));
  }
  return [...keys];
}

/**
 * `useState` whose value is kept as a draft under `key` (none = plain state) until it's back to `initial`.
 * When `initial` changes (fresh data from the server), untouched fields follow it and edited ones stay.
 */
export function useDraft<T>(key: string | undefined, initial: T, { persist = true }: { persist?: boolean } = {}) {
  const [state, setState] = useState(() => ({ key, base: initial, value: loadDraft(key, initial) }));
  let current = state;
  if (state.key !== key) current = { key, base: initial, value: loadDraft(key, initial) };
  else if (!same(state.base, initial)) current = { key, base: initial, value: rebase(state.value, state.base, initial) };
  if (current !== state) setState(current);
  const value = current.value;
  const initialRef = useRef(initial);
  initialRef.current = initial;

  useEffect(() => {
    if (!key) return;
    if (same(value, initialRef.current)) clearDraft(key);
    else saveDraft(key, value, initialRef.current, persist);
  }, [key, value, persist]);

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (action) => setState((s) => ({ ...s, value: typeof action === "function" ? (action as (prev: T) => T)(s.value) : action })),
    [],
  );

  /** Back to `initial`, and the draft is gone right away (also when the component unmounts in the same update). */
  const discard = useCallback(() => {
    if (key) clearDraft(key);
    setState((s) => ({ ...s, base: initialRef.current, value: initialRef.current }));
  }, [key]);

  return [value, setValue, { saved: !!key && !same(value, initial), discard }] as const;
}
