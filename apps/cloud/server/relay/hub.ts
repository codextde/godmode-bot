/**
 * The relay hub: accepts computer links, keeps one live link per computer, and implements RelayHubApi for the rest of
 * the app (registered through src/server/relay-bridge.ts).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  CLOUD_FRAME_HEADER,
  CLOUD_FRAME_MAX,
  CLOUD_WS_CLIENT_MESSAGE_MAX,
  CloudClose,
  CloudFrame,
  encodeCloudFrame,
  parseCloudBearer,
  type CloudHello,
  type CloudNotice,
  type CloudWelcome,
} from "@godmode/shared";
import { validateSessionToken } from "@/server/auth/sessions";
import { deviceAllowance, getEntitlements } from "@/server/billing/entitlements";
import { config } from "@/server/config";
import { authenticateDevice, deviceStates, getDeviceForUser, getDeviceWithOwner, touchDevice } from "@/server/devices";
import { clientIp } from "@/server/ratelimit";
import type { RelayHubApi, RelayLinkInfo } from "@/server/relay-bridge";
import { getSettings } from "@/server/settings";
import { recordUsage } from "@/server/usage";
import { Strikes } from "./limits";
import { Link, type LinkHooks, type StreamSession } from "./link";

const MINUTE = 60_000;

export interface HubTimings {
  /** Usage flush and access re-check. */
  revalidateMs?: number;
  /** Client socket heartbeat. */
  heartbeatMs?: number;
}

interface UsageRow {
  deviceId: string;
  userId: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
}

export class RelayHub implements RelayHubApi {
  readonly startedAt = new Date();
  /** Failed link logins per IP: 20 in 5 minutes lock that address out for 5 minutes. */
  readonly connectFailures = new Strikes(20, 5 * MINUTE, 5 * MINUTE);
  /** Phone requests the computer answered 401, per IP: 20 in 5 minutes lock that address out for 15 minutes. */
  readonly gatewayUnauthorized = new Strikes(20, 5 * MINUTE, 15 * MINUTE);
  /** Upgrades of browser and phone sockets. */
  readonly clientServer = new WebSocketServer({ noServer: true, maxPayload: CLOUD_WS_CLIENT_MESSAGE_MAX, perMessageDeflate: false });
  private readonly linkServer = new WebSocketServer({ noServer: true, maxPayload: CLOUD_FRAME_HEADER + CLOUD_FRAME_MAX, perMessageDeflate: false });
  /** Welcomed links, one per computer. */
  private readonly links = new Map<string, Link>();
  /** Every open link, also those still waiting for Hello. */
  private readonly all = new Set<Link>();
  private readonly closedTotals = { bytesIn: 0, bytesOut: 0 };
  private unflushed = new Map<string, UsageRow>();
  private readonly timers: NodeJS.Timeout[];
  private readonly hooks: LinkHooks = {
    welcome: (link, hello) => this.welcome(link, hello),
    update: (link, hello) => {
      touchDevice(link.deviceId, devicePatch(link, hello)).catch((err: unknown) => console.error("[relay] could not update a computer:", err));
    },
    closed: (link) => this.onClosed(link),
  };

  constructor(timings: HubTimings = {}) {
    this.timers = [
      setInterval(() => void this.periodic(), timings.revalidateMs ?? MINUTE),
      setInterval(() => this.heartbeat(), timings.heartbeatMs ?? 30_000),
    ];
    for (const timer of this.timers) timer.unref();
  }

  /** The welcomed link of a computer, if it is online. */
  link(deviceId: string): Link | null {
    const link = this.links.get(deviceId);
    return link && link.welcomed ? link : null;
  }

  /**
   * A computer dials in. Refusals accept the upgrade and close with a CloudClose code, because that is the only way
   * the computer learns why. BadCredential (which makes it stop for good) is sent only when the lookup ran and the
   * device or secret is wrong; anything going wrong on our side closes with 1011 and the computer retries.
   */
  async handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ip = clientIp(req.headers, req.socket.remoteAddress ?? null);
    const refuse = (code: number, reason: string) => this.acceptAndClose(req, socket, head, code, reason);
    if (this.connectFailures.lockedFor(ip)) return refuse(CloudClose.RateLimited, "Too many failed attempts. Try again later.");

