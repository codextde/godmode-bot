import { useSyncExternalStore } from "react";

/** Window in the background this long, and motion stops. */
const UNFOCUSED_MS = 5_000;
/** Window in front but nobody touching it this long (the human walked away), and motion stops too. */
const UNTOUCHED_MS = 3 * 60_000;
const CLASS = "gm-rest";

const listeners = new Set<() => void>();
let resting = false;

function setResting(next: boolean) {
  if (next === resting) return;
  resting = next;
  document.documentElement.classList.toggle(CLASS, next);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isMotionResting(): boolean {
  return resting;
}

export function onMotionRest(listener: (resting: boolean) => void): () => void {
  return subscribe(() => listener(resting));
}

export function useMotionRest(): boolean {
  return useSyncExternalStore(subscribe, () => resting);
}

/**
 * Ends every looping CSS animation and the streaming text smoother while nobody is looking (`.gm-rest` on <html>, see index.css). A looping spinner,
 * shimmer or breathing character makes WebKit and the WindowServer draw the window 60-120 times a second, which keeps
 * the Mac awake for nothing when Godmode sits in the background or a tray.
 */
export function startMotionRest(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt = 0;

  const rest = () => {
    clearTimeout(timer);
    timer = undefined;
    setResting(true);
  };
  const wake = () => {
    if (document.hidden) return rest();
    setResting(false);
    const now = Date.now();
    // Pointer moves arrive many times a second: re-arming once a second is plenty.
    if (timer && now - scheduledAt < 1_000) return;
    scheduledAt = now;
    clearTimeout(timer);
    timer = setTimeout(rest, focused() ? UNTOUCHED_MS : UNFOCUSED_MS);
  };
  // Typing or scrolling inside an artifact's iframe blurs this window, and its input never reaches us.
  const focused = () => document.hasFocus() || document.activeElement instanceof HTMLIFrameElement;

  const input = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
  for (const e of input) window.addEventListener(e, wake, { passive: true, capture: true });
  // Focus, blur and visibility change which timeout applies: re-arm right away.
  const rearm = () => {
    scheduledAt = 0;
    wake();
  };
  window.addEventListener("focus", rearm);
  window.addEventListener("blur", rearm);
  document.addEventListener("visibilitychange", rearm);
  wake();

  return () => {
    clearTimeout(timer);
    for (const e of input) window.removeEventListener(e, wake, { capture: true });
    window.removeEventListener("focus", rearm);
    window.removeEventListener("blur", rearm);
    document.removeEventListener("visibilitychange", rearm);
    setResting(false);
  };
}
