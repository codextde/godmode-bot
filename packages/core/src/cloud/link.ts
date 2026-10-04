/**
 * Linking this computer to a Godmode Cloud account, and keeping the link up. Like mobile/access.ts, every settings
 * change runs a single-flight reconcile that starts, stops or updates the link client. An unlinked computer never
 * talks to any cloud.
 *
 * Linking: the computer makes a secret, sends only its hash to `<cloud>/api/link/v1/start`, shows the code and the
 * approval page, and polls until the person approved it in the browser; then the cloud names the device id and the
 * secret becomes the link's credential (`<deviceId>.<secret>` as bearer).
 */
import {
  CLOUD_DEFAULT_URL,
  CLOUD_DEVICE_ID,
  CLOUD_LINK_POLL_PATH,
  CLOUD_LINK_START_PATH,
  CLOUD_PROTOCOL,
  CLOUD_SECRET_PREFIX,
  cloudBrowserUrl,
  cloudGatewayUrl,
  type CloudAccount,
  type CloudHello,
  type CloudLinkPollResponse,
  type CloudLinkStartRequest,
  type CloudLinkStartResponse,
  type CloudLinkState,
  type CloudNotice,
  type CloudRelayUser,
  type CloudSettings,
  type CloudStatus,
  type CloudWelcome,
} from "@godmode/shared";
import { bus } from "../events/bus";
import { logger } from "../log";
import { instanceInfo } from "../mobile/devices";
import { audit } from "../services/audit";
import { notify } from "../services/notifications";
import { getSettings, updateSettings } from "../services/settings";
import { sha256 } from "../vault/crypto";
import { HttpError, badRequest, conflict, now, randomToken } from "../util";
import { cloudHost, cloudRequest, deleteCloudDevice } from "./api";
import { CloudClient, LINK_REVOKED, type CloudClientState, type CloudWebSocketCtor } from "./client";
import type { CloudHandler } from "./dispatch";
import {
  clearLink,
  deleteLinkSecret,
  loadLink,
  readLinkSecret,
  saveLink,
  setCloudOnline,
  setLinkAccount,
  setLinkPlan,
  setLinkRevoked,
  writeLinkSecret,
} from "./state";

const log = logger("cloud");