    let identity: { deviceId: string; userId: string; account: { email: string; name: string | null } };
    try {
      const bearer = /^Bearer\s+(\S+)$/i.exec((req.headers.authorization ?? "").trim())?.[1] ?? "";
      if (!parseCloudBearer(bearer)) {
        this.connectFailures.strike(ip);
        return refuse(CloudClose.Protocol, "Missing or malformed credentials.");
      }
      const device = await authenticateDevice(bearer);
      if (!device) {
        this.connectFailures.strike(ip);
        return refuse(CloudClose.BadCredential, "This computer is not linked to this cloud any more.");
      }
      const found = await getDeviceWithOwner(device.id);
      if (!found) return refuse(CloudClose.BadCredential, "This computer is not linked to this cloud any more.");
      const { owner } = found;
      if (!(await getSettings("relay")).enabled) return refuse(CloudClose.Disabled, "The relay is turned off on this cloud.");
      if (device.status !== "active") return refuse(CloudClose.Disabled, "This computer is turned off in Godmode Cloud.");
      if (owner.status !== "active") return refuse(CloudClose.Disabled, "The account of this computer is suspended.");
      const allowance = await deviceAllowance(owner.id);
      if (!allowance.allowedDeviceIds.has(device.id)) return refuse(CloudClose.PlanRequired, "The plan of this account doesn't include this computer.");
      identity = { deviceId: device.id, userId: owner.id, account: { email: owner.email, name: owner.name } };
    } catch (err) {
      console.error("[relay] could not check a computer's link:", err);
      return refuse(1011, "Internal error. Try again.");
    }

