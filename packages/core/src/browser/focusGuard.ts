/**
 * macOS: Chromium activates itself when a page opens a tab or popup, or when a script connected straight to its
 * DevTools port opens a tab in the foreground — taking the keyboard from whatever the human is doing. Whenever an
 * agent browser gets a new tab, the native helper is armed to hand such an activation straight back (`FocusGuard` in
 * native/macos/GodmodeComputer.swift). A window the human clicks into stays theirs.
 */
import { getHelper, NativeHelper } from "../computer/helper";
import { logger } from "../log";
import { onBrowserState, type RunningBrowser } from "./state";

const log = logger("browser-focus");

/** How long after a new tab the browser may not take the focus (pages open popups after loading a little). */
const ARM_MS = 3000;

const watching = new Map<string, () => void>();
let initialized = false;
let warned = false;

export function initFocusGuard() {
  if (initialized || process.platform !== "darwin") return;
  initialized = true;
  onBrowserState((profileId, rb) => {
    watching.get(profileId)?.();
    watching.delete(profileId);
    if (rb && !rb.headless && rb.pid) watching.set(profileId, watch(rb, rb.pid));
  });
}

function watch(rb: RunningBrowser, pid: number): () => void {
  // Started now, the helper knows which app the human is in before the browser takes it.
  void arm(pid, 0);
  return rb.client.on("Target.targetCreated", (p) => {
    if ((p.targetInfo as { type?: string } | undefined)?.type === "page") void arm(pid, ARM_MS);
  });
}

async function arm(pid: number, ms: number) {
  try {
    const helper = await getHelper();
    if (helper instanceof NativeHelper) await helper.call("guardFocus", { pid, ms }, 5000);
  } catch (err) {
    if (warned) return;
    warned = true;
    log.warn(`the browser can't be kept from taking the focus: ${err instanceof Error ? err.message : String(err)}`);
  }
}
