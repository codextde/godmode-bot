import { join } from "node:path";
import { rmSync } from "node:fs";
import { standaloneDocument } from "@godmode/shared";
import { config, ensureDir } from "../config";
import { logger } from "../log";
import { sleep } from "../util";
import { getSettings } from "./settings";
import { CdpClient, attachToPage, type PageSession } from "../browser/cdp";
import { findChrome, launchChrome, type ChromeProcess } from "../browser/chrome";

const log = logger("artifact-check");

const IDLE_MS = 3 * 60_000;
const WIDTH = 1100;
const PHONE_WIDTH = 390;
const MAX_HEIGHT = 2200;
const SETTLE_MS = 6000;
const MAX_ERRORS = 12;

export interface RenderCheck {
  image: string | null;
  errors: string[];
  warnings: string[];
  height: number;
}

interface Browser {
  proc: ChromeProcess;
  client: CdpClient;
  idle: ReturnType<typeof setTimeout> | null;
}

let browser: Promise<Browser> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function profileDir(): string {
  return join(config().dataDir, "artifact-check");
}

async function launch(): Promise<Browser> {
  const chrome = findChrome(getSettings().browser.chromePath);
  if (!chrome) throw new Error("no Chrome or Chromium found on this computer");
  const dir = profileDir();
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const proc = await launchChrome({
    executable: chrome.path,
    userDataDir: dir,
    headless: true,
    extraArgs: ["--hide-scrollbars", "--mute-audio", "--disable-extensions", "--disable-sync"],
  });
  const client = await CdpClient.connect(proc.wsUrl);
  client.onClose(() => {
    browser = null;
  });
  return { proc, client, idle: null };
}

async function getBrowser(): Promise<Browser> {
  if (browser) {
    const b = await browser.catch(() => null);
    if (b && !b.client.closed && b.proc.isAlive()) return b;
    browser = null;
  }
  browser = launch();
  browser.catch(() => {
    browser = null;
  });
  return browser;
}

function scheduleClose(b: Browser) {
  if (b.idle) clearTimeout(b.idle);
  b.idle = setTimeout(() => void stopArtifactCheck(), IDLE_MS);
}

export async function stopArtifactCheck(): Promise<void> {
  const current = browser;
  browser = null;
  if (!current) return;
  const b = await current.catch(() => null);
  if (!b) return;
  if (b.idle) clearTimeout(b.idle);
  b.client.close();
  b.proc.kill();
}

function firstLine(text: unknown): string {
  return String(text ?? "").split("\n")[0]!.trim().slice(0, 300);
}

async function settle(page: PageSession, inflight: () => number) {
  const deadline = Date.now() + SETTLE_MS;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const ready = await page.evaluate<string>("document.readyState", { timeoutMs: 1000 }).catch(() => "loading");
    if (ready === "complete" && inflight() === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 400) break;
    } else quietSince = 0;
    await sleep(100);
  }
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", { timeoutMs: 2000 }).catch(() => undefined);
}

async function render(html: string, data: unknown): Promise<RenderCheck> {
  const b = await getBrowser();
  if (b.idle) clearTimeout(b.idle);
  const { targetId } = await b.client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const page = await attachToPage(b.client, targetId);
  const errors: string[] = [];
  const pending = new Set<string>();
  const add = (line: string) => {
    if (line && !errors.includes(line)) errors.push(line);
  };
  const offs = [
    b.client.on("Runtime.exceptionThrown", (p, sid) => {
      if (sid !== page.sessionId) return;
      const d = p.exceptionDetails ?? {};
      add(firstLine(d.exception?.description ?? d.text));
    }),
    b.client.on("Runtime.consoleAPICalled", (p, sid) => {
      if (sid !== page.sessionId || p.type !== "error") return;
      add(firstLine((p.args ?? []).map((a: { value?: unknown; description?: string }) => a.value ?? a.description ?? "").join(" ")));
    }),
    b.client.on("Log.entryAdded", (p, sid) => {
      if (sid !== page.sessionId || p.entry?.level !== "error") return;
      add(firstLine(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`));
    }),
    b.client.on("Network.requestWillBeSent", (p, sid) => {
      if (sid === page.sessionId) pending.add(p.requestId);
    }),
    b.client.on("Network.loadingFinished", (p, sid) => {
      if (sid === page.sessionId) pending.delete(p.requestId);
    }),
    b.client.on("Network.loadingFailed", (p, sid) => {
      if (sid !== page.sessionId) return;
      pending.delete(p.requestId);
    }),
  ];
  try {
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => page.send(m)));
    await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
    const { frameTree } = await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    await page.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: standaloneDocument(html, data, "light") });
    await settle(page, () => pending.size);
    const facts = await page.evaluate<{ height: number; text: number; nodes: number; kitErrors: string[] }>(
      `({height: Math.ceil(document.documentElement.scrollHeight), text: (document.body && document.body.innerText || "").trim().length,
        nodes: document.body ? document.body.querySelectorAll("*").length : 0,
        kitErrors: Array.from(document.querySelectorAll(".gm-error")).slice(0, 5).map(e => (e.textContent || "").trim().slice(0, 200))})`,
    );
    for (const e of facts.kitErrors) add(`Kit: ${e}`);
    const warnings: string[] = [];
    if (facts.text === 0 && facts.nodes < 5) warnings.push("The page is empty: nothing was rendered.");
    const height = Math.max(400, Math.min(facts.height, MAX_HEIGHT));
    await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const { data: image } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    if (facts.height > MAX_HEIGHT) warnings.push(`The page is ${facts.height}px tall; the screenshot shows the first ${MAX_HEIGHT}px.`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: PHONE_WIDTH, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const phoneWidth = await page.evaluate<number>("document.documentElement.scrollWidth").catch(() => PHONE_WIDTH);
    if (phoneWidth > PHONE_WIDTH + 4) warnings.push(`On a phone (${PHONE_WIDTH}px) the page is ${phoneWidth}px wide and scrolls sideways.`);
    return { image, errors: errors.slice(-MAX_ERRORS), warnings, height: facts.height };
  } finally {
    for (const off of offs) off();
    await b.client.send("Target.closeTarget", { targetId }).catch(() => undefined);
    scheduleClose(b);
  }
}

export function checkArtifactRender(html: string, data: unknown): Promise<RenderCheck | null> {
  if (testCheck) return testCheck(html, data);
  const next = queue.then(() =>
    render(html, data).catch((err) => {
      log.warn("artifact render check failed", err);
      void stopArtifactCheck();
      return null;
    }),
  );
  queue = next.catch(() => undefined);
  return next;
}

let testCheck: ((html: string, data: unknown) => Promise<RenderCheck | null>) | null = null;

export function __setArtifactCheckForTests(fn: typeof testCheck) {
  testCheck = fn;
}
