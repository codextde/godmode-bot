import { storageKey } from "@/lib/core";
import { useUi } from "@/stores/ui";

/** Away this long, and Home sums up what the team did meanwhile. */
const AWAY_MS = 2 * 60 * 60_000;
/** Writing the time down at most this often. */
const WRITE_MS = 30_000;
const KEY = storageKey("godmode-last-active");

function stored(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Notices when the human comes back: their own input (not the window's focus — a focused window can sit there all
 * night) after at least two hours without any. The time is kept per computer, so every window and restart agrees.
 */
export function startPresence(): () => void {
  let last = stored();
  let written = 0;
  const onInput = () => {
    if (!document.hasFocus()) return;
    const now = Date.now();
    // Another window may have seen the human since.
    if (last !== null && now - last >= AWAY_MS) last = Math.max(last, stored() ?? 0);
    if (last !== null && now - last >= AWAY_MS) useUi.getState().setAway({ since: new Date(last).toISOString(), until: new Date(now).toISOString() });
    last = now;
    if (now - written < WRITE_MS) return;
    written = now;
    try {
      localStorage.setItem(KEY, String(now));
    } catch {
      /* private window: only this session notices */
    }
  };
  // On release, not press: the summary appearing mid-click would move what the click was meant for.
  const events = ["pointerup", "keyup", "wheel"] as const;
  for (const e of events) window.addEventListener(e, onInput, { passive: true, capture: true });
  return () => {
    for (const e of events) window.removeEventListener(e, onInput, { capture: true });
  };
}
