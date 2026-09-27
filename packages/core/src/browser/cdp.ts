/**
 * Minimal Chrome DevTools Protocol client on Bun's WebSocket, plus the page helpers the browser
 * subsystem needs (target selection, evaluation, input, screenshots, cookies).
 *
 * One `CdpClient` is a connection to the browser target; pages are driven through flattened
 * sessions (`Target.attachToTarget { flatten: true }`) multiplexed over that same socket.
 */
import { sleep } from "../util";

// CDP payloads are schemaless JSON; handlers narrow what they need.
export type CdpParams = Record<string, any>;
export type CdpResult = any;
type EventHandler = (params: CdpParams, sessionId: string | undefined) => void;

export class CdpError extends Error {
  constructor(
    public method: string,
    public code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

interface Pending {
  method: string;
  resolve: (value: CdpResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private closeHandlers = new Set<() => void>();
  private _closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () => this.onClosed());
    ws.addEventListener("error", () => this.onClosed());
  }

  /** Connect to a DevTools WebSocket URL (browser or page target). */
  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Timed out connecting to ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${wsUrl}`));
      });
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  send<T = CdpResult>(method: string, params: CdpParams = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this._closed) return Promise.reject(new Error(`${method}: CDP connection closed`));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Subscribe to a CDP event (from any session). Returns an unsubscribe function. */
  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Resolve with the params of the next `method` event matching `predicate`. */
  waitForEvent(method: string, predicate: (params: CdpParams, sessionId?: string) => boolean = () => true, timeoutMs = 10_000): Promise<CdpParams> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params, sessionId) => {
        if (!predicate(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  onClose(handler: () => void): () => void {
    if (this._closed) {
      queueMicrotask(handler);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.onClosed();
  }

  private onMessage(data: unknown) {
    let msg: { id?: number; method?: string; params?: CdpParams; sessionId?: string; result?: CdpResult; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (!set) return;
      for (const h of [...set]) {
        try {
          h(msg.params ?? {}, msg.sessionId);
        } catch {
          /* handler errors must not break the socket loop */
        }
      }
    }
  }

  private onClosed() {
    if (this._closed) return;
    this._closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: CDP connection closed`));
    }
    this.pending.clear();
    for (const h of [...this.closeHandlers]) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
    this.closeHandlers.clear();
  }
}

/* ------------------------------------------------------------------ */
/* HTTP discovery endpoints                                             */
/* ------------------------------------------------------------------ */

export interface BrowserVersion {
  Browser: string;
  "User-Agent": string;
  webSocketDebuggerUrl: string;
}

/** GET http://127.0.0.1:<port>/json/version — null if nothing answers. */
export async function probeCdp(port: number, timeoutMs = 1500): Promise<BrowserVersion | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = (await res.json()) as BrowserVersion;
    return json.webSocketDebuggerUrl ? json : null;
  } catch {
    return null;
  }
}

/** Page target ids ordered by most recent activation (Chrome sorts /json/list that way). */
async function recentPageOrder(port: number): Promise<string[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const list = (await res.json()) as { id: string; type: string }[];
    return list.filter((t) => t.type === "page").map((t) => t.id);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Targets                                                              */
/* ------------------------------------------------------------------ */

export interface PageTarget {
  targetId: string;
  url: string;
  title: string;
  attached: boolean;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
}

export function isUserPage(t: { type: string; url: string }): boolean {
  if (t.type !== "page") return false;
  return !/^(devtools|chrome-extension|chrome-untrusted):/i.test(t.url);
}

/** Top-level pages (tabs) of the browser, most recently activated first when `port` is given. */
export async function listPages(client: CdpClient, port?: number): Promise<PageTarget[]> {
  const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const pages = targetInfos
    .filter(isUserPage)
    .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, attached: t.attached }));
  if (port) {
    const order = await recentPageOrder(port);
    if (order.length) {
      const rank = new Map(order.map((id, i) => [id, i]));
      pages.sort((a, b) => (rank.get(a.targetId) ?? 1e6) - (rank.get(b.targetId) ?? 1e6));
    }
  }
  return pages;
}

export async function attachToPage(client: CdpClient, targetId: string): Promise<PageSession> {
  const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  return new PageSession(client, sessionId, targetId);
}

/**
 * The page the human (or the automation) is looking at: prefer a focused document, then a visible one,
 * then the most recently activated tab. `urlContains` restricts the candidates (case-insensitive).
 */
