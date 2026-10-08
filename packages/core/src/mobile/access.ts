/**
 * Phones reach Godmode over Tailscale: while phone access is on, a second listener runs on this computer's Tailscale
 * address only (never on the LAN or the internet). It answers the API under /api (no dashboard, no sign-in, no MCP
 * gateway, no webhooks) and only to paired phones; the address is re-checked every 30 s and the listener follows it.
 * A computer linked to Godmode Cloud is also reachable through the cloud's phone gateway (cloud/dispatch.ts), which
 * passes through the same gate (`servePhoneRequest`).
 * A headless server behind an HTTPS reverse proxy can set GODMODE_PHONE_URL instead: the listener then runs on
 * GODMODE_PHONE_HOST (default 0.0.0.0) and only answers requests for that URL's host.
 */
import type { Server, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { isPhoneUrlAllowed, type MobileStatus } from "@godmode/shared";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { newId } from "../util";
import type { WsData } from "../server/ws";
import { isCloudOnline, phoneGatewayUrl } from "../cloud/state";
import { authenticateDevice, cancelPairingOffer, instanceInfo, listDevices } from "./devices";
import { tailscaleStatus } from "./tailscale";

const log = logger("mobile");
const RECHECK_MS = 30_000;
let warnedUrl: string | null = null;

function publicPhoneUrl(): URL | null {
  const url = process.env.GODMODE_PHONE_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  if (url.startsWith("https://") && isPhoneUrlAllowed(url)) return new URL(url);
  if (warnedUrl !== url) log.warn("GODMODE_PHONE_URL must be an https address; ignoring it", { url });
  warnedUrl = url;
  return null;
}

interface Handler {
  app: Hono;
  websocket: WebSocketHandler<WsData>;
}

let handler: Handler | null = null;
let server: Server<WsData> | null = null;
let bound: { ip: string; dnsName: string | null; port: number; requested: number } | null = null;
let hosts = new Set<string>();
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let pending: Promise<void> | null = null;
let again = false;

export function startMobileAccess(h: Handler) {
  handler = h;
  void refreshMobileAccess();
  timer ??= setInterval(() => void refreshMobileAccess(), RECHECK_MS);
  timer.unref?.();
}

export function stopMobileAccess() {
  if (timer) clearInterval(timer);
  timer = null;
  close();
  handler = null;
}

/** Follow the settings and the Tailscale address: start, move or stop the listener. */
export function refreshMobileAccess(): Promise<void> {
  if (pending) {
    again = true;
    return pending;
  }
  pending = (async () => {
    do {
      again = false;
      await reconcile();
    } while (again);
  })().finally(() => {
    pending = null;
  });
  return pending;
}

function close() {
  if (!server) return;
  server.stop(true);
  log.info("stopped listening for phones", { ip: bound?.ip });
  server = null;
  bound = null;
}

async function reconcile() {
  const { enabled, port } = getSettings().mobile;
  if (!enabled || !handler) {
    close();
    cancelPairingOffer();
    lastError = null;
    return;
  }
  const ts = publicPhoneUrl()
    ? { running: true, ip: process.env.GODMODE_PHONE_HOST?.trim() || "0.0.0.0", dnsName: null, detail: null }
    : await tailscaleStatus();
  if (!ts.running || !ts.ip) {
    close();
    lastError = ts.detail ?? "Tailscale isn't connected.";
    return;
  }
  if (bound && bound.ip === ts.ip && bound.requested === port) {
    // A probe that only found the address (the CLI was slow) keeps the name it knew.
    if (ts.dnsName && ts.dnsName !== bound.dnsName) {
      bound.dnsName = ts.dnsName;
      hosts = hostsFor(bound);
    }
    lastError = null;
    return;
  }
  close();
  try {
    const h = handler;
    server = Bun.serve<WsData>({
      hostname: ts.ip,
      port,
      idleTimeout: 120,
      maxRequestBodySize: 64 * 1024 ** 2,
      fetch: (req, srv) => handle(h, req, srv),
      websocket: h.websocket,
    });
    const actual = server.port ?? port;
    bound = { ip: ts.ip, dnsName: ts.dnsName, port: actual, requested: port };
    hosts = hostsFor(bound);
    lastError = null;
    log.info("listening for phones", { url: mobileUrls()[0] });
  } catch (err) {
    server = null;
    bound = null;
    const message = err instanceof Error ? err.message : String(err);
    lastError = /EADDRINUSE|in use/i.test(message)
      ? `Port ${port} is already in use on this computer. Pick another port.`
      : `Couldn't listen for phones: ${message}`;
    log.warn("could not listen for phones", { port, error: message });
  }
}

function hostsFor(b: { ip: string; dnsName: string | null; port: number }): Set<string> {
  const url = publicPhoneUrl();
  if (url) return new Set([url.host.toLowerCase()]);
  return new Set([b.ip, `${b.ip}:${b.port}`, ...(b.dnsName ? [b.dnsName, `${b.dnsName}:${b.port}`] : [])]);
}

function json(status: number, error: string, code: string) {
  return Response.json({ error, code }, { status });
}

function handle(h: Handler, req: Request, srv: Server<WsData>): Response | Promise<Response> | undefined {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!hosts.has(host)) return json(403, "Host not allowed", "host_forbidden");
  const path = new URL(req.url).pathname;
  if (path === "/api/ws") {
    const auth = req.headers.get("authorization") ?? "";
    const address = srv.requestIP(req)?.address;
    const device = auth.startsWith("Bearer ") ? authenticateDevice(auth.slice(7).trim(), address) : null;
    if (!device) return new Response("Unauthorized", { status: 401 });
    const data: WsData = { id: newId("ws"), subscriptions: new Set(), auth: "device", deviceId: device.id };
    return srv.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
  }
  return servePhoneRequest(h.app, req, { server: srv, channel: "mobile" });
}

/**
 * What phones may reach (after the Tailscale listener's Host check, or as relayed by the cloud gateway): the API
 * under /api, without sign-in; `/api/health` names this instance.
 */
export function servePhoneRequest(
  app: { fetch(request: Request, env: object): Response | Promise<Response> },
  req: Request,
  env: object,
): Response | Promise<Response> {
  const path = new URL(req.url).pathname;
  // The phone checks the instance before it sends its token to an address.
  if (path === "/api/health") return Response.json({ ok: true, name: "godmode-bot", instance: instanceInfo().id });
  if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return json(404, "Not found", "not_found");
  return app.fetch(req, env);
}

/** Where phones reach Godmode right now, best first: Tailscale, then the Godmode Cloud gateway. */
export function mobileUrls(): string[] {
  const url = bound ? publicPhoneUrl() : null;
  if (url) return [url.origin];
  const urls = bound ? [...(bound.dnsName ? [`http://${bound.dnsName}:${bound.port}`] : []), `http://${bound.ip}:${bound.port}`] : [];
  const gateway = getSettings().mobile.enabled ? phoneGatewayUrl() : null;
  return gateway ? [...urls, gateway] : urls;
}

export async function mobileStatus(refresh = false): Promise<MobileStatus> {
  const settings = getSettings().mobile;
  const tailscale = await tailscaleStatus(refresh);
  if (refresh) await refreshMobileAccess();
  return {
    enabled: settings.enabled,
    port: bound?.port ?? settings.port,
    tailscale,
    urls: mobileUrls(),
    // Tailscale being off is no problem while phones get through the cloud gateway.
    error: settings.enabled && !(isCloudOnline() && phoneGatewayUrl()) ? lastError : null,
    devices: listDevices(),
  };
}
