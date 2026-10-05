/**
 * Godmode Cloud: an optional account service (apps/cloud). A Godmode that is linked to a cloud account keeps one
 * outbound WebSocket (the "cloud link") open to it. The cloud relays browser and phone requests through that socket,
 * so the computer can be reached without Tailscale and without opening a port. Nothing here is needed to use Godmode:
 * an unlinked computer never talks to the cloud.
 *
 * This file is the contract between the core (packages/core/src/cloud) and the cloud (apps/cloud): settings, status,
 * the link and device APIs, and the framing of the cloud link. It must stay runtime-neutral (no Node/Bun/DOM APIs
 * at module level), because the phone app compiles `@godmode/shared` from source.
 */
import type { ISODate } from "./models";

/* ------------------------------------------------------------------ */
/* Settings and status on the computer                                  */
/* ------------------------------------------------------------------ */

export interface CloudSettings {
  /** Keep the cloud link up. Set by linking; turn off to pause without unlinking. */
  enabled: boolean;
  /** People signed in to the cloud account may open this computer's dashboard in a browser. */
  browserAccess: boolean;
  /** Paired phones may reach this computer through the cloud gateway (no Tailscale needed). */
  phoneAccess: boolean;
  /** Unlocking the vault, revealing secrets and backups are allowed through the cloud. Off unless turned on here. */
  allowSecrets: boolean;
}

export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
  enabled: false,
  browserAccess: true,
  phoneAccess: true,
  allowSecrets: false,
};

/**
 * Cloud address offered in the link dialog. Empty means "ask": the person types the address of their cloud.
 * The core lets `GODMODE_CLOUD_URL` override it.
 */
export const CLOUD_DEFAULT_URL = "";

export type CloudLinkState =
  /** Not linked to any account. */
  | "unlinked"
  /** Waiting for the person to approve the link in the browser. */
  | "linking"
  /** Linked; dialing or re-dialing the cloud. */
  | "connecting"
  /** Linked and reachable through the cloud. */
  | "online"
  /** Linked, but the cloud can't be reached right now. */
  | "offline"
  /** Linked, link turned off on this computer. */
  | "paused"
  /** Linked, but the account's plan doesn't allow this computer (plan limit, subscription lapsed). */
  | "blocked"
  /** The cloud no longer knows this computer (removed in the cloud). Link again to reconnect. */
  | "revoked";

export interface CloudAccount {
  email: string;
  name: string | null;
}

export interface CloudPlanLimits {
  /** Computers one account may link. null: no limit. */
  maxDevices: number | null;
  /** Relay traffic per calendar month in GB. null: no limit. */
  relayGbPerMonth: number | null;
  /** Dashboard in the browser. */
  browserAccess: boolean;
  /** Phones through the gateway. */
  phoneGateway: boolean;
  /** Sharing a computer with other accounts. */
  sharing: boolean;
}

export interface CloudPlanSummary {
  id: string;
  name: string;
  limits: CloudPlanLimits;
}

export interface CloudPendingLink {
  /** Short code shown on both sides so the person can check they approve the right computer, e.g. "KQZM-7HPD". */
  userCode: string;
  /** Page to open in the browser to approve. */
  verifyUrl: string;
  expiresAt: ISODate;
}

/** GET /api/cloud (core) */
export interface CloudStatus {
  state: CloudLinkState;
  /** Cloud this computer is linked (or linking) to, e.g. "https://cloud.example.com". */
  url: string | null;
  /** Address offered in the link dialog. */
  defaultUrl: string;
  deviceId: string | null;
  account: CloudAccount | null;
  linkedAt: ISODate | null;
  connectedSince: ISODate | null;
  /** Why the link is down or blocked, in words for a human. */
  error: string | null;
  pending: CloudPendingLink | null;
  /** Where a browser opens this computer: `<url>/d/<deviceId>/`. */
  browserUrl: string | null;
  /** Base address phones use: `<url>/gw/<deviceId>`. */
  gatewayUrl: string | null;
  plan: CloudPlanSummary | null;
  settings: CloudSettings;
}

/* ------------------------------------------------------------------ */
/* Billing, as the computer sees it                                     */
/* ------------------------------------------------------------------ */

export type CloudSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface CloudSubscription {
  status: CloudSubscriptionStatus;
  interval: "month" | "year" | null;
  /** Price per interval in the currency's minor unit (cents). */
  amount: number | null;
  currency: string | null;
  currentPeriodEnd: ISODate | null;
  /** Ends at `currentPeriodEnd` instead of renewing. */
  cancelAtPeriodEnd: boolean;
  trialEnd: ISODate | null;
}

