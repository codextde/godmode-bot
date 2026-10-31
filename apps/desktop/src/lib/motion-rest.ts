/** Window in the background this long, and motion stops. */
const UNFOCUSED_MS = 15_000;
/** Window in front but nobody touching it this long (the human walked away), and motion stops too. */
const UNTOUCHED_MS = 3 * 60_000;
const CLASS = "gm-rest";

/**
 * Pauses every CSS animation while nobody is looking (`.gm-rest` on <html>, see index.css). A looping spinner,
 * shimmer or breathing character makes WebKit and the WindowServer draw the window 60-120 times a second, which keeps
 * the Mac awake for nothing when Godmode sits in the background or a tray.
 */
export function startMotionRest(): () => void {
  const root = document.documentElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt = 0;

  const rest = () => {
    clearTimeout(timer);
    timer = undefined;
    root.classList.add(CLASS);
  };
  const wake = () => {
    if (document.hidden) return rest();
    root.classList.remove(CLASS);
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
  // Something new on screen (a dialog, a toast, a streaming reply) must play its entrance, not sit on frame 0.
  const changes = new MutationObserver((records) => {
    if (records.some((r) => Array.from(r.addedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE))) wake();
  });
  changes.observe(document.body, { childList: true, subtree: true });
  wake();

  return () => {
    clearTimeout(timer);
    changes.disconnect();
    for (const e of input) window.removeEventListener(e, wake, { capture: true });
    window.removeEventListener("focus", rearm);
    window.removeEventListener("blur", rearm);
    document.removeEventListener("visibilitychange", rearm);
    root.classList.remove(CLASS);
  };
}
