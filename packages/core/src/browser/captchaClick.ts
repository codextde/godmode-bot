import { sleep } from "../util";
import type { PageSession } from "./cdp";

export type ClickKind = "recaptcha_v2" | "hcaptcha" | "turnstile" | "cloudflare_challenge";

export type ClickOutcome = { ok: true; seconds: number; clicked: boolean } | { ok: false; reason: "no_widget" | "challenge" | "no_pass"; clicked: boolean };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DomNode = {
  backendNodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
};

const WIDGET: Record<ClickKind, (src: string) => boolean> = {
  recaptcha_v2: (src) => /\/recaptcha\/(api2|enterprise)\/anchor/.test(src),
  hcaptcha: (src) => src.includes("hcaptcha.com") && src.includes("frame=checkbox"),
  turnstile: (src) => src.includes("challenges.cloudflare.com"),
  cloudflare_challenge: (src) => src.includes("challenges.cloudflare.com"),
};

const CHALLENGE: Partial<Record<ClickKind, (src: string) => boolean>> = {
  recaptcha_v2: (src) => /\/recaptcha\/(api2|enterprise)\/bframe/.test(src),
  hcaptcha: (src) => src.includes("hcaptcha.com") && src.includes("frame=challenge"),
};

const CONTAINER: Partial<Record<ClickKind, string>> = {
  turnstile: ".cf-turnstile, [class*='turnstile'][data-sitekey]",
  cloudflare_challenge: "#challenge-stage, #turnstile-wrapper, .cf-turnstile-wrapper",
};

const CHECKBOX_X: Record<ClickKind, number> = { recaptcha_v2: 27, hcaptcha: 30, turnstile: 30, cloudflare_challenge: 30 };

const PASSED = String.raw`((kind) => {
  const val = (sel) => [...document.querySelectorAll(sel)].some((el) => (el.value || "").length > 20);
  try {
    if (kind === "recaptcha_v2") return val("textarea[name='g-recaptcha-response'], textarea[id^='g-recaptcha-response']") || !!(window.grecaptcha && grecaptcha.getResponse && grecaptcha.getResponse());
    if (kind === "hcaptcha") return val("textarea[name='h-captcha-response'], textarea[name='g-recaptcha-response']") || !!(window.hcaptcha && hcaptcha.getResponse && hcaptcha.getResponse());
    if (kind === "turnstile") return val("input[name='cf-turnstile-response']") || !!(window.turnstile && turnstile.getResponse && turnstile.getResponse());
    if (kind === "cloudflare_challenge") return document.readyState === "complete" && !/just a moment|attention required|einen moment/i.test(document.title) && !window._cf_chl_opt;
  } catch {}
  return false;
})`;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function attr(node: DomNode, name: string): string {
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1] ?? "";
  return "";
}

function iframes(root: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const walk = (n: DomNode, depth: number) => {
    if (depth > 60 || out.length > 200) return;
    if (n.nodeName === "IFRAME" || n.nodeName === "FRAME") out.push(n);
    for (const c of n.shadowRoots ?? []) walk(c, depth + 1);
    for (const c of n.children ?? []) walk(c, depth + 1);
    if (n.contentDocument) walk(n.contentDocument, depth + 1);
  };
  walk(root, 0);
  return out;
}

async function boxOf(page: PageSession, backendNodeId: number, scroll: boolean): Promise<Box | null> {
  try {
    if (scroll) await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const { model } = await page.send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId });
    const q = model.border;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    return box.width >= 20 && box.height >= 20 ? box : null;
  } catch {
    return null;
  }
}

async function findFrame(page: PageSession, match: (src: string) => boolean, scroll: boolean): Promise<Box | null> {
  let root: DomNode;
  try {
    root = (await page.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true })).root;
  } catch {
    return null;
  }
  for (const f of iframes(root)) {
    if (!match(attr(f, "src"))) continue;
    const box = await boxOf(page, f.backendNodeId, scroll);
    if (box) return box;
  }
  return null;
}

async function findContainer(page: PageSession, selector: string): Promise<Box | null> {
  try {
    const { root } = await page.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const { nodeId } = await page.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { node } = await page.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    return boxOf(page, node.backendNodeId, true);
  } catch {
    return null;
  }
}

async function widgetBox(page: PageSession, kind: ClickKind): Promise<Box | null> {
  const frame = await findFrame(page, WIDGET[kind], true);
  if (frame) return frame;
  const sel = CONTAINER[kind];
  return sel ? findContainer(page, sel) : null;
}

async function passed(page: PageSession, kind: ClickKind): Promise<boolean> {
  try {
    return !!(await page.evaluate<boolean>(`(${PASSED})(${JSON.stringify(kind)})`, { timeoutMs: 3000 }));
  } catch {
    return false;
  }
}

async function challengeShown(page: PageSession, kind: ClickKind): Promise<boolean> {
  const match = CHALLENGE[kind];
  if (!match) return false;
  const box = await findFrame(page, match, false);
  return !!box && box.width > 150 && box.height > 150;
}

export async function humanClick(page: PageSession, x: number, y: number) {
  const from = { x: Math.max(5, x + rand(-320, 320)), y: Math.max(5, y + rand(120, 300)) };
  const steps = Math.round(rand(18, 32));
  const bend = { x: rand(-60, 60), y: rand(-60, 60) };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const arc = Math.sin(Math.PI * t);
    const px = from.x + (x - from.x) * e + bend.x * arc + rand(-0.6, 0.6);
    const py = from.y + (y - from.y) * e + bend.y * arc + rand(-0.6, 0.6);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", buttons: 0 });
    await sleep(rand(6, 18));
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await sleep(rand(90, 220));
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(rand(60, 130));
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function waitFor(page: PageSession, kind: ClickKind, ms: number, stopOnChallenge: boolean): Promise<"passed" | "challenge" | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await passed(page, kind)) return "passed";
    if (stopOnChallenge && (await challengeShown(page, kind))) return "challenge";
    await sleep(400);
  }
  return null;
}

export async function clickSolve(page: PageSession, kind: ClickKind, opts: { waitMs?: number; settleMs?: number } = {}): Promise<ClickOutcome> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const auto = kind === "turnstile" || kind === "cloudflare_challenge";
  if (await passed(page, kind)) return { ok: true, seconds: seconds(), clicked: false };
  if (auto && (await waitFor(page, kind, opts.settleMs ?? 4000, false)) === "passed") return { ok: true, seconds: seconds(), clicked: false };

  let clicked = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = await widgetBox(page, kind);
    if (!box) {
      if (kind === "cloudflare_challenge" && (await waitFor(page, kind, 3000, false)) === "passed") return { ok: true, seconds: seconds(), clicked };
      if (!clicked) return { ok: false, reason: "no_widget", clicked };
      break;
    }
    const x = box.x + Math.min(CHECKBOX_X[kind], box.width / 2) + rand(-2, 2);
    const y = box.y + Math.min(box.height / 2, 40) + rand(-2, 2);
    await humanClick(page, x, y);
    clicked = true;
    const r = await waitFor(page, kind, opts.waitMs ?? (kind === "cloudflare_challenge" ? 15_000 : 8000), true);
    if (r === "passed") return { ok: true, seconds: seconds(), clicked };
    if (r === "challenge") return { ok: false, reason: "challenge", clicked };
  }
  return { ok: false, reason: "no_pass", clicked };
}