export interface CloudUsage {
  periodStart: ISODate;
  periodEnd: ISODate;
  devices: { used: number; limit: number | null };
  /** Bytes relayed for this account in the period. */
  relayBytes: { used: number; limit: number | null };
  requests: number;
}

export interface CloudInvoice {
  id: string;
  number: string | null;
  date: ISODate;
  /** Minor units. */
  total: number;
  currency: string;
  status: string;
  /** Hosted invoice page. */
  url: string | null;
  pdf: string | null;
}

/** GET <cloud>/api/device/v1/billing, and GET /api/cloud/billing on the core. */
export interface CloudBilling {
  /** The cloud sells plans. When false, every account has everything and there is nothing to pay. */
  billingEnabled: boolean;
  plan: CloudPlanSummary;
  subscription: CloudSubscription | null;
  usage: CloudUsage;
  invoices: CloudInvoice[];
  /** Pages in the cloud, opened in the browser. */
  urls: { billing: string; devices: string; account: string };
}

/** GET /api/usage (core): what the agents on this computer used, from its own run history. */
export interface UsageSummary {
  from: ISODate;
  to: ISODate;
  runs: number;
  /** As reported by Claude Code. With a Claude subscription this is an equivalent, not a charge. */
  costUsd: number;
  durationMs: number;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  byDay: { day: string; runs: number; costUsd: number }[];
  byModel: { model: string; runs: number; costUsd: number }[];
}

/* ------------------------------------------------------------------ */
/* Link API (computer → cloud, before it has a device id)               */
/* ------------------------------------------------------------------ */

export const CLOUD_LINK_START_PATH = "/api/link/v1/start";
export const CLOUD_LINK_POLL_PATH = "/api/link/v1/poll";
export const CLOUD_DEVICE_API_PATH = "/api/device/v1";

/** The link secret is made on the computer and never leaves it except as a bearer token over TLS. */
export const CLOUD_SECRET_PREFIX = "gml_";

/** POST <cloud>/api/link/v1/start */
export interface CloudLinkStartRequest {
  /** The computer's stable instance id (`gm_…`). */
  instanceId: string;
  name: string;
  platform: string;
  version: string;
  /** SHA-256 (hex) of the link secret. The cloud only ever stores this hash. */
  secretHash: string;
}

export interface CloudLinkStartResponse {
  requestId: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: ISODate;
  /** Seconds between polls. */
  interval: number;
}

/** POST <cloud>/api/link/v1/poll, with `Authorization: Bearer <link secret>`. */
export interface CloudLinkPollRequest {
  requestId: string;
}

export type CloudLinkPollResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; deviceId: string; account: CloudAccount };

/** `Authorization: Bearer <deviceId>.<link secret>` on the device API and on the cloud link. */
export function cloudBearer(deviceId: string, secret: string): string {
  return `${deviceId}.${secret}`;
}

export function parseCloudBearer(value: string): { deviceId: string; secret: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const deviceId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!CLOUD_DEVICE_ID.test(deviceId) || !secret.startsWith(CLOUD_SECRET_PREFIX)) return null;
  return { deviceId, secret };
}

/* ------------------------------------------------------------------ */
/* Addresses in the cloud                                               */
/* ------------------------------------------------------------------ */

/** WebSocket the computer dials. */
export const CLOUD_CONNECT_PATH = "/relay/v1/connect";
/** `<cloud>/d/<deviceId>/…`: the dashboard of one computer, for signed-in cloud users. */
export const CLOUD_BROWSER_PREFIX = "/d";
/** `<cloud>/gw/<deviceId>/api/…`: the gateway for paired phones, which bring their own device token. */
export const CLOUD_GATEWAY_PREFIX = "/gw";
/** Static files of the dashboard build the cloud serves. */
export const CLOUD_UI_PREFIX = "/ui";

export const CLOUD_DEVICE_ID = /^dvc_[A-Za-z0-9]{16}$/;

export function cloudBrowserUrl(cloudUrl: string, deviceId: string): string {
  return `${cloudUrl.replace(/\/+$/, "")}${CLOUD_BROWSER_PREFIX}/${deviceId}/`;
}

export function cloudGatewayUrl(cloudUrl: string, deviceId: string): string {
  return `${cloudUrl.replace(/\/+$/, "")}${CLOUD_GATEWAY_PREFIX}/${deviceId}`;
}

