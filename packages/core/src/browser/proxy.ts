/**
 * Per-chat DevTools endpoint for browser-use. Every run gets a token-protected loopback URL that looks like
 * Chromium's own (`/json/version` + a browser WebSocket) but only shows the run's chat its own tabs: target lists
 * and target events are filtered, commands for other tabs are refused, and tabs the chat opens (new tabs, popups)
 * become its own. Several chats drive one browser at once — same profile, same logins — without seeing or moving
 * each other's pages.
 */
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { logger } from "../log";
import { probeCdp } from "./cdp";
import type { RunningBrowser } from "./state";
import type { TabRegistry, TargetInfo } from "./tabs";

const log = logger("browser-proxy");

interface Lease {
  token: string;
  runId: string;
  profileId: string;
  conversationId: string;
  /** The running browser, with a tab ready for the chat. */
  open: () => Promise<RunningBrowser>;
  sockets: Set<ServerWebSocket<Socket>>;
}

interface Socket {
  lease: Lease;
  conn?: ChatConnection;
}

const leases = new Map<string, Lease>();
const byRun = new Map<string, Lease>();
let server: Server<Socket> | null = null;

/** Commands that mean the chat's agent works in that tab now (the live view follows it). */
const FOCUS = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.captureScreenshot",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.bringToFront",
]);
/**
 * Commands that would raise the browser window and take focus from whatever the human is doing. They are answered
 * here instead: the agent's tab is the only one of its background window, and the live view follows it (`FOCUS`).
 */
const NO_FRONT = new Set(["Target.activateTarget", "Page.bringToFront"]);
const BLOCKED = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Target.attachToBrowserTarget"]);
const NO_TARGET = { code: -32602, message: "No target with given id found" };
const NO_SESSION = { code: -32001, message: "Session with given id not found." };
const NOT_ALLOWED = { code: -32000, message: "Not available here: this connection only reaches its own chat's tabs." };
/** How long target events wait for a createTarget answer (they arrive before it, and ownership is decided by it). */
const HOLD_MS = 5000;

type Pending = { kind: "create" } | { kind: "attach"; targetId: string } | { kind: "targets" } | { kind: "context" };

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: unknown;
}

class ChatConnection {
  private upstream: WebSocket | null = null;
  private tabs: TabRegistry | null = null;
  private outbox: string[] = [];
  private sessions = new Map<string, string>();
  private shown = new Set<string>();
  private pending = new Map<number, Pending>();
  /** createTarget requests in flight: until they answer, nobody knows whose the new tab is. */
  private creating = new Set<number>();
  private held: string[] = [];
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Events about tabs nobody owned when they arrived, replayed if a late createTarget answer makes one this chat's. */
  private unclaimed = new Map<string, string[]>();
  private downloads = new Set<string>();
  private contexts = new Set<string>();
  private closed = false;

  constructor(
    private ws: ServerWebSocket<Socket>,
    private lease: Lease,
  ) {}

  private get chat() {
    return this.lease.conversationId;
  }

