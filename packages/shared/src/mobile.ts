/**
 * The Godmode phone app (iOS and Android) controls this computer's Godmode. A phone is paired once by scanning a QR
 * code shown on the computer; it then reaches Godmode over Tailscale (the user's private, end-to-end encrypted network)
 * with its own device token, which only opens the parts of the API the app uses.
 */
import type { ID, ISODate } from "./models";

export type MobilePlatform = "ios" | "android";

export interface MobileDevice {
  id: ID;
  name: string;
  platform: MobilePlatform;
  /** e.g. "iPhone 17 Pro" */
  model: string | null;
  appVersion: string | null;
  createdAt: ISODate;
  lastSeenAt: ISODate | null;
  /** Tailscale address the phone last connected from. */
  lastAddress: string | null;
  /** The app is connected right now. */
  online: boolean;
}

export interface TailscaleStatus {
  /** Tailscale was found on this computer. */
  installed: boolean;
  /** Signed in and connected. */
  running: boolean;
  /** This computer's Tailscale IPv4 address, e.g. "100.101.102.103". */
  ip: string | null;
  /** MagicDNS name, e.g. "macbook.tail1234.ts.net". */
  dnsName: string | null;
  /** Tailnet name, e.g. "daniel@example.com". */
  tailnet: string | null;
  /** Why it can't be used, in words for a human. */
  detail: string | null;
}

/** GET /api/mobile */
export interface MobileStatus {
  /** Phones may connect (`settings.mobile.enabled`). */
  enabled: boolean;
  port: number;
  tailscale: TailscaleStatus;
  /** Where phones reach Godmode right now, best first. Empty while not listening. */
  urls: string[];
  /** Why phones can't connect although it's on (Tailscale off, port in use, …). */
  error: string | null;
  devices: MobileDevice[];
}

/** POST /api/mobile/pairing: a one-time code, shown as a QR code. */
export interface MobilePairingOffer {
  /** What the QR code holds: `godmode://pair?d=<payload>`. */
  link: string;
  expiresAt: ISODate;
  urls: string[];
}

/** The QR code's payload. */
export interface MobilePairingPayload {
  v: 1;
  /** Instance id: the phone only trusts answers from this Godmode, whichever address it uses. */
  id: string;
  /** Computer name */
  name: string;
  /** Where to reach Godmode, best first (Tailscale name, then address). */
  urls: string[];
  /** One-time pairing secret. */
  code: string;
  /** Expiry in unix seconds. */
  exp: number;
}

/** POST /api/mobile/pair (from the phone) */
export interface MobilePairInput {
  code: string;
  name: string;
  platform: MobilePlatform;
  model?: string | null;
  appVersion?: string | null;
}

/** The computer a phone controls. */
export interface MobileInstance {
  id: string;
  name: string;
  version: string;
  platform: string;
}

export interface MobilePairResult {
  /** Device token: `Authorization: Bearer <token>` on every request and the WebSocket. */
  token: string;
  device: MobileDevice;
  instance: MobileInstance;
}

/** GET /api/mobile/me: the calling phone and the computer it controls. */
export interface MobileSession {
  device: MobileDevice;
  instance: MobileInstance;
}

export const MOBILE_DEFAULT_PORT = 7787;
export const MOBILE_PAIR_PREFIX = "godmode://pair?d=";
export const MOBILE_TOKEN_PREFIX = "gmd_";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8(text: string): number[] {
  const out: number[] = [];
  const encoded = encodeURIComponent(text);
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") {
      out.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(encoded.charCodeAt(i));
  }
  return out;
}

function base64url(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

function fromBase64url(text: string): string | null {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.replace(/=+$/, "")) {
    const v = B64.indexOf(ch === "+" ? "-" : ch === "/" ? "_" : ch);
    if (v < 0) return null;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
  }
  try {
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
  } catch {
    return null;
  }
}

export function encodePairingLink(payload: MobilePairingPayload): string {
  return MOBILE_PAIR_PREFIX + base64url(utf8(JSON.stringify(payload)));
}

/** Reads a scanned QR code or pasted link (or just its `d` parameter); null when it isn't a Godmode pairing code. */
export function parsePairingLink(text: string): MobilePairingPayload | null {
  const trimmed = text.trim();
  const data = /^godmode:\/\/pair/i.test(trimmed) ? /[?&#]d=([A-Za-z0-9_-]+)/.exec(trimmed)?.[1] : /^[A-Za-z0-9_-]{40,}$/.test(trimmed) ? trimmed : null;
  if (!data) return null;
  const json = fromBase64url(data);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const p = raw as Partial<MobilePairingPayload>;
  if (p?.v !== 1 || typeof p.id !== "string" || typeof p.code !== "string" || typeof p.exp !== "number") return null;
  if (!Array.isArray(p.urls) || !p.urls.every((u) => typeof u === "string" && /^https?:\/\//.test(u))) return null;
  return { v: 1, id: p.id, name: typeof p.name === "string" ? p.name : "Godmode", urls: p.urls, code: p.code, exp: p.exp };
}

/**
 * Where the phone may send its key: https anywhere (a future gateway), plain http only to a Tailscale address
 * (100.64.0.0/10 or a *.ts.net name), which Tailscale encrypts end to end.
 */
export function isPhoneUrlAllowed(url: string): boolean {
  const m = /^(https?):\/\/([^/?#@\s]+)(?:[/?#]|$)/i.exec(url.trim());
  if (!m) return false;
  if (m[1]!.toLowerCase() === "https") return true;
  const host = m[2]!.replace(/:\d+$/, "").toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host)) return true;
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
}