export async function pickActivePage(client: CdpClient, opts: { port?: number; urlContains?: string } = {}): Promise<PageTarget | null> {
  let pages = await listPages(client, opts.port);
  if (opts.urlContains) {
    const needle = opts.urlContains.toLowerCase();
    pages = pages.filter((p) => p.url.toLowerCase().includes(needle));
  }
  if (pages.length <= 1) return pages[0] ?? null;
  let firstVisible: PageTarget | null = null;
  for (const page of pages.slice(0, 8)) {
    let session: PageSession | null = null;
    try {
      session = await attachToPage(client, page.targetId);
      const state = await session.evaluate<{ focus: boolean; visible: boolean }>(
        "({ focus: document.hasFocus(), visible: document.visibilityState === 'visible' })",
        { timeoutMs: 1500 },
      );
      if (state?.focus) return page;
      if (state?.visible && !firstVisible) firstVisible = page;
    } catch {
      /* hung or navigating page — skip */
    } finally {
      await session?.detach();
    }
  }
  return firstVisible ?? pages[0]!;
}

/* ------------------------------------------------------------------ */
/* Page session                                                         */
/* ------------------------------------------------------------------ */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const KEYS: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const KEY_ALIASES: Record<string, string> = { Return: "Enter", Esc: "Escape", " ": "Space", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

/** Named key → CDP key event fields, or null if unsupported. */
export function keyDefinition(name: string): KeyDefinition | null {
  const canonical = KEY_ALIASES[name] ?? name;
  return KEYS[canonical] ?? null;
}

export interface EvaluateOptions {
  awaitPromise?: boolean;
  timeoutMs?: number;
  contextId?: number;
}

export class PageSession {
  constructor(
    public client: CdpClient,
    public sessionId: string,
    public targetId: string,
  ) {}

  send<T = CdpResult>(method: string, params: CdpParams = {}, timeoutMs = 30_000): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /** Evaluate an expression and return its JSON value; throws on page exceptions. */
  async evaluate<T = unknown>(expression: string, opts: EvaluateOptions = {}): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? true,
        userGesture: true,
        ...(opts.contextId ? { contextId: opts.contextId } : {}),
      },
      opts.timeoutMs ?? 15_000,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description?.split("\n")[0] ?? d.text ?? "Evaluation failed");
    }
    return res.result.value as T;
  }

  /**
   * Execution context of a fresh isolated world in the main frame: page scripts cannot see or
   * tamper with code running there, while the DOM is shared.
   */
  async isolatedWorld(worldName = "godmode"): Promise<number | undefined> {
    try {
      const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
      const { executionContextId } = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName,
        grantUniveralAccess: false,
      });
      return executionContextId;
    } catch {
      return undefined;
    }
  }

  insertText(text: string) {
    return this.send("Input.insertText", { text });
  }

  async pressKey(name: string, modifiers = 0) {
    const def = keyDefinition(name);
    if (!def) throw new Error(`Unsupported key: ${name}`);
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
    await this.send("Input.dispatchKeyEvent", {
      ...base,
      type: def.text ? "keyDown" : "rawKeyDown",
      ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async click(x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  scroll(x: number, y: number, deltaY: number, deltaX = 0) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  async screenshot(format: "png" | "jpeg" = "png", quality?: number): Promise<string> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format, ...(quality ? { quality } : {}) });
    return data;
  }

  async navigate(url: string): Promise<void> {
    const res = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
  }

  /** Wait until document.readyState is at least "interactive" (best effort). */
  async waitForReady(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate<string>("document.readyState", { timeoutMs: 1000 });
        if (state === "interactive" || state === "complete") return;
      } catch {
        /* navigating */
      }
      await sleep(100);
    }
  }

  async detach() {
    try {
      await this.client.send("Target.detachFromTarget", { sessionId: this.sessionId }, undefined, 3000);
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cookies (browser-wide Storage domain)                                */
/* ------------------------------------------------------------------ */

/** CDP Network.Cookie as returned by Storage.getCookies. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean } | string;
}

/** CDP Network.CookieParam accepted by Storage.setCookies. */
export interface CdpCookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
  priority?: "Low" | "Medium" | "High";
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

export async function getCookies(client: CdpClient): Promise<CdpCookie[]> {
  const { cookies } = await client.send<{ cookies: CdpCookie[] }>("Storage.getCookies", {}, undefined, 60_000);
  return cookies;
}

/**
 * Set cookies in batches; if a batch is rejected (one malformed cookie fails the whole call),
 * retry its cookies one by one. Returns how many were accepted.
 */
export async function setCookies(client: CdpClient, cookies: CdpCookieParam[]): Promise<{ set: number; failed: number }> {
  let set = 0;
  let failed = 0;
  const BATCH = 200;
  for (let i = 0; i < cookies.length; i += BATCH) {
    const batch = cookies.slice(i, i + BATCH);
    try {
      await client.send("Storage.setCookies", { cookies: batch }, undefined, 60_000);
      set += batch.length;
    } catch {
      for (const cookie of batch) {
        try {
          await client.send("Storage.setCookies", { cookies: [cookie] }, undefined, 10_000);
          set++;
        } catch {
          failed++;
        }
      }
    }
  }
  return { set, failed };
}
