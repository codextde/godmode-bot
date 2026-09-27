/**
 * Browser live view: CDP `Page.startScreencast` of the active tab, streamed as `browser.frame` events to
 * subscribed UIs (≤ 8 fps), plus human takeover (click / scroll / keys / text) e.g. to solve a CAPTCHA.
 *
 * Frame `width`/`height` are the viewport size in CSS pixels (screencast metadata deviceWidth/Height);
 * input coordinates from the UI are expected in that same space.
 */
import type { BrowserInputEvent } from "@godmode/shared";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict } from "../util";
import { getSettings } from "../services/settings";
import { hasBrowserSubscribers, setBrowserSubscriptionHandler } from "../server/ws";
import { attachToPage, keyDefinition, pickActivePage, type CdpParams, type PageSession } from "./cdp";
import { getRunning, onBrowserState, touchBrowser, type RunningBrowser } from "./state";

const log = logger("live-view");

const FRAME_INTERVAL_MS = 125;
const REPICK_INTERVAL_MS = 2000;
const MAX_TEXT = 10_000;

interface FrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop: number;
  pageScaleFactor: number;
}

interface PendingFrame {
  data: string;
  ackId: number;
  meta: FrameMetadata;
  session: PageSession;
}

class LiveView {
  session: PageSession | null = null;
  targetId: string | null = null;
  url = "";
  title = "";
  meta: FrameMetadata | null = null;
  private pending: PendingFrame | null = null;
  private lastEmit = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private repickTimer: ReturnType<typeof setInterval> | null = null;
  private delayedRepick: ReturnType<typeof setTimeout> | null = null;
  private offs: (() => void)[] = [];
  private switching: Promise<void> | null = null;
  private stopped = false;

  constructor(public rb: RunningBrowser) {}

  async start() {
    const c = this.rb.client;
    this.offs.push(
      c.on("Page.screencastFrame", (p, sessionId) => {
        if (this.session && sessionId === this.session.sessionId) this.onFrame(p, this.session);
      }),
      c.on("Target.targetInfoChanged", (p) => {
        const t = p.targetInfo as { targetId: string; url: string; title: string };
        if (t.targetId === this.targetId) {
          this.url = t.url;
          this.title = t.title;
        }
      }),
      c.on("Target.targetCreated", (p) => {
        if ((p.targetInfo as { type: string }).type === "page") this.repickSoon(300);
      }),
      c.on("Target.targetDestroyed", (p) => {
        if (p.targetId === this.targetId) this.lost();
      }),
      c.on("Target.detachedFromTarget", (p) => {
        if (this.session && p.sessionId === this.session.sessionId) this.lost();
      }),
    );
    await this.repick();
    this.repickTimer = setInterval(() => void this.repick(), REPICK_INTERVAL_MS);
  }

  private lost() {
    this.session = null;
    this.targetId = null;
    this.pending = null;
    this.repickSoon(100);
  }

  private repickSoon(ms: number) {
    if (this.stopped || this.delayedRepick) return;
    this.delayedRepick = setTimeout(() => {
      this.delayedRepick = null;
      void this.repick();
    }, ms);
  }

  /** Follow the active tab: switch the screencast when the human or the agent changes tabs. */
  async repick() {
    if (this.stopped) return;
    if (this.switching) return this.switching;
    this.switching = (async () => {
      try {
        const page = await pickActivePage(this.rb.client, { port: this.rb.port });
        if (this.stopped) return;
        if (!page) {
          await this.detach();
          return;
        }
        if (page.targetId === this.targetId && this.session) return;
        await this.detach();
        const session = await attachToPage(this.rb.client, page.targetId);
        if (this.stopped) {
          await session.detach();
          return;
        }
        this.session = session;
        this.targetId = page.targetId;
        this.url = page.url;
        this.title = page.title;
        await session.send("Page.enable");
        await session.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
      } catch (err) {
        log.debug("screencast attach failed; retrying", err instanceof Error ? err.message : err);
        await this.detach();
      }
    })().finally(() => {
      this.switching = null;
    });
    return this.switching;
  }

