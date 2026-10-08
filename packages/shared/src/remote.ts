/**
 * Remote runners: a headless Godmode on another computer that does the work of a chat, so it goes on while this
 * computer sleeps. The Godmode the human uses (the controller) pairs with a runner once, copies what the work needs to
 * it and mirrors its chats; everything between the two travels over an end-to-end encrypted link.
 */
import type { TailscaleStatus } from "./mobile";
import type { ID, ISODate, ToolUpdateStatus } from "./models";

/** Port the runner listens on for the encrypted link (phones use 7787). */
export const RUNNER_DEFAULT_PORT = 7788;
/** Version of the link protocol; both sides must match. */
export const LINK_PROTOCOL = 1;
/** Pairing code a runner shows: `gmr1.<base64url(JSON RunnerPairingCode)>`. */
export const RUNNER_CODE_PREFIX = "gmr1.";
/** Pairing offer Godmode puts into the install command: `gmo1.<base64url(JSON RunnerPairingOfferPayload)>`. */
export const RUNNER_OFFER_PREFIX = "gmo1.";
/** Live views of a runner's screen are named `runner:<runner id>:<view>` on the controller. */
export const RUNNER_VIEW_PREFIX = "runner:";

export type RunnerState = "online" | "connecting" | "offline" | "update_required";
export type RunnerSyncState = "synced" | "pending" | "syncing" | "failed";

export interface RunnerHealthSummary {
  ok: boolean;
  /** Required checks that fail. */
  failing: number;
  warnings: number;
  checkedAt: ISODate;
}

/** A paired runner as the controller sees it. */
export interface RemoteRunner {
  id: ID;
  name: string;
  hostname: string;
  platform: string | null;
  arch: string | null;
  /** Godmode version running there; null until first connected. */
  version: string | null;
  /** The commit its Godmode was built from ("dev" from source); null for a runner older than its updater. */
  build: string | null;
  /** Hosts or IPs to dial, best first (LAN address, Tailscale address, `name.local`). */
  addresses: string[];
  port: number;
  /** Short fingerprint of the runner's public key, for display ("3F2A 91C0 7B4E"). */
  fingerprint: string;
  state: RunnerState;
  /** Why it isn't online (human readable), or null. */
  error: string | null;
  /** The address the link is connected through. */
  address: string | null;
  latencyMs: number | null;
  lastSeenAt: ISODate | null;
  pairedAt: ISODate;
  sync: { state: RunnerSyncState; syncedAt: ISODate | null; error: string | null };
  health: RunnerHealthSummary | null;
  /** Runs working on it right now. */
  activeRuns: number;
  /** Chats that live on it. */
  conversations: number;
  /** Copy the browser sessions (cookies) of the profile a chat uses before it starts. */
  syncBrowser: boolean;
  update: RunnerUpdate;
}

export interface RunnerPatch {
  name?: string;
  addresses?: string[];
  port?: number;
  syncBrowser?: boolean;
  autoUpdate?: boolean;
}

/**
 * Bringing a runner's Godmode to the one this computer runs, and its tools to their newest versions.
 *
 *  current      the same Godmode as here (tools may still have updates: `tools`)
 *  available    another build than here; `Update` installs this computer's
 *  sending      the new Godmode is on its way over the link (`progress`)
 *  waiting      it is there and installs once the runner's runs are done
 *  installing   the runner replaces its program, or updates its tools
 *  restarting   it restarted with the new Godmode and comes back in a moment
 *  failed       the last attempt didn't work (`detail`); `Update` tries again
 *  unsupported  can't be updated from here (`detail` says what to do instead)
 */
export type RunnerUpdateState = "current" | "available" | "sending" | "waiting" | "installing" | "restarting" | "failed" | "unsupported";

/** How the new Godmode gets there: this computer's own program, a download from usegodmode.com, or (runners from before the updater) fetched from here once. */
export type RunnerUpdateSource = "controller" | "website" | "bridge";