  async start() {
    let rb: RunningBrowser;
    try {
      rb = await this.lease.open();
    } catch (err) {
      this.end(1011, err instanceof Error ? err.message : "The browser could not be started");
      return;
    }
    if (this.closed) return;
    this.tabs = rb.tabs;
    const up = new WebSocket(rb.wsUrl);
    this.upstream = up;
    up.addEventListener("open", () => {
      for (const raw of this.outbox.splice(0)) up.send(raw);
    });
    up.addEventListener("message", (ev) => this.fromBrowser(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")));
    up.addEventListener("close", () => this.end(1001, "The browser closed"));
    up.addEventListener("error", () => this.end(1011, "Lost the connection to the browser"));
  }

  /* ---------------------------- chat → browser ---------------------------- */

  fromClient(raw: string) {
    if (this.closed) return;
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { id, method, sessionId } = msg;
    if (typeof id !== "number" || typeof method !== "string") return;
    const params = msg.params ?? {};
    if (sessionId && !this.sessions.has(sessionId)) return this.reply(id, sessionId, NO_SESSION);
    const refusal = this.refusal(method, params);
    if (refusal) return this.reply(id, sessionId, refusal);

    this.tabs?.touch(this.chat);
    if (sessionId && FOCUS.has(method)) this.tabs?.focus(this.chat, this.sessions.get(sessionId)!);
    else if (method === "Target.activateTarget") this.tabs?.focus(this.chat, params.targetId);
    if (NO_FRONT.has(method)) return this.send(JSON.stringify({ id, result: {}, ...(sessionId ? { sessionId } : {}) }));

    switch (method) {
      case "Target.createTarget":
        // Its own window: a new tab would land in whichever window was active last — maybe another chat's.
        msg.params = { ...params, newWindow: true, background: true };
        raw = JSON.stringify(msg);
        this.pending.set(id, { kind: "create" });
        this.creating.add(id);
        break;
      case "Target.attachToTarget":
        this.pending.set(id, { kind: "attach", targetId: params.targetId });
        break;
      case "Target.getTargets":
        this.pending.set(id, { kind: "targets" });
        break;
      case "Target.createBrowserContext":
        this.pending.set(id, { kind: "context" });
        break;
      case "Target.setAutoAttach":
        // Other chats' new tabs are auto-attached to this connection too (and hidden): they must never wait for it.
        if (!sessionId && params.waitForDebuggerOnStart) {
          msg.params = { ...params, waitForDebuggerOnStart: false };
          raw = JSON.stringify(msg);
        }
        break;
    }
    if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(raw);
    else this.outbox.push(raw);
  }

  private refusal(method: string, params: Record<string, any>): typeof NO_TARGET | null {
    if (BLOCKED.has(method)) return NOT_ALLOWED;
    if (method === "Target.disposeBrowserContext" && !this.contexts.has(params.browserContextId)) return NOT_ALLOWED;
    const targetId = params.targetId;
    if (typeof targetId === "string" && (method.startsWith("Target.") || method === "Browser.getWindowForTarget")) {
      if (!this.canUse(targetId)) return NO_TARGET;
    }
    return null;
  }

  private canUse(targetId: string): boolean {
    const info = this.tabs?.info(targetId);
    return info ? this.visible(info) : this.shown.has(targetId);
  }

  private reply(id: number, sessionId: string | undefined, error: { code: number; message: string }) {
    this.send(JSON.stringify({ id, error, ...(sessionId ? { sessionId } : {}) }));
  }

  /* ---------------------------- browser → chat ---------------------------- */

  private fromBrowser(raw: string) {
    if (this.closed) return;
    const id = responseId(raw);
    let late: string[] = [];
    if (id !== null && this.pending.get(id)?.kind === "create") {
      const wasHolding = this.creating.delete(id);
      const targetId = parse(raw)?.result?.targetId;
      if (typeof targetId === "string") {
        this.tabs?.claim(targetId, this.chat);
        // Answered after the hold gave up: its tab's events were dropped as nobody's.
        if (!wasHolding) late = this.unclaimed.get(targetId) ?? [];
        this.unclaimed.delete(targetId);
      }
    }
    // Events about a tab being created arrive before createTarget answers: hold them until it's clear whose tab it is.
    if (this.creating.size > 0) {
      this.held.push(...late, raw);
      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.creating.clear();
        this.flushHeld();
      }, HOLD_MS);
      return;
    }
    this.flushHeld();
    for (const event of late) this.deliver(event);
    this.deliver(raw);
  }

