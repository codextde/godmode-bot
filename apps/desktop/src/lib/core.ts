/**
 * Locates the Godmode core daemon and its credentials.
 *
 *  - Desktop (Tauri): the Rust shell spawns the core sidecar and exposes `{ url, token }` via the `core_info` command.
 *  - Web dashboard (served by `godmode serve`): same origin, HttpOnly session cookie.
 *  - Dev (vite on :1420): requests go through the vite proxy; the access token is injected at build time.
 *  - Cloud (served by Godmode Cloud under `/d/<deviceId>/`): requests go to `<base>/api/…` on the cloud's origin,
 *    which relays them to the computer; the cloud's own session cookie signs them in.
 */
import { CLOUD_UI_META, type CloudUiContext } from "@godmode/shared";

declare const __DEV_TOKEN__: string;

export interface CoreInfo {
  /** Base URL for HTTP requests ('' = same origin) */
  baseUrl: string;
  /** Bearer token (desktop/dev) or null for cookie auth */
  token: string | null;
  isTauri: boolean;
  /** Set when Godmode Cloud serves this UI for one computer. */
  cloud: CloudUiContext | null;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The cloud puts `<meta name="godmode-cloud" content="…">` into index.html; its presence is the only switch to cloud
 * mode. Read synchronously at module load: the router basename and the storage keys need it before the first render.
 */
export const cloudContext: CloudUiContext | null = readCloudContext();

function readCloudContext(): CloudUiContext | null {
  if (typeof document === "undefined") return null;
  const content = document.querySelector<HTMLMetaElement>(`meta[name="${CLOUD_UI_META}"]`)?.content;
  if (!content) return null;
  try {
    const ctx = JSON.parse(content) as CloudUiContext;
    if (typeof ctx?.base !== "string" || typeof ctx.deviceId !== "string") return null;
    return { ...ctx, base: ctx.base.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** Browser storage key for things that belong to one computer: several computers share the cloud's origin. */
export function storageKey(key: string): string {
  return cloudContext ? `${key}:${cloudContext.deviceId}` : key;
}

/** The cloud session ended: sign in there and come back to this page. */
export function goToCloudLogin() {
  if (!cloudContext) return;
  window.location.assign(`${cloudContext.login}?next=${encodeURIComponent(window.location.pathname)}`);
}

let info: CoreInfo | null = null;
let pending: Promise<CoreInfo> | null = null;

export async function getCoreInfo(): Promise<CoreInfo> {
  if (info) return info;
  if (pending) return pending;
  pending = (async () => {
    if (cloudContext) {
      info = { baseUrl: cloudContext.base, token: null, isTauri: false, cloud: cloudContext };
      return info;
    }
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      // The shell resolves once the sidecar printed its ready line.
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const res = await invoke<{ url: string; token: string } | null>("core_info");
          if (res?.url) {
            info = { baseUrl: res.url.replace(/\/$/, ""), token: res.token, isTauri: true, cloud: null };
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
    info = { baseUrl: "", token: devToken ?? stored, isTauri: false, cloud: null };
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
  return new URL(`${info?.baseUrl ?? ""}${path}`, window.location.origin).toString();
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
  // Relative to the page's origin so a path prefix (cloud mode: `/d/<deviceId>`) is kept.
  const url = new URL(`${baseUrl}/api/ws`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
