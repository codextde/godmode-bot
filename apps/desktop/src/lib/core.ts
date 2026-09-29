/**
 * Locates the Godmode core daemon and its credentials.
 *
 *  - Desktop (Tauri): the Rust shell spawns the core sidecar and exposes `{ url, token }` via the `core_info` command.
 *  - Web dashboard (served by `godmode serve`): same origin, HttpOnly session cookie.
 *  - Dev (vite on :1420): requests go through the vite proxy; the access token is injected at build time.
 */

declare const __DEV_TOKEN__: string;

export interface CoreInfo {
  /** Base URL for HTTP requests ('' = same origin) */
  baseUrl: string;
  /** Bearer token (desktop/dev) or null for cookie auth */
  token: string | null;
  isTauri: boolean;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let info: CoreInfo | null = null;
let pending: Promise<CoreInfo> | null = null;

export async function getCoreInfo(): Promise<CoreInfo> {
  if (info) return info;
  if (pending) return pending;
  pending = (async () => {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      // The shell resolves once the sidecar printed its ready line.
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const res = await invoke<{ url: string; token: string } | null>("core_info");
          if (res?.url) {
            info = { baseUrl: res.url.replace(/\/$/, ""), token: res.token, isTauri: true };
            return info;
          }
        } catch {
          /* not ready */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("Godmode core did not start. Check the logs in ~/.godmode/logs.");
    }
    const devToken = typeof __DEV_TOKEN__ === "string" && __DEV_TOKEN__ ? __DEV_TOKEN__ : null;
    const stored = safeSession("gm_token");
    info = { baseUrl: "", token: devToken ?? stored, isTauri: false };
    return info;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** Absolute URL of a core path, e.g. an automation's webhook. The app renders only after `getCoreInfo` resolved. */
export function coreUrl(path: string): string {
  return `${info?.baseUrl || window.location.origin}${path}`;
}

/** Web dashboard: remember an access token for this browser tab session only. */
export function setSessionToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem("gm_token", token);
    else sessionStorage.removeItem("gm_token");
  } catch {
    /* ignore */
  }
  if (info) info = { ...info, token };
}

function safeSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function wsUrl(): Promise<string> {
  const { baseUrl, token } = await getCoreInfo();
  const base = baseUrl || window.location.origin;
  const url = new URL("/api/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