  private onFrame(p: CdpParams, session: PageSession) {
    this.meta = p.metadata as FrameMetadata;
    this.pending = { data: p.data as string, ackId: p.sessionId as number, meta: this.meta, session };
    const wait = FRAME_INTERVAL_MS - (Date.now() - this.lastEmit);
    if (wait <= 0) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, wait);
    }
  }

  /** Emit the newest frame and only then ack it — Chrome waits for the ack, so this throttles at the source. */
  private flush() {
    const f = this.pending;
    if (!f || this.stopped) return;
    this.pending = null;
    this.lastEmit = Date.now();
    bus.emit({
      type: "browser.frame",
      profileId: this.rb.profileId,
      data: f.data,
      url: this.url,
      title: this.title,
      width: Math.round(f.meta.deviceWidth),
      height: Math.round(f.meta.deviceHeight),
    });
    f.session.send("Page.screencastFrameAck", { sessionId: f.ackId }).catch(() => {});
  }

  private async detach() {
    const session = this.session;
    this.session = null;
    this.targetId = null;
    this.pending = null;
    if (!session) return;
    await session.send("Page.stopScreencast", {}, 3000).catch(() => {});
    await session.detach();
  }

  async stop() {
    this.stopped = true;
    if (this.repickTimer) clearInterval(this.repickTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.delayedRepick) clearTimeout(this.delayedRepick);
    for (const off of this.offs) off();
    this.offs = [];
    if (this.switching) await this.switching.catch(() => {});
    await this.detach();
  }
}

const views = new Map<string, LiveView>();
let initialized = false;

/** Wire the live view to WebSocket subscriptions and browser start/stop (idempotent). */
export function initLiveView() {
  if (initialized) return;
  initialized = true;
  setBrowserSubscriptionHandler((profileId, subscribed) => {
    if (subscribed) void startLiveView(profileId);
    else void stopLiveView(profileId);
  });
  onBrowserState((profileId, rb) => {
    if (!rb) void stopLiveView(profileId);
    else if (hasBrowserSubscribers(profileId)) void startLiveView(profileId);
  });
}

function liveViewEnabled(): boolean {
  try {
    return getSettings().browser.liveView;
  } catch {
    return true;
  }
}

/** Start streaming frames for the profile (no-op if its browser isn't running or live view is off). */
export async function startLiveView(profileId: string): Promise<void> {
  const rb = getRunning(profileId);
  if (!rb || !liveViewEnabled()) return;
  const existing = views.get(profileId);
  if (existing) {
    if (existing.rb === rb) return;
    views.delete(profileId);
    await existing.stop();
  }
  const view = new LiveView(rb);
  views.set(profileId, view);
  try {
    await view.start();
  } catch (err) {
    log.warn(`live view for ${profileId} failed to start`, err);
    if (views.get(profileId) === view) views.delete(profileId);
    await view.stop();
  }
}

export async function stopLiveView(profileId: string): Promise<void> {
  const view = views.get(profileId);
  if (!view) return;
  views.delete(profileId);
  await view.stop();
}

function clamp(v: number, max: number | undefined): number {
  if (!Number.isFinite(v)) return 0;
  const upper = max && max > 0 ? max - 1 : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(0, v), upper);
}

/** Human takeover: forward a click / scroll / key / text to the tab shown in the live view. */
export async function dispatchInput(profileId: string, event: BrowserInputEvent): Promise<void> {
  const rb = getRunning(profileId);
  if (!rb) throw conflict("The browser for this profile is not running");
  touchBrowser(profileId);
  const view = views.get(profileId);
  let session = view && view.rb === rb ? view.session : null;
  let temporary: PageSession | null = null;
  if (!session) {
    const page = await pickActivePage(rb.client, { port: rb.port });
    if (!page) throw conflict("The browser has no open tab");
    temporary = await attachToPage(rb.client, page.targetId);
    session = temporary;
  }
  const meta = view?.meta ?? null;
  try {
    switch (event.type) {
      case "click":
        await session.click(clamp(event.x, meta?.deviceWidth), clamp(event.y, meta?.deviceHeight));
        break;
      case "scroll":
        await session.scroll(clamp(event.x, meta?.deviceWidth), clamp(event.y, meta?.deviceHeight), Number.isFinite(event.deltaY) ? event.deltaY : 0);
        break;
      case "key": {
        if (keyDefinition(event.key)) await session.pressKey(event.key);
        else if ([...event.key].length === 1) await session.insertText(event.key);
        else throw badRequest(`Unsupported key: ${event.key}`);
        break;
      }
      case "text":
        if (event.text.length > MAX_TEXT) throw badRequest(`Text is too long (max ${MAX_TEXT} characters)`);
        if (event.text) await session.insertText(event.text);
        break;
    }
  } finally {
    if (temporary) await temporary.detach();
  }
  // Clicks often switch or open tabs — follow quickly.
  if (view && event.type === "click") setTimeout(() => void view.repick(), 250);
}