/**
 * What the cloud puts into the dashboard's index.html as `<meta name="godmode-cloud" content="…JSON…">` when it
 * serves the UI for one computer. Its presence switches the UI to cloud mode.
 */
export interface CloudUiContext {
  deviceId: string;
  deviceName: string;
  /** Path prefix of this computer in the cloud, e.g. "/d/dvc_abc". API calls go to `<base>/api/…`. */
  base: string;
  /** Cloud page that lists computers. */
  home: string;
  /** Cloud sign-in page; the UI appends `?next=<path>`. */
  login: string;
  /** Cloud billing page. */
  billing: string;
  /** What this person may do on this computer. */
  role: CloudAccessRole;
  /** Version of the dashboard build the cloud serves (apps/desktop package version). */
  uiVersion: string;
}

export const CLOUD_UI_META = "godmode-cloud";

/* ------------------------------------------------------------------ */
/* Cloud link framing                                                   */
/* ------------------------------------------------------------------ */

/**
 * The cloud link is one WebSocket carrying many streams. Every message is a binary frame:
 *
 *   byte 0      frame type (CloudFrame)
 *   bytes 1..4  stream id, unsigned 32-bit big-endian (0 for link-level frames)
 *   bytes 5..   payload: UTF-8 JSON, UTF-8 text or raw bytes, depending on the type
 *
 * The cloud opens streams (an HTTP request or a WebSocket of a browser or phone). Each link starts its counter at a
 * random value in 1..2^30 and never reuses an id on that link. Everything a side knows about a stream belongs to the
 * one connection it arrived on; frames from a socket that is no longer the current link are ignored.
 *
 * HTTP stream. Cloud: ReqHead, then only if `hasBody`: ReqBody* and exactly one ReqEnd. `hasBody` is true iff the
 * method is not GET/HEAD and the client sent transfer-encoding or a content-length above 0. Computer: dispatches at
 * ReqHead without waiting for the body; answers ResHead, ResBody*, and always exactly one ResEnd (also for HEAD, 204,
 * 304 and empty bodies); it may answer before the request body is complete.
 *
 * A stream is over at ResEnd, at Abort in either direction, and when the link closes — on both sides: remove it from
 * the table and `close()` both of its windows. The cloud then stops forwarding the client's body (and adds
 * `connection: close` if the body was not fully forwarded); the computer errors the request-body stream, aborts the
 * request's signal and cancels the response-body reader. Abort from the computer before ResHead is a 502 for the
 * client; after ResHead the response is destroyed. Abort on a WebSocket stream counts as WsClose 1011.
 *
 * Frames for a stream id that is not open are ignored (they cross on the wire). Only an unknown frame type, an
 * undecodable frame, a frame above CLOUD_FRAME_MAX, or ReqHead/WsOpen for an id that is already open is a protocol
 * error (close CloudClose.Protocol).
 *
 * Flow control. HTTP bodies, both ways: at most CLOUD_CHUNK per frame, under a CloudWindow of CLOUD_WINDOW bytes;
 * the reader grants credit (Window) only after bytes were handed on, using CloudCredit. A receiver that gets more
 * than CLOUD_WINDOW ungranted body bytes on one stream closes the link with Protocol. WebSocket messages
 * computer → client: the cloud grants Window credit for WsText/WsBinary payload bytes it has written out to the
 * client (CLOUD_WS_WINDOW, CloudCredit(CLOUD_WS_WINDOW / 4)); the computer counts unacknowledged bytes and drops
 * live-view frames above CLOUD_WS_WINDOW and closes the socket (1013) above CLOUD_WS_BACKLOG_MAX; more than
 * CLOUD_WS_BACKLOG_MAX ungranted bytes on one socket is a protocol error. Client → computer messages are at most
 * CLOUD_WS_CLIENT_MESSAGE_MAX bytes and are not windowed.
 */
export const CLOUD_PROTOCOL = 1;

