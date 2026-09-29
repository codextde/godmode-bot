/**
 * Registry of running (managed) browsers, shared by the manager, live view and importer.
 */
import type { CdpClient } from "./cdp";
import type { ChromeProcess } from "./chrome";

export interface RunningBrowser {
  profileId: string;
  port: number;
  /** http://127.0.0.1:<port> — what CDP clients such as browser-use connect to. */
  httpUrl: string;
  wsUrl: string;
  headless: boolean;
  /** Launched with bot-detection hardening (see stealth.ts). */
  stealth: boolean;
  /** Persistent browser-level CDP connection owned by Godmode. */
  client: CdpClient;
  /** null when we adopted a browser left running by a previous core process. */
  process: ChromeProcess | null;
  /** Browser process id (known for adopted browsers too). */
  pid: number | null;
  userDataDir: string;
  startedAt: number;
  lastUsedAt: number;
  stopping: boolean;
  /** Started just for a bot check or an import, which stop it again — unless someone else got it meanwhile. */
  transient: boolean;
}

const running = new Map<string, RunningBrowser>();
type Listener = (profileId: string, browser: RunningBrowser | null) => void;
const listeners = new Set<Listener>();

export function getRunning(profileId: string): RunningBrowser | null {
  const rb = running.get(profileId);
  return rb && !rb.stopping && !rb.client.closed ? rb : null;
}

/** Includes browsers that are shutting down. */
export function getRegistered(profileId: string): RunningBrowser | null {
  return running.get(profileId) ?? null;
}

export function allRunning(): RunningBrowser[] {
  return [...running.values()];
}

export function registerBrowser(rb: RunningBrowser) {
  running.set(rb.profileId, rb);
  notify(rb.profileId, rb);
}

/** Remove `rb` if it is still the registered instance for its profile. Returns true if removed. */
export function unregisterBrowser(rb: RunningBrowser): boolean {
  if (running.get(rb.profileId) !== rb) return false;
  running.delete(rb.profileId);
  notify(rb.profileId, null);
  return true;
}

/** Mark the profile browser as in use (defers idle shutdown). */
export function touchBrowser(profileId: string) {
  const rb = running.get(profileId);
  if (rb) {
    rb.lastUsedAt = Date.now();
    rb.transient = false;
  }
}

/** Called with the browser when one starts and with null when it stops. */
export function onBrowserState(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(profileId: string, rb: RunningBrowser | null) {
  for (const l of [...listeners]) {
    try {
      l(profileId, rb);
    } catch {
      /* listeners must not break the registry */
    }
  }
}