  private flushHeld() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    for (const raw of this.held.splice(0)) this.deliver(raw);
  }

  private deliver(raw: string) {
    const id = responseId(raw);
    if (id !== null) {
      const job = this.pending.get(id);
      if (!job) return this.send(raw);
      this.pending.delete(id);
      const msg = parse(raw);
      if (!msg?.result) return this.send(raw);
      switch (job.kind) {
        case "create":
          if (typeof msg.result.targetId === "string") this.shown.add(msg.result.targetId);
          break;
        case "attach":
          if (typeof msg.result.sessionId === "string") this.sessions.set(msg.result.sessionId, job.targetId);
          break;
        case "context":
          if (typeof msg.result.browserContextId === "string") this.contexts.add(msg.result.browserContextId);
          break;
        case "targets": {
          const infos = Array.isArray(msg.result.targetInfos) ? (msg.result.targetInfos as TargetInfo[]) : [];
          msg.result.targetInfos = infos.filter((t) => this.visible(t) && this.shown.add(t.targetId));
          return this.send(JSON.stringify(msg));
        }
      }
      return this.send(raw);
    }

    const msg = parse(raw);
    if (!msg?.method) return;
    const params = msg.params ?? {};
    if (msg.sessionId) {
      if (!this.sessions.has(msg.sessionId)) return;
      if (msg.method === "Target.attachedToTarget" && params.targetInfo) {
        this.tabs?.note(params.targetInfo);
        this.sessions.set(params.sessionId, params.targetInfo.targetId);
      } else if (msg.method === "Target.detachedFromTarget") this.sessions.delete(params.sessionId);
      return this.send(raw);
    }
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        if (!params.targetInfo) return;
        if (!this.visible(params.targetInfo)) return this.keepUnclaimed(params.targetInfo, raw);
        this.shown.add(params.targetInfo.targetId);
        return this.send(raw);
      case "Target.targetDestroyed":
        this.unclaimed.delete(params.targetId);
        if (!this.shown.delete(params.targetId)) return;
        return this.send(raw);
      case "Target.targetCrashed":
        if (!this.shown.has(params.targetId)) return;
        return this.send(raw);
      case "Target.attachedToTarget":
        if (!params.targetInfo) return;
        if (!this.visible(params.targetInfo)) return this.keepUnclaimed(params.targetInfo, raw);
        this.shown.add(params.targetInfo.targetId);
        this.sessions.set(params.sessionId, params.targetInfo.targetId);
        return this.send(raw);
      case "Target.detachedFromTarget":
        if (!this.sessions.delete(params.sessionId)) return;
        return this.send(raw);
      case "Target.receivedMessageFromTarget":
        if (!this.sessions.has(params.sessionId)) return;
        return this.send(raw);
      case "Browser.downloadWillBegin": {
        // The main frame's id is its tab's target id: another chat's download isn't this chat's business.
        const owner = typeof params.frameId === "string" ? this.tabs?.ownerOf(params.frameId) : null;
        if (owner && owner !== this.chat) return;
        this.downloads.add(params.guid);
        return this.send(raw);
      }
      case "Browser.downloadProgress":
        if (!this.downloads.has(params.guid)) return;
        if (params.state !== "inProgress") this.downloads.delete(params.guid);
        return this.send(raw);
    }
    this.send(raw);
  }

  private keepUnclaimed(info: TargetInfo, raw: string) {
    if (info.type !== "page" || this.tabs?.ownerOf(info.targetId)) return;
    const events = this.unclaimed.get(info.targetId) ?? [];
    if (!events.length && this.unclaimed.size >= 50) this.unclaimed.delete(this.unclaimed.keys().next().value!);
    if (events.length < 8) events.push(raw);
    this.unclaimed.set(info.targetId, events);
  }

  private visible(info: TargetInfo): boolean {
    return !!this.tabs && this.tabs.visibleTo(info, this.chat);
  }

  private send(raw: string) {
    if (!this.closed) this.ws.send(raw);
  }

  end(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    try {
      this.upstream?.close();
    } catch {
      /* already closed */
    }
    try {
      this.ws.close(code, reason.slice(0, 120));
    } catch {
      /* already closed */
    }
  }
}