export const CloudFrame = {
  /** cloud → computer. JSON CloudReqHead. */
  ReqHead: 0x01,
  /** cloud → computer. Bytes. Counts against the window. */
  ReqBody: 0x02,
  /** cloud → computer. Empty. */
  ReqEnd: 0x03,
  /** computer → cloud. JSON CloudResHead. */
  ResHead: 0x04,
  /** computer → cloud. Bytes. Counts against the window. */
  ResBody: 0x05,
  /** computer → cloud. Empty. */
  ResEnd: 0x06,
  /** Either way. JSON CloudAbort. The stream is gone: the reader left, or the sender failed. */
  Abort: 0x07,
  /**
   * Payload: unsigned 32-bit big-endian byte count the peer may send in addition. HTTP stream: either way, credit
   * for body bytes. WebSocket stream: cloud → computer only, for WsText/WsBinary payload bytes written to the client.
   */
  Window: 0x08,
  /** cloud → computer. JSON CloudWsOpen. */
  WsOpen: 0x10,
  /** computer → cloud. Empty. */
  WsAccept: 0x11,
  /** computer → cloud. JSON CloudWsReject. */
  WsReject: 0x12,
  /** Either way. UTF-8 text message. */
  WsText: 0x13,
  /** Either way. Binary message. */
  WsBinary: 0x14,
  /** Either way. JSON CloudWsClose. */
  WsClose: 0x15,
  /** Either way, stream 0. Empty. Answered with Pong. */
  Ping: 0x20,
  /** Either way, stream 0. Empty. */
  Pong: 0x21,
  /**
   * computer → cloud, stream 0. JSON CloudHello. The first frame of a link; sent again (not answered) whenever the
   * computer's name or access switches change, never before Welcome. The cloud updates its record with the newest at
   * most every 10 s; more than 10 Hellos in a minute is a protocol error.
   */
  Hello: 0x30,
  /** cloud → computer, stream 0, answer to Hello. JSON CloudWelcome. */
  Welcome: 0x31,
  /** cloud → computer, stream 0. JSON CloudNotice. */
  Notice: 0x32,
} as const;

export type CloudFrameType = (typeof CloudFrame)[keyof typeof CloudFrame];

/** Bytes before the payload of a frame. */
export const CLOUD_FRAME_HEADER = 5;
/** Largest payload of one frame. Larger frames are a protocol error and close the link. */
export const CLOUD_FRAME_MAX = 16 * 1024 * 1024;
/** Body chunk size. */
export const CLOUD_CHUNK = 64 * 1024;
/** Bytes a side may send on a fresh HTTP stream before it needs a Window frame. */
export const CLOUD_WINDOW = 1024 * 1024;
/** A relayed WebSocket message from the computer (one WsText/WsBinary frame) may not be larger than this. */
export const CLOUD_WS_MESSAGE_MAX = CLOUD_FRAME_MAX;
/** Unacknowledged bytes of WebSocket messages computer → client before live-view frames are skipped. */
export const CLOUD_WS_WINDOW = 2 * 1024 * 1024;
/** Unacknowledged (computer) or unsent (cloud, `bufferedAmount`) bytes after which a relayed socket is closed, 1013. */
export const CLOUD_WS_BACKLOG_MAX = 16 * 1024 * 1024;
/** Largest message a browser or phone may send through a relayed WebSocket. */
export const CLOUD_WS_CLIENT_MESSAGE_MAX = 64 * 1024;
/** Request bodies the computer accepts through the link, whatever the cloud allows. */
export const CLOUD_BODY_MAX = 256 * 1024 * 1024;
/** Streams of channel "mobile" that may be open at once on one link (of at most CLOUD_STREAMS_MAX). */
export const CLOUD_MOBILE_STREAMS_MAX = 64;
export const CLOUD_STREAMS_MAX = 256;
/** Send a Ping when nothing was sent for this long. */
export const CLOUD_PING_MS = 20_000;
/** The link is dead when nothing arrived for this long. */
export const CLOUD_DEAD_MS = 60_000;

/** Close codes of the cloud link. */
export const CloudClose = {
  Protocol: 4400,
  /** Unknown computer or wrong secret. The computer stops dialing and shows "revoked". */
  BadCredential: 4401,
  /** The account's plan doesn't allow this computer right now. The computer retries slowly and shows "blocked". */
  PlanRequired: 4402,
  /** Turned off in the cloud by an admin or the owner, or the owner's account is suspended. Retry slowly. */
  Disabled: 4403,
  /** The same computer connected again; the older link is closed. Back off 30 s, doubling to 5 min. */
  Replaced: 4409,
  /** Retry after 60 s. */
  RateLimited: 4429,
} as const;
// Internal errors in the cloud close the link with 1011 (normal backoff). BadCredential is sent only when the
// lookup ran and says the computer does not exist or the secret is wrong.