export interface RunnerUpdate {
  state: RunnerUpdateState;
  /** The Godmode it gets: this computer's. */
  target: { version: string; build: string };
  source: RunnerUpdateSource | null;
  /** 0..1 while the new Godmode is sent. */
  progress: number | null;
  detail: string | null;
  /** Install a new Godmode by itself once it connects (and its runs are done). */
  autoUpdate: boolean;
  /** Tools on the runner with an update it can install (Claude Code, uv, Chromium…), from its last report. */
  tools: Pick<ToolUpdateStatus, "id" | "name" | "current" | "latest">[];
  /** A command to run on the runner when it can't be updated from here; null otherwise. */
  command: string | null;
}

/** POST /api/runners/:id/update */
export interface RunnerUpdateInput {
  /** Also install the runner's tool updates (default true). */
  tools?: boolean;
}

/** What a runner says about the update it is installing (in RunnerInfo). */
export interface RunnerSelfUpdate {
  state: "idle" | "receiving" | "waiting" | "installing" | "failed";
  /** The build it installs (or failed to). */
  target: { version: string; build: string } | null;
  error: string | null;
  /** Runs it waits for. */
  waitingFor: number;
}

/** How a runner reaches this computer: the local network, a virtual machine's bridge, or Tailscale. */
export type RunnerNetwork = "lan" | "vm" | "tailscale";

/** One address of this computer the install command can use. */
export interface RunnerOfferRoute {
  network: RunnerNetwork;
  address: string;
  /** `http://<address>:<port>` of the pairing listener. */
  url: string;
  /** The interface ("en0"), or Tailscale's MagicDNS name of this computer. */
  detail: string | null;
  /** The install command through this address; null when this build can't serve its own binary. */
  command: string | null;
}

/** POST /api/runners/pairing */
export interface RunnerPairingOffer {
  offerId: ID;
  /** One command that installs the runner from this computer and pairs it (through the first route); null when this build can't serve its own binary. */
  command: string | null;
  /** Every address of this computer the other Mac can download from, best first. */
  routes: RunnerOfferRoute[];
  /** The same through usegodmode.com (needs the license key in place of the placeholder). */
  websiteCommand: string;
  /** Where the runner reaches this computer while pairing. */
  urls: string[];
  /** Tailscale on this computer, so the human can pick it or learn why it isn't there. */
  tailscale: TailscaleStatus;
  expiresAt: ISODate;
}

/** Decoded `gmo1.` payload. */
export interface RunnerPairingOfferPayload {
  v: 1;
  id: ID;
  /** One-time secret; never sent over the network (it keys the sealed reply). */
  token: string;
  urls: string[];
  /** Name of the computer that made the offer. */
  name: string;
  /** Unix seconds. */
  exp: number;
}

/** Decoded `gmr1.` payload. */
export interface RunnerPairingCode {
  v: 1;
  name: string;
  hostname: string;
  addresses: string[];
  port: number;
  /** Runner's static X25519 public key, base64url (32 bytes). */
  key: string;
  /** Pairing id + one-time secret (the handshake's pre-shared key). */
  id: ID;
  secret: string;
  /** Unix seconds. */
  exp: number;
}

/** What a runner says about itself (link `ready` message and GET /api/link/info). */
export interface RunnerInfo {
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  version: string;
  /** Missing on runners older than their updater. */
  build?: string;
  /** One compiled program (can replace itself); false when it runs from source. */
  compiled?: boolean;
  /** SHA-256 of that program, once known: two runners with the same digest run the same Godmode. */
  digest?: string | null;
  update?: RunnerSelfUpdate;
  protocol: number;
  vault: { initialized: boolean; unlocked: boolean };
  /** Digest of the config snapshot it last applied; null = never synced. */
  configDigest: string | null;
  activeRuns: number;
}