/** Id of a CDP response without parsing it (screenshots make responses megabytes long); null for events. */
function responseId(raw: string): number | null {
  if (raw.startsWith('{"id":')) {
    const n = Number.parseInt(raw.slice(6, 24), 10);
    return Number.isInteger(n) ? n : null;
  }
  if (raw.startsWith('{"method":')) return null;
  const msg = parse(raw);
  return typeof msg?.id === "number" ? msg.id : null;
}

function parse(raw: string): CdpMessage | null {
  try {
    return JSON.parse(raw) as CdpMessage;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Endpoint                                                             */
/* ------------------------------------------------------------------ */

function ensureServer(): Server<Socket> {
  if (server) return server;
  server = Bun.serve<Socket>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handle,
    websocket: {
      maxPayloadLength: 512 * 1024 * 1024,
      backpressureLimit: 512 * 1024 * 1024,
      idleTimeout: 0,
      perMessageDeflate: false,
      open(ws) {
        const lease = ws.data.lease;
        if (leases.get(lease.token) !== lease) {
          ws.close(1008, "This browser connection has ended");
          return;
        }
        lease.sockets.add(ws);
        ws.data.conn = new ChatConnection(ws, lease);
        void ws.data.conn.start();
      },
      message(ws, message) {
        ws.data.conn?.fromClient(typeof message === "string" ? message : message.toString("utf8"));
      },
      close(ws) {
        ws.data.lease.sockets.delete(ws);
        ws.data.conn?.end(1000, "closed");
      },
    },
  });
  return server;
}

async function handle(req: Request, srv: Server<Socket>): Promise<Response | undefined> {
  const url = new URL(req.url);
  const port = srv.port;
  const host = req.headers.get("host");
  // Loopback clients only; browsers always send an Origin, so a web page can't talk to this endpoint.
  if ((host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) || req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
  const [token, ...rest] = url.pathname.split("/").filter(Boolean);
  const lease = token ? leases.get(token) : undefined;
  if (!lease) return new Response("Not found", { status: 404 });
  const path = rest.join("/");

  if (path === "json/version") {
    try {
      const rb = await lease.open();
      const version = await probeCdp(rb.port);
      return Response.json({
        Browser: version?.Browser ?? "Chrome",
        "Protocol-Version": "1.3",
        "User-Agent": version?.["User-Agent"] ?? "",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${lease.token}/devtools/browser`,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
    }
  }
  if (path.startsWith("devtools/browser")) {
    if (srv.upgrade(req, { data: { lease } })) return undefined;
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  return new Response("Not found", { status: 404 });
}

/** Give a run a DevTools URL that reaches only its chat's tabs. Returns the http URL clients use as `cdp_url`. */
export function openChatLease(input: { runId: string; profileId: string; conversationId: string; open: () => Promise<RunningBrowser> }): string {
  releaseChatLease(input.runId);
  const lease: Lease = { ...input, token: randomBytes(32).toString("hex"), sockets: new Set() };
  leases.set(lease.token, lease);
  byRun.set(lease.runId, lease);
  return `http://127.0.0.1:${ensureServer().port}/${lease.token}`;
}

/** End a run's access: its URL stops working and open connections close. Returns what was leased. */
export function releaseChatLease(runId: string): { profileId: string; conversationId: string } | null {
  const lease = byRun.get(runId);
  if (!lease) return null;
  byRun.delete(runId);
  leases.delete(lease.token);
  for (const ws of [...lease.sockets]) ws.data.conn?.end(1000, "The run ended");
  return { profileId: lease.profileId, conversationId: lease.conversationId };
}

/** Chats whose run may use the browser right now (profile id → conversation ids). */
export function leasedChats(profileId: string): Set<string> {
  const out = new Set<string>();
  for (const lease of byRun.values()) if (lease.profileId === profileId) out.add(lease.conversationId);
  return out;
}

export function stopChatProxy() {
  for (const runId of [...byRun.keys()]) releaseChatLease(runId);
  server?.stop(true);
  server = null;
  log.debug("stopped");
}
