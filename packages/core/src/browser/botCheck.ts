/**
 * Bot check: what a website's bot detection sees in a profile's browser. A throwaway loopback server serves a page
 * (and records its request headers) that is opened in a background tab; its navigator, a worker, the window
 * metrics, WebGL and permissions are compared with what a regular Chrome shows.
 */
import type { BotCheckItem, BotCheckReport } from "@godmode/shared";
import { now } from "../util";
import { attachToPage, type CdpClient } from "./cdp";

export interface BotSignals {
  webdriver: boolean | null;
  userAgent: string;
  brands: { brand: string; version: string }[] | null;
  fullVersionList: number;
  languages: string[];
  language: string;
  plugins: number;
  pdfViewer: boolean;
  chrome: boolean;
  notification: string | null;
  notificationQuery: string | null;
  webgl: string | null;
  window: { outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number };
  screen: { width: number; height: number };
  worker: { userAgent: string; webdriver: boolean | null } | null;
}

export interface BotHeaders {
  userAgent: string | null;
  secChUa: string | null;
  acceptLanguage: string | null;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Godmode bot check</title><p>Checking how sites see this browser…</p>`;
const WORKER = `postMessage({ userAgent: navigator.userAgent, webdriver: navigator.webdriver ?? null });`;

const COLLECT = `(async () => {
  const worker = await new Promise((resolve) => {
    try {
      const w = new Worker("/worker.js");
      const timer = setTimeout(() => resolve(null), 3000);
      w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
      w.onerror = () => { clearTimeout(timer); resolve(null); };
    } catch { resolve(null); }
  });
  const uaData = navigator.userAgentData;
  let high = null;
  try { high = uaData ? await uaData.getHighEntropyValues(["fullVersionList"]) : null; } catch {}
  let webgl = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    webgl = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : null;
  } catch {}
  let notificationQuery = null;
  try { notificationQuery = (await navigator.permissions.query({ name: "notifications" })).state; } catch {}
  return {
    webdriver: navigator.webdriver ?? null,
    userAgent: navigator.userAgent,
    brands: uaData ? uaData.brands.map((b) => ({ brand: b.brand, version: b.version })) : null,
    fullVersionList: high && high.fullVersionList ? high.fullVersionList.length : 0,
    languages: [...navigator.languages],
    language: navigator.language,
    plugins: navigator.plugins.length,
    pdfViewer: !!navigator.pdfViewerEnabled,
    chrome: typeof window.chrome === "object" && window.chrome !== null,
    notification: typeof Notification === "undefined" ? null : Notification.permission,
    notificationQuery,
    webgl,
    window: { outerWidth, outerHeight, innerWidth, innerHeight },
    screen: { width: screen.width, height: screen.height },
    worker,
  };
})()`;

/** Load the check page in a background tab of the browser behind `client` and collect what it sees. */
export async function collectBotSignals(
  client: CdpClient,
  close = async (targetId: string) => {
    await client.send("Target.closeTarget", { targetId }, undefined, 5000);
  },
): Promise<{ signals: BotSignals; headers: BotHeaders }> {
  let headers: BotHeaders | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/worker.js") return new Response(WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      if (path !== "/") return new Response("Not found", { status: 404 });
      headers = { userAgent: req.headers.get("user-agent"), secChUa: req.headers.get("sec-ch-ua"), acceptLanguage: req.headers.get("accept-language") };
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    },
  });
  let targetId: string | null = null;
  try {
    ({ targetId } = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true, background: true }));
    const page = await attachToPage(client, targetId);
    try {
      await page.navigate(`http://127.0.0.1:${server.port}/`);
      await page.waitForReady(10_000);
      const signals = await page.evaluate<BotSignals>(COLLECT, { timeoutMs: 15_000 });
      if (!headers) throw new Error("The check page didn't load");
      return { signals, headers };
    } finally {
      await page.detach();
    }
  } finally {
    if (targetId) await close(targetId).catch(() => {});
    server.stop(true);
  }
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;

function major(userAgent: string): string | null {
  return /(?:Headless)?Chrome\/(\d+)/.exec(userAgent)?.[1] ?? null;
}

function size(w: number, h: number): string {
  return `${w}×${h}`;
}