export type RunnerCheckGroup = "software" | "permissions" | "access" | "system";
export type RunnerCheckStatus = "ok" | "warn" | "fail" | "unknown";
/** How a failing check can be fixed. `manual`: only the hint helps. */
export type RunnerFixKind = "install" | "request" | "open-settings" | "sync" | "restart" | "manual";

export interface RunnerCheck {
  id: string;
  group: RunnerCheckGroup;
  name: string;
  status: RunnerCheckStatus;
  /** One line: what was found. */
  detail: string;
  /** A failing required check blocks work; others are warnings. */
  required: boolean;
  fix: { kind: RunnerFixKind; label: string; /** What the human has to do themselves, if anything. */ hint?: string } | null;
}

export interface RunnerHealth {
  ok: boolean;
  checkedAt: ISODate;
  platform: string;
  checks: RunnerCheck[];
  /** Ids of checks whose program is being installed on the runner right now (its first start, or an Install click). */
  installing?: string[];
}

/** POST /api/runners/:id/health/fix */
export interface RunnerFixResult {
  ok: boolean;
  output: string;
  health: RunnerHealth;
}

/** POST /api/runners/:id/autofix */
export interface RunnerAutofixInput {
  /** The check to fix; omitted = everything that fails. */
  checkId?: string;
  /** What the human noticed, in their words. */
  note?: string;
}

/* base64url without Buffer, so the same code runs in the browser and in Bun (same approach as the phone pairing link in mobile.ts). */

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

function encode(prefix: string, payload: unknown): string {
  return prefix + base64url(utf8(JSON.stringify(payload)));
}

/**
 * The JSON object behind a pasted code or offer. Terminals and chat apps wrap long lines and copy the breaks along, so
 * all whitespace is dropped before reading it.
 */
function decode(prefix: string, text: string): Record<string, unknown> | null {
  const compact = text.replace(/\s+/g, "");
  if (!compact.startsWith(prefix)) return null;
  const json = fromBase64url(compact.slice(prefix.length));
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function encodeRunnerCode(code: RunnerPairingCode): string {
  return encode(RUNNER_CODE_PREFIX, code);
}

/** Reads a pasted pairing code; null when it isn't one. Whether it has expired is for the caller to check (`exp`). */
export function parseRunnerCode(text: string): RunnerPairingCode | null {
  const p = decode(RUNNER_CODE_PREFIX, text);
  if (!p || p.v !== 1) return null;
  const { name, hostname, addresses, port, key, id, secret, exp } = p;
  if (!isText(name) || !isText(hostname) || !isTextList(addresses) || !isPort(port)) return null;
  if (!isText(key) || !isText(id) || !isText(secret) || !isTime(exp)) return null;
  return { v: 1, name, hostname, addresses, port, key, id, secret, exp };
}

export function encodeRunnerOffer(offer: RunnerPairingOfferPayload): string {
  return encode(RUNNER_OFFER_PREFIX, offer);
}

/** Reads the pairing offer from an install command; null when it isn't one. Expiry is for the caller to check (`exp`). */
export function parseRunnerOffer(text: string): RunnerPairingOfferPayload | null {
  const p = decode(RUNNER_OFFER_PREFIX, text);
  if (!p || p.v !== 1) return null;
  const { id, token, urls, name, exp } = p;
  if (!isText(id) || !isText(token) || !isTextList(urls) || !isText(name) || !isTime(exp)) return null;
  return { v: 1, id, token, urls, name, exp };
}

/** `runner:<id>:<view>` → { runnerId, view }; null for a local view. */
export function parseRunnerView(view: string): { runnerId: string; view: string } | null {
  if (!view.startsWith(RUNNER_VIEW_PREFIX)) return null;
  const rest = view.slice(RUNNER_VIEW_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split === rest.length - 1) return null;
  return { runnerId: rest.slice(0, split), view: rest.slice(split + 1) };
}

export function runnerView(runnerId: string, view: string): string {
  return `${RUNNER_VIEW_PREFIX}${runnerId}:${view}`;
}