/** Who is behind a relayed request. "cloud": a signed-in cloud user's browser. "mobile": a paired phone. */
export type CloudChannel = "cloud" | "mobile";

/** What a cloud user may do on one computer. Owner and operator: everything the cloud is allowed. Viewer: read only. */
export type CloudAccessRole = "owner" | "operator" | "viewer";

export interface CloudRelayUser {
  id: string;
  email: string;
  name: string | null;
  role: CloudAccessRole;
}

export type CloudHeaders = [name: string, value: string][];

export interface CloudReqHead {
  method: string;
  /** Path and query as the computer sees it, always starting with "/api/". */
  path: string;
  headers: CloudHeaders;
  channel: CloudChannel;
  /** Set on the "cloud" channel. */
  user: CloudRelayUser | null;
  /** Address of the browser or phone as the cloud saw it. */
  ip: string | null;
  /** ReqBody frames follow. */
  hasBody: boolean;
}

export interface CloudResHead {
  status: number;
  headers: CloudHeaders;
}

export interface CloudAbort {
  reason: string;
}

export interface CloudWsOpen {
  /** Always "/api/ws" today. */
  path: string;
  headers: CloudHeaders;
  channel: CloudChannel;
  user: CloudRelayUser | null;
  ip: string | null;
}

export interface CloudWsReject {
  status: number;
  message: string;
}

export interface CloudWsClose {
  code: number;
  reason: string;
}

export interface CloudHello {
  protocol: number;
  version: string;
  instanceId: string;
  name: string;
  platform: string;
  browserAccess: boolean;
  phoneAccess: boolean;
}

export interface CloudWelcome {
  deviceId: string;
  account: CloudAccount;
  plan: CloudPlanSummary;
  /** The cloud's public address. */
  publicUrl: string;
  limits: { maxBodyBytes: number };
  serverTime: ISODate;
}

export type CloudNotice =
  /** The plan or its limits changed. */
  | { type: "plan"; plan: CloudPlanSummary }
  | { type: "account"; account: CloudAccount }
  /** Subscription or invoices changed; refetch billing. */
  | { type: "billing" };

export interface CloudFrameData {
  type: number;
  stream: number;
  payload: Uint8Array;
}

const HEADER = CLOUD_FRAME_HEADER;

// Present in Bun, Node and browsers. Declared here because this package compiles without DOM or Node typings.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Builds one frame. A string payload is sent as UTF-8; binary as is; any other object as JSON. */
export function encodeCloudFrame(
  type: CloudFrameType,
  stream: number,
  payload?: Uint8Array | ArrayBuffer | string | object | null,
): Uint8Array<ArrayBuffer> {
  const body =
    payload == null
      ? null
      : payload instanceof Uint8Array
        ? payload
        : payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : utf8Encode(typeof payload === "string" ? payload : JSON.stringify(payload));
  const frame = new Uint8Array(new ArrayBuffer(HEADER + (body ? body.byteLength : 0)));
  frame[0] = type;
  frame[1] = (stream >>> 24) & 0xff;
  frame[2] = (stream >>> 16) & 0xff;
  frame[3] = (stream >>> 8) & 0xff;
  frame[4] = stream & 0xff;
  if (body) frame.set(body, HEADER);
  return frame;
}

/** Null for anything that is not a frame (too short, too large). The payload is a view into `data`, not a copy. */
export function decodeCloudFrame(data: Uint8Array): CloudFrameData | null {
  if (data.byteLength < HEADER || data.byteLength > HEADER + CLOUD_FRAME_MAX) return null;
  const stream = ((data[1]! << 24) | (data[2]! << 16) | (data[3]! << 8) | data[4]!) >>> 0;
  return { type: data[0]!, stream, payload: data.subarray(HEADER) };
}

export function cloudFrameText(frame: CloudFrameData): string {
  return utf8Decode(frame.payload);
}

/** Null when the payload is not a JSON object. */
export function cloudFrameJson<T>(frame: CloudFrameData): T | null {
  try {
    const value: unknown = JSON.parse(utf8Decode(frame.payload));
    return value && typeof value === "object" ? (value as T) : null;
  } catch {
    return null;
  }
}

export function encodeCloudWindow(stream: number, bytes: number): Uint8Array<ArrayBuffer> {
  const n = Math.max(0, Math.min(0xffffffff, Math.floor(bytes)));
  return encodeCloudFrame(CloudFrame.Window, stream, new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]));
}

