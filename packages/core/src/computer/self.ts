/**
 * Godmode itself is never shared with an agent: an agent driving Godmode's UI could change its own permissions as if
 * it were the human. The desktop app is the parent of this core process.
 */
import { config } from "../config";

/** Bundle id of the Godmode desktop app (tauri.conf.json `identifier`). */
export const GODMODE_BUNDLE_ID = "dev.codext.godmode";

export function isGodmodeWindow(w: { pid: number; bundleId?: string | null; app?: string }): boolean {
  return w.pid === process.pid || w.pid === process.ppid || w.bundleId === GODMODE_BUNDLE_ID;
}

/** A page of Godmode's own dashboard (the core's host and port). */
export function isGodmodeTab(url: string): boolean {
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const cfg = config();
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === cfg.host;
    return local && port === cfg.port;
  } catch {
    return false;
  }
}

/** "Godmode", "Godmode Bot", "godmode.app" … */
export function isGodmodeAppName(name: string): boolean {
  return /^\s*godmode(\s*bot)?(\.app)?\s*$/i.test(name);
}