    if (socket.destroyed) return;
    this.linkServer.handleUpgrade(req, socket, head, (ws) => {
      const link = new Link(ws, { ...identity, ip }, this.hooks);
      this.all.add(link);
    });
  }

  private acceptAndClose(req: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string): void {
    if (socket.destroyed) return;
    this.linkServer.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.close(code, reason);
      setTimeout(() => ws.terminate(), 5_000).unref();
    });
  }

  private async welcome(link: Link, hello: CloudHello): Promise<void> {
    await touchDevice(link.deviceId, devicePatch(link, hello));
    const [entitlements, relay] = await Promise.all([getEntitlements(link.userId), getSettings("relay")]);
    if (link.closed) return;
    const previous = this.links.get(link.deviceId);
    // A slow welcome of an older socket must not push out the newer link that got in first.
    if (previous && previous !== link && !previous.closed && previous.connectedAt.getTime() > link.connectedAt.getTime()) {
      link.close(CloudClose.Replaced, "This computer connected again.");
      return;
    }
    link.markWelcomed();
    this.links.set(link.deviceId, link);
    if (previous && previous !== link) previous.close(CloudClose.Replaced, "This computer connected again.");
    const welcome: CloudWelcome = {
      deviceId: link.deviceId,
      account: link.account,
      plan: entitlements.plan,
      publicUrl: config().publicUrl,
      limits: { maxBodyBytes: relay.maxBodyMb * 1024 * 1024 },
      serverTime: new Date().toISOString(),
    };
    link.send(encodeCloudFrame(CloudFrame.Welcome, 0, welcome));
  }

  private onClosed(link: Link): void {
    this.all.delete(link);
    if (this.links.get(link.deviceId) === link) this.links.delete(link.deviceId);
    this.closedTotals.bytesIn += link.totals.bytesIn;
    this.closedTotals.bytesOut += link.totals.bytesOut;
    this.collect(link);
    void this.flushUsage();
  }

  isOnline(deviceId: string): boolean {
    return this.link(deviceId) !== null;
  }

  info(deviceId: string): RelayLinkInfo | null {
    return this.link(deviceId)?.info() ?? null;
  }

  online(): RelayLinkInfo[] {
    return [...this.links.values()].filter((l) => l.welcomed).map((l) => l.info());
  }

  disconnect(deviceId: string, code: number, reason: string): void {
    for (const link of this.all) if (link.deviceId === deviceId) link.close(code, reason);
  }

  notify(deviceId: string, notice: CloudNotice): void {
    this.link(deviceId)?.notify(notice);
  }

  notifyUser(userId: string, notice: CloudNotice): void {
    for (const link of this.links.values()) if (link.userId === userId) link.notify(notice);
    if (notice.type === "plan") void this.enforceAllowance(userId);
  }

  stats(): { links: number; streams: number; sockets: number; bytesIn: number; bytesOut: number; startedAt: string } {
    let streams = 0;
    let sockets = 0;
    let bytesIn = this.closedTotals.bytesIn;
    let bytesOut = this.closedTotals.bytesOut;
    for (const link of this.links.values()) {
      streams += link.streamCount;
      sockets += link.socketCount;
      bytesIn += link.totals.bytesIn;
      bytesOut += link.totals.bytesOut;
    }
    return { links: this.links.size, streams, sockets, bytesIn, bytesOut, startedAt: this.startedAt.toISOString() };
  }

  /** After a plan change: computers beyond the plan's allowance lose their link. */
  private async enforceAllowance(userId: string): Promise<void> {
    try {
      const { allowedDeviceIds } = await deviceAllowance(userId);
      for (const link of [...this.links.values()]) {
        if (link.userId === userId && !allowedDeviceIds.has(link.deviceId)) {
          link.close(CloudClose.PlanRequired, "The plan of this account doesn't include this computer.");
        }
      }
    } catch (err) {
      console.error("[relay] could not re-check the device allowance:", err);
    }
  }

  private collect(link: Link): void {
    const usage = link.takeUsage();
    if (!usage.bytesIn && !usage.bytesOut && !usage.requests) return;
    this.addUsage({ deviceId: link.deviceId, userId: link.userId, ...usage });
  }

  private addUsage(row: UsageRow): void {
    const key = `${row.deviceId}:${row.userId}`;
    const current = this.unflushed.get(key);
    if (!current) this.unflushed.set(key, { ...row });
    else {
      current.bytesIn += row.bytesIn;
      current.bytesOut += row.bytesOut;
      current.requests += row.requests;
    }
  }

  /** Writes the traffic counted since the last flush; on failure it is kept for the next one. */
  async flushUsage(): Promise<void> {
    for (const link of this.links.values()) this.collect(link);
    if (this.unflushed.size === 0) return;
    const rows = [...this.unflushed.values()];
    this.unflushed = new Map();
    try {
      await recordUsage(rows);
    } catch (err) {
      console.error("[relay] could not record usage:", err);
      for (const row of rows) this.addUsage(row);
    }
  }

  private async periodic(): Promise<void> {
    await this.flushUsage();
    await this.revalidate();
  }

  /**
   * Every minute: links of computers that were removed or turned off, or whose owner was suspended, close; open
   * streams of a session that ended or a share that was removed are cut.
   */
  async revalidate(): Promise<void> {
    const links = [...this.links.values()];
    if (links.length === 0) return;
    try {
      const relay = await getSettings("relay");
      const states = await deviceStates(links.map((l) => l.deviceId));
      for (const link of links) {
        const state = states.get(link.deviceId);
        if (!state) link.close(CloudClose.BadCredential, "Removed");
        else if (!relay.enabled) link.close(CloudClose.Disabled, "The relay is turned off on this cloud.");
        else if (state.status !== "active") link.close(CloudClose.Disabled, "This computer is turned off in Godmode Cloud.");
        else if (state.ownerStatus !== "active") link.close(CloudClose.Disabled, "The account of this computer is suspended.");
      }
    } catch (err) {
      console.error("[relay] could not re-check links:", err);
    }

    const checks = new Map<string, Promise<boolean>>();
    const pending: Promise<void>[] = [];
    for (const link of this.links.values()) {
      for (const stream of link.streamList()) {
        const session = stream.session;
        if (!session) continue;
        const key = `${session.userId}\u0000${session.deviceId}\u0000${session.role}\u0000${session.token}`;
        let check = checks.get(key);
        if (!check) {
          check = stillAllowed(session);
          checks.set(key, check);
        }
        pending.push(
          check.then((ok) => {
            if (!ok) stream.revoke();
          }),
        );
      }
    }
    await Promise.allSettled(pending);
  }

  private heartbeat(): void {
    for (const link of this.links.values()) {
      for (const stream of link.streamList()) stream.heartbeat?.();
    }
    this.connectFailures.prune();
    this.gatewayUnauthorized.prune();
  }

  /** Shutdown: every link closes with 1001 (the computers reconnect to the next process), usage is written. */
  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    for (const link of [...this.all]) link.close(1001, "The cloud is restarting.");
    await this.flushUsage();
    this.linkServer.close();
    this.clientServer.close();
  }
}

function devicePatch(link: Link, hello: CloudHello) {
  return {
    name: hello.name || "Godmode",
    platform: hello.platform,
    appVersion: hello.version,
    browserAccess: hello.browserAccess,
    phoneAccess: hello.phoneAccess,
    lastIp: link.ip,
  };
}

/** Does the person behind a stream still have the same access? A database error keeps the stream for now. */
async function stillAllowed(session: StreamSession): Promise<boolean> {
  try {
    const ctx = await validateSessionToken(session.token);
    if (!ctx || ctx.user.id !== session.userId) return false;
    const access = await getDeviceForUser(session.deviceId, session.userId);
    return access !== null && access.role === session.role;
  } catch {
    return true;
  }
}