export function decodeCloudWindow(frame: CloudFrameData): number {
  const p = frame.payload;
  if (p.byteLength < 4) return 0;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

/**
 * Send credit of one direction of one stream. The sender awaits `take(n)` before each body chunk; a Window frame
 * from the reader calls `grant(n)`. `close()` rejects everyone still waiting (the stream ended or was aborted).
 */
export class CloudWindow {
  private credit: number;
  private waiting: { need: number; resolve: () => void; reject: (err: Error) => void }[] = [];
  private closed: Error | null = null;

  constructor(initial: number = CLOUD_WINDOW) {
    this.credit = initial;
  }

  take(bytes: number): Promise<void> {
    // A larger take could wait forever: the reader grants in steps of a quarter window.
    if (bytes > CLOUD_CHUNK) throw new RangeError(`take(${bytes}) is larger than CLOUD_CHUNK; slice the body first.`);
    if (this.closed) return Promise.reject(this.closed);
    if (this.waiting.length === 0 && this.credit >= bytes) {
      this.credit -= bytes;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiting.push({ need: bytes, resolve, reject }));
  }

  grant(bytes: number): void {
    this.credit += bytes;
    while (this.waiting.length && this.credit >= this.waiting[0]!.need) {
      const next = this.waiting.shift()!;
      this.credit -= next.need;
      next.resolve();
    }
  }

  close(reason = "Stream closed"): void {
    if (this.closed) return;
    this.closed = new Error(reason);
    for (const w of this.waiting.splice(0)) w.reject(this.closed);
  }
}

/**
 * The reading side of the window: call `consumed(n)` once n body bytes were handed on (written out, not just
 * received). It returns the credit to give back in a Window frame, or 0 while too little has piled up to be worth one.
 */
export class CloudCredit {
  private pending = 0;

  constructor(private readonly threshold: number = CLOUD_WINDOW / 4) {}

  consumed(bytes: number): number {
    this.pending += bytes;
    if (this.pending < this.threshold) return 0;
    const grant = this.pending;
    this.pending = 0;
    return grant;
  }
}

/** Request headers the cloud never passes on to the computer. */
export const CLOUD_DROPPED_REQUEST_HEADERS = [
  // On "cloud" the cloud also drops "authorization"; on "mobile" it is the phone's own device token and passes.
  "cookie",
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "origin",
  "referer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
];

/**
 * The only response headers of a computer the cloud passes on to a browser or phone (compared in lower case), on
 * `/d/…` and `/gw/…` alike. Everything else is dropped: the computer answers on the cloud's own origin and must not
 * set cookies, redirect, clear site data, register reporting endpoints or ask for credentials there.
 */
export const CLOUD_PASSED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-disposition",
  "content-language",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
  "retry-after",
];

/** Content types a relayed response may keep; anything else is sent as application/octet-stream. */
export function isPassableContentType(value: string): boolean {
  const type = value.split(";")[0]!.trim().toLowerCase();
  return (
    type === "application/json" ||
    type === "text/plain" ||
    type === "text/markdown" ||
    type === "text/event-stream" ||
    type === "application/octet-stream" ||
    type === "application/pdf" ||
    type === "application/zip" ||
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/")
  );
}

/** WebSocket close codes the cloud passes on unchanged; any other becomes 1000. Reasons are cut to 123 UTF-8 bytes. */
export function isPassableCloseCode(code: number): boolean {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));
}

/** Error codes the cloud itself answers with on `/d/…` and `/gw/…` (body: `{ error, code }`, like the core's errors). */
export const CloudErrorCode = {
  /** 503. The computer has no cloud link right now. */
  DeviceOffline: "device_offline",
  /** 401, `/d/…` only. No valid cloud session; the UI goes to the sign-in page. Never sent on `/gw/…`. */
  CloudUnauthorized: "cloud_unauthorized",
  /** 403. Signed in, but no access to this computer, or the action is not allowed for the role. */
  CloudForbidden: "cloud_forbidden",
  /** 404. No such computer. */
  DeviceNotFound: "device_not_found",
  /** 402. The plan's relay allowance is used up, or the plan doesn't include this kind of access. */
  PlanLimit: "plan_limit",
  /** 413. */
  BodyTooLarge: "body_too_large",
  /** 429. */
  RateLimited: "rate_limited",
  /** 502. The link dropped while the request was on its way. */
  LinkLost: "link_lost",
  /** 502. The computer sent a response the cloud does not pass on (a redirect, an invalid status or header). */
  BadResponse: "bad_response",
} as const;