/** Judge the collected signals the way common bot detection does. */
export function judgeBotSignals(s: BotSignals, h: BotHeaders): BotCheckItem[] {
  const checks: BotCheckItem[] = [];
  const add = (id: BotCheckItem["id"], label: string, status: BotCheckItem["status"], detail: string) => checks.push({ id, label, status, detail });

  const webdriver = s.webdriver === true || s.worker?.webdriver === true;
  add("webdriver", "Automation flag", webdriver ? "fail" : "pass", webdriver ? "navigator.webdriver is true — sites see an automated browser." : "navigator.webdriver is false, like in a browser a person uses.");

  const headless = /headless/i.test(s.userAgent) || /headless/i.test(h.userAgent ?? "");
  const product = /(?:Headless)?Chrome\/[\d.]+/.exec(s.userAgent)?.[0] ?? s.userAgent;
  add("userAgent", "User agent", headless ? "fail" : "pass", headless ? `The browser introduces itself as ${product} — blocked on sight by many sites.` : `Introduces itself as ${product}.`);

  const version = major(s.userAgent);
  const chromium = s.brands?.find((b) => b.brand === "Chromium")?.version ?? null;
  if (!s.brands?.length) add("clientHints", "Client hints", "fail", "navigator.userAgentData is missing — real Chrome always has it.");
  else if (!h.secChUa) add("clientHints", "Client hints", "fail", "Requests don't carry the Sec-CH-UA header Chrome always sends.");
  else if (version && chromium && version !== chromium) add("clientHints", "Client hints", "fail", `The user agent says ${version}, the client hints say ${chromium}.`);
  else if (!s.fullVersionList) add("clientHints", "Client hints", "warn", "Brands match, but detailed hints (full version) are withheld — only sites that ask for them notice.");
  else add("clientHints", "Client hints", "pass", "Brands and the Sec-CH-UA header match the user agent.");

  if (!s.worker) add("worker", "Workers", "warn", "A web worker couldn't be started to compare.");
  else if (s.worker.userAgent !== s.userAgent) add("worker", "Workers", "fail", "Web workers report a different user agent than the page.");
  else add("worker", "Workers", "pass", "Web workers report the same browser as the page.");

  const { outerWidth, outerHeight, innerWidth, innerHeight } = s.window;
  if (innerWidth > outerWidth || innerHeight > outerHeight) {
    add("window", "Window size", "fail", `The page (${size(innerWidth, innerHeight)}) is larger than its window (${size(outerWidth, outerHeight)}).`);
  } else if (outerWidth > s.screen.width || outerHeight > s.screen.height) {
    add("window", "Window size", "fail", `The window (${size(outerWidth, outerHeight)}) is larger than the screen (${size(s.screen.width, s.screen.height)}).`);
  } else {
    add("window", "Window size", "pass", `Window ${size(outerWidth, outerHeight)} on a ${size(s.screen.width, s.screen.height)} screen.`);
  }

  if (!s.webgl) add("webgl", "Graphics", "warn", "WebGL is unavailable, which is unusual for a desktop browser.");
  else if (SOFTWARE_GL.test(s.webgl)) add("webgl", "Graphics", "warn", `Software rendering (${s.webgl.slice(0, 60)}) is typical for servers and headless browsers.`);
  else add("webgl", "Graphics", "pass", s.webgl.replace(/^ANGLE \((.+)\)$/, "$1").slice(0, 90));

  const plugins = s.plugins > 0 && s.pdfViewer;
  add("plugins", "Plugins", plugins ? "pass" : "warn", plugins ? `Built-in PDF viewer and ${s.plugins} plugins.` : "No plugins — typical for headless browsers.");

  const first = h.acceptLanguage?.split(",")[0]?.split(";")[0]?.trim().toLowerCase();
  if (!s.languages.length) add("languages", "Languages", "fail", "navigator.languages is empty.");
  else if (first && first !== s.language.toLowerCase()) add("languages", "Languages", "warn", `Requests ask for ${first}, the page reports ${s.language}.`);
  else add("languages", "Languages", "pass", s.languages.join(", "));

  const contradicts = s.notification === "denied" && s.notificationQuery === "prompt";
  add("permissions", "Permissions", contradicts ? "fail" : "pass", contradicts ? "Notification.permission says denied while the Permissions API says prompt." : "Notification and Permissions API agree.");

  add("chrome", "Chrome runtime", s.chrome ? "pass" : "fail", s.chrome ? "window.chrome is present." : "window.chrome is missing — real Chrome always has it.");
  return checks;
}

export async function botCheckReport(
  client: CdpClient,
  meta: { profileId: string; browser: string; headless: boolean; stealth: boolean },
  close?: (targetId: string) => Promise<void>,
): Promise<BotCheckReport> {
  const { signals, headers } = await collectBotSignals(client, close);
  return { ...meta, checks: judgeBotSignals(signals, headers), checkedAt: now() };
}