interface PendingLink {
  url: string;
  secret: string;
  requestId: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
  /** Seconds between polls. */
  interval: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let handler: CloudHandler | null = null;
let client: CloudClient | null = null;
let clientKey = "";
let live: { state: CloudClientState; error: string | null; since: string | null } = { state: "connecting", error: null, since: null };
let pending: PendingLink | null = null;
/** Why the last link attempt ended without a link (declined, expired). */
let linkError: string | null = null;
let offBus: (() => void) | null = null;
let refreshing: Promise<void> | null = null;
let again = false;
let transport: { WebSocket?: CloudWebSocketCtor } = {};
/** user id → the day (UTC) their use of this computer was last announced. */
const announced = new Map<string, string>();

export function defaultCloudUrl(): string {
  return process.env.GODMODE_CLOUD_URL || CLOUD_DEFAULT_URL;
}

/** The cloud's origin. https only, except http on this machine (development). */
export function normalizeCloudUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw badRequest("Enter the address of your Godmode Cloud, for example https://cloud.example.com.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
  if (url.username || url.password) throw badRequest("The cloud address can't contain a user name or password.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw badRequest("The cloud address must start with https://.");
  return url.origin;
}

function validAccount(value: unknown): value is CloudAccount {
  const a = value as CloudAccount | null;
  return !!a && typeof a === "object" && typeof a.email === "string" && (a.name === null || typeof a.name === "string");
}

function account(a: CloudAccount): CloudAccount {
  return { email: a.email.slice(0, 320), name: a.name?.slice(0, 200) ?? null };
}

export function cloudStatus(): CloudStatus {
  const settings = { ...getSettings().cloud };
  const base = { defaultUrl: defaultCloudUrl(), settings };
  if (pending) {
    return {
      ...base,
      state: "linking",
      url: pending.url,
      deviceId: null,
      account: null,
      linkedAt: null,
      connectedSince: null,
      error: null,
      pending: { userCode: pending.userCode, verifyUrl: pending.verifyUrl, expiresAt: pending.expiresAt },
      browserUrl: null,
      gatewayUrl: null,
      plan: null,
    };
  }
  const link = loadLink();
  if (!link) {
    return { ...base, state: "unlinked", url: null, deviceId: null, account: null, linkedAt: null, connectedSince: null, error: linkError, pending: null, browserUrl: null, gatewayUrl: null, plan: null };
  }
  const state: CloudLinkState = link.revoked ? "revoked" : !settings.enabled ? "paused" : live.state;
  return {
    ...base,
    state,
    url: link.url,
    deviceId: link.deviceId,
    account: link.account,
    linkedAt: link.linkedAt || null,
    connectedSince: state === "online" ? live.since : null,
    error: state === "revoked" ? (live.error ?? LINK_REVOKED) : state === "paused" ? null : live.error,
    pending: null,
    browserUrl: cloudBrowserUrl(link.url, link.deviceId),
    gatewayUrl: cloudGatewayUrl(link.url, link.deviceId),
    plan: link.plan,
  };
}

/* ------------------------------------------------------------------ */
/* Linking                                                              */
/* ------------------------------------------------------------------ */

export async function startLinking(input: string): Promise<CloudStatus> {
  const url = normalizeCloudUrl(input);
  const link = loadLink();
  if (link && !link.revoked) throw conflict("This computer is already linked to Godmode Cloud. Unlink it first.");
  cancelLinking();
  linkError = null;
  const secret = CLOUD_SECRET_PREFIX + randomToken(32);
  const instance = instanceInfo();
  const request: CloudLinkStartRequest = {
    instanceId: instance.id,
    name: instance.name,
    platform: instance.platform,
    version: instance.version,
    secretHash: sha256(secret),
  };
  const res = await cloudRequest<CloudLinkStartResponse>(url, CLOUD_LINK_START_PATH, {
    method: "POST",
    body: request,
    unreachable: `Couldn't reach ${cloudHost(url)}. Check the address and this computer's internet connection.`,
  });
  if (typeof res.requestId !== "string" || typeof res.userCode !== "string" || typeof res.verifyUrl !== "string" || typeof res.expiresAt !== "string") {
    throw new HttpError(502, "Godmode Cloud sent an answer this Godmode can't read. Update Godmode.", "cloud_error");
  }
  let verify: URL | null = null;
  try {
    verify = new URL(res.verifyUrl);
  } catch {
    /* checked below */
  }
  // The UI opens this page; it must be the cloud the person typed, not a page somewhere else.
  if (!verify || verify.origin !== url) throw new HttpError(502, "The cloud sent an approval page on another site. Check the cloud address.", "cloud_error");
  const interval = Number.isFinite(res.interval) ? Math.min(60, Math.max(1, Math.round(res.interval))) : 5;
  pending = {
    url,
    secret,
    requestId: res.requestId,
    userCode: res.userCode.slice(0, 32),
    verifyUrl: verify.toString(),
    expiresAt: res.expiresAt,
    interval,
    timer: null,
  };
  schedulePoll(pending);
  bus.changed("cloud");
  return cloudStatus();
}

export function cancelLinking() {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending = null;
  bus.changed("cloud");
}

function schedulePoll(p: PendingLink) {
  p.timer = setTimeout(() => void poll(p), p.interval * 1000);
  p.timer.unref?.();
}

async function poll(p: PendingLink) {
  if (pending !== p) return;
  p.timer = null;
  const expires = Date.parse(p.expiresAt);
  if (Number.isFinite(expires) && Date.now() > expires) return endLinking(p, "The link request expired. Start again.");
  let result: CloudLinkPollResponse;
  try {
    result = await cloudRequest<CloudLinkPollResponse>(p.url, CLOUD_LINK_POLL_PATH, { method: "POST", body: { requestId: p.requestId }, bearer: p.secret });
  } catch (err) {
    // The cloud may be restarting: keep asking until the request expires.
    log.debug("link poll failed", err);
    if (pending === p) schedulePoll(p);
    return;
  }
  if (pending !== p) return;
  switch (result.status) {
    case "pending":
      schedulePoll(p);
      return;
    case "approved":
      return finishLinking(p, result.deviceId, result.account);
    case "denied":
      return endLinking(p, "The link was declined in Godmode Cloud.");
    default:
      return endLinking(p, "The link request expired. Start again.");
  }
}

function endLinking(p: PendingLink, error: string) {
  if (pending !== p) return;
  pending = null;
  linkError = error;
  bus.changed("cloud");
}

function finishLinking(p: PendingLink, deviceId: unknown, who: unknown) {
  if (typeof deviceId !== "string" || !CLOUD_DEVICE_ID.test(deviceId) || !validAccount(who)) {
    return endLinking(p, "Godmode Cloud sent an answer this Godmode can't read. Update Godmode.");
  }
  pending = null;
  linkError = null;
  stopClient();
  writeLinkSecret(p.secret);
  saveLink({ url: p.url, deviceId, account: account(who), linkedAt: now() });
  audit("user", "cloud.link", deviceId, { url: p.url, email: who.email });
  notify("success", "Linked to Godmode Cloud", `${who.email} can now open this computer at ${cloudHost(p.url)}.`, "/settings/cloud");
  // Turning the link on reconciles through the settings change.
  updateSettings({ cloud: { enabled: true } });
  bus.changed("cloud");
  void refreshCloudLink();
}

/** Forget the link: every relayed socket and request ends at once, and the cloud is told (best effort). */
export function unlink(): CloudStatus {
  cancelLinking();
  const link = loadLink();
  if (!link) return cloudStatus();
  const secret = readLinkSecret();
  stopClient();
  deleteLinkSecret();
  clearLink();
  linkError = null;
  updateSettings({ cloud: { enabled: false } });
  audit("user", "cloud.unlink", link.deviceId, { url: link.url });
  bus.changed("cloud");
  bus.changed("mobile");
  if (secret && !link.revoked) {
    deleteCloudDevice(link.url, link.deviceId, secret).catch((err: unknown) =>
      log.info("could not tell the cloud about the unlink", { error: err instanceof Error ? err.message : String(err) }),
    );
  }
  return cloudStatus();
}

export function updateCloudSettings(patch: Partial<CloudSettings>): CloudStatus {
  updateSettings({ cloud: patch });
  audit("user", "cloud.settings", null, patch);
  void refreshCloudLink();
  return cloudStatus();
}

/* ------------------------------------------------------------------ */
/* The link client                                                      */
/* ------------------------------------------------------------------ */

export function startCloudLink(h: CloudHandler) {
  handler = h;
  // Every settings change (phone access, the cloud switches, the name) may change what the link says or allows.
  offBus ??= bus.on((event) => {
    if (event.type === "entity.changed" && event.entity === "settings") void refreshCloudLink();
  });
  void refreshCloudLink();
}

export function stopCloudLink() {
  offBus?.();
  offBus = null;
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
  stopClient();
  handler = null;
}

export function refreshCloudLink(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      // Never inside the settings write that triggered us.
      await Promise.resolve();
      reconcile();
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Tests: dial the cloud with another WebSocket implementation (null restores Bun's). */
export function setCloudTransportOverride(override: { WebSocket?: CloudWebSocketCtor } | null) {
  transport = override ?? {};
}

/** The running link client (tests and diagnostics). */
export function cloudLinkClient(): CloudClient | null {
  return client;
}

function reconcile() {
  const link = loadLink();
  const settings = getSettings();
  if (!handler || !link || link.revoked || !settings.cloud.enabled) {
    stopClient();
    return;
  }
  const secret = readLinkSecret();
  if (!secret) {
    // The credential is gone (deleted by hand?): the cloud can't be reached with this link any more.
    stopClient();
    setLinkRevoked();
    live = { state: "revoked", error: "This computer's link key is missing. Link it again under Settings → Cloud.", since: null };
    bus.changed("cloud");
    return;
  }
  const key = `${link.url}|${link.deviceId}|${sha256(secret)}`;
  if (client && clientKey !== key) stopClient();
  if (!client) {
    clientKey = key;
    live = { state: "connecting", error: null, since: null };
    client = new CloudClient({
      url: link.url,
      deviceId: link.deviceId,
      secret,
      handler,
      hello,
      onWelcome,
      onNotice,
      onState,
      onCloudUse: announceCloudUse,
      WebSocketImpl: transport.WebSocket,
    });
    client.start();
    return;
  }
  if (!settings.cloud.browserAccess) client.closeSockets("cloud", 1008, "Browser access was turned off on this computer.");
  if (!settings.cloud.phoneAccess || !settings.mobile.enabled) client.closeSockets("mobile", 1001, "Phone access through Godmode Cloud was turned off.");
  client.refreshHello();
}

function stopClient() {
  if (!client) return;
  const wasOnline = client.online;
  client.stop();
  client = null;
  clientKey = "";
  live = { state: "connecting", error: null, since: null };
  setCloudOnline(false);
  if (wasOnline) {
    bus.changed("cloud");
    bus.changed("mobile");
  }
}

function hello(): CloudHello {
  const settings = getSettings();
  const instance = instanceInfo();
  return {
    protocol: CLOUD_PROTOCOL,
    version: instance.version,
    instanceId: instance.id,
    name: instance.name,
    platform: instance.platform,
    browserAccess: settings.cloud.browserAccess,
    // Phones only get through while phone access as a whole is on, too.
    phoneAccess: settings.cloud.phoneAccess && settings.mobile.enabled,
  };
}

function onWelcome(welcome: CloudWelcome) {
  if (validAccount(welcome.account)) setLinkAccount(account(welcome.account));
  if (welcome.plan && typeof welcome.plan === "object") setLinkPlan(welcome.plan);
}

function onNotice(notice: CloudNotice) {
  if (notice.type === "plan" && notice.plan && typeof notice.plan === "object") setLinkPlan(notice.plan);
  if (notice.type === "account" && validAccount(notice.account)) setLinkAccount(account(notice.account));
  bus.changed("cloud");
}

function onState(state: CloudClientState, error: string | null) {
  const wasOnline = live.state === "online";
  live = { state, error, since: state === "online" ? now() : null };
  setCloudOnline(state === "online");
  if (state === "revoked") {
    const link = loadLink();
    setLinkRevoked();
    audit("cloud", "cloud.revoked", link?.deviceId ?? null, { url: link?.url });
    notify("warning", "Godmode Cloud removed this computer", "Link it again under Settings → Cloud to open it from a browser.", "/settings/cloud");
    void refreshCloudLink();
  }
  bus.changed("cloud");
  // Pairing and the phone status depend on the gateway being up.
  if (state === "online" || wasOnline) bus.changed("mobile");
}

/** The first time each day a cloud user uses this computer: an audit entry and a notice on the computer. */
function announceCloudUse(user: CloudRelayUser, ip: string | null) {
  const day = new Date().toISOString().slice(0, 10);
  if (announced.get(user.id) === day) return;
  if (announced.size > 1000) announced.clear();
  announced.set(user.id, day);
  const host = cloudHost(loadLink()?.url ?? "");
  const email = user.email.slice(0, 320);
  audit(`cloud:${email}`, "cloud.use", user.id, { email, role: user.role, ip, cloud: host });
  notify("info", `${email} is controlling this computer through ${host}`, "Turn browser access off under Settings → Cloud to stop this.", "/settings/cloud");
}
