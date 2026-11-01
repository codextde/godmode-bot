/**
 * CAPTCHA solving through a third-party service (2Captcha, CapSolver, Anti-Captcha). The agent never solves a CAPTCHA
 * itself: Godmode finds the widget on the chat's page, sends its site key (or a picture of an image CAPTCHA) to the
 * service with the human's API key, and puts the answer into the page. The key never reaches the agent.
 *
 * All three services speak the same createTask / getTaskResult JSON API; only the task type names differ.
 */
import type { CaptchaSolver, CaptchaStatus, Settings } from "@godmode/shared";
import { getMeta, setMeta } from "../db";
import { getSettings, updateSettings } from "../services/settings";
import { HttpError, hostnameOf, sleep } from "../util";
import { getAppSecret, hasAppSecret, isUnlocked } from "../vault/vault";
import { attachToPage, pickActivePage, type CdpClient, type PageSession, type PageTarget } from "./cdp";
import { childFrameSessions } from "./fill";
import { clickSolve, type ClickKind } from "./captchaClick";

export type CaptchaKind = "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile" | "cloudflare_challenge" | "image";
export type SolverId = Exclude<CaptchaSolver, "off">;

export const CAPTCHA_KIND_LABEL: Record<CaptchaKind, string> = {
  recaptcha_v2: "reCAPTCHA v2",
  recaptcha_v3: "reCAPTCHA v3",
  hcaptcha: "hCaptcha",
  turnstile: "Cloudflare Turnstile",
  cloudflare_challenge: "Cloudflare challenge page",
  image: "image CAPTCHA",
};

interface SolverInfo {
  label: string;
  base: string;
  secret: string;
  keyUrl: string;
}

export const SOLVERS: Record<SolverId, SolverInfo> = {
  "2captcha": { label: "2Captcha", base: "https://api.2captcha.com", secret: "twocaptcha_api_key", keyUrl: "https://2captcha.com/enterpage" },
  capsolver: { label: "CapSolver", base: "https://api.capsolver.com", secret: "capsolver_api_key", keyUrl: "https://dashboard.capsolver.com" },
  anticaptcha: { label: "Anti-Captcha", base: "https://api.anti-captcha.com", secret: "anticaptcha_api_key", keyUrl: "https://anti-captcha.com/clients/settings/apisetup" },
};

export const CAPTCHA_SECRETS = Object.values(SOLVERS).map((s) => s.secret);

/** A CAPTCHA found on the page. */
export interface FoundCaptcha {
  kind: Exclude<CaptchaKind, "image">;
  sitekey: string;
  /** URL of the document the widget is in (the service needs the page it is solved for). */
  url: string;
  invisible?: boolean;
  enterprise?: boolean;
  /** reCAPTCHA `data-s` (Google services). */
  s?: string;
  /** reCAPTCHA v3 / Turnstile action and Turnstile cData. */
  action?: string;
  cdata?: string;
  /** Which frame session found it: 0 = the page, n = the n-th out-of-process iframe. */
  frame: number;
}

/* ------------------------------------------------------------------ */
/* Settings, key and daily limit                                        */
/* ------------------------------------------------------------------ */

const todayKey = () => {
  const d = new Date();
  return `captcha.solved.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function solvedToday(): number {
  try {
    return Number(getMeta(todayKey()) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function countSolve() {
  setMeta(todayKey(), String(solvedToday() + 1));
}

function keySet(secret: string): boolean {
  try {
    return hasAppSecret(secret);
  } catch {
    return false;
  }
}

export function activeSolver(settings: Pick<Settings, "browser"> = getSettings()): SolverId | null {
  const s = settings.browser.captchaSolver;
  return s && s !== "off" && s in SOLVERS ? s : null;
}

/** A solver is picked and its key is stored: agents get the captcha_solve tool. */
export function captchaSolverReady(settings?: Pick<Settings, "browser">): boolean {
  const id = activeSolver(settings);
  return !!id && isUnlocked() && keySet(SOLVERS[id].secret);
}

export function localSolverOn(settings: Pick<Settings, "browser"> = getSettings()): boolean {
  return settings.browser.captchaLocal !== false;
}

export function captchaSolvingAvailable(settings: Pick<Settings, "browser"> = getSettings()): boolean {
  return localSolverOn(settings) || captchaSolverReady(settings);
}

export function captchaStatus(): CaptchaStatus {
  const id = activeSolver();
  return {
    solver: id ?? "off",
    hasApiKey: !!id && keySet(SOLVERS[id].secret),
    secretKey: id ? SOLVERS[id].secret : null,
    solvedToday: solvedToday(),
    dailyLimit: getSettings().browser.captchaDailyLimit,
  };
}

/**
 * Once: a solver key stored while no solver was picked (saved under API keys before that picked one) selects its
 * solver. Only with exactly one solver key, and never again after that, so a later "off" stays off.
 */
export function adoptStoredSolverKey(): SolverId | null {
  const DONE = "captcha.adopted_key";
  if (getMeta(DONE)) return null;
  setMeta(DONE, new Date().toISOString());
  if (activeSolver()) return null;
  const stored = (Object.keys(SOLVERS) as SolverId[]).filter((id) => keySet(SOLVERS[id].secret));
  if (stored.length !== 1) return null;
  updateSettings({ browser: { captchaSolver: stored[0]! } });
  return stored[0]!;
}

function solverKey(id: SolverId): string {
  const key = getAppSecret(SOLVERS[id].secret);
  if (!key) throw new HttpError(409, `No ${SOLVERS[id].label} API key is stored. Add it in Settings → Browser → CAPTCHA solving.`);
  return key;
}

/* ------------------------------------------------------------------ */
/* Service API                                                          */
/* ------------------------------------------------------------------ */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...args) => fetch(...args);
export function __setCaptchaFetchForTests(f: Fetch | null) {
  fetchImpl = f ?? ((...args) => fetch(...args));
}
let pollMs = 3000;
export function __setCaptchaPollForTests(ms: number | null) {
  pollMs = ms ?? 3000;
}

export class CaptchaServiceError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

const ERROR_HINTS: Record<string, string> = {
  ERROR_KEY_DOES_NOT_EXIST: "the API key is wrong",
  ERROR_WRONG_USER_KEY: "the API key is wrong",
  ERROR_INVALID_KEY: "the API key is wrong",
  ERROR_KEY_DENIED_ACCESS: "the API key is wrong",
  ERROR_ZERO_BALANCE: "the account has no balance left; top it up",
  ERROR_CAPTCHA_UNSOLVABLE: "the service could not solve this CAPTCHA",
  ERROR_NO_SLOT_AVAILABLE: "the service is busy; try again in a minute",
  ERROR_TASK_NOT_SUPPORTED: "the service does not solve this kind of CAPTCHA",
  ERROR_IP_NOT_ALLOWED: "the key only works from other IP addresses (check the IP whitelist in the service's settings)",
};

async function callService<T extends Record<string, unknown>>(id: SolverId, method: string, body: Record<string, unknown>, key: string, timeoutMs = 30_000): Promise<T> {
  const label = SOLVERS[id].label;
  let res: Response;
  try {
    res = await fetchImpl(`${SOLVERS[id].base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: key, ...body }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(30_000, timeoutMs))),
    });
  } catch (err) {
    throw new CaptchaServiceError(`${label} could not be reached: ${err instanceof Error ? err.message : String(err)}`, "NETWORK");
  }
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CaptchaServiceError(`${label} answered with HTTP ${res.status} and no JSON`, "BAD_RESPONSE");
  }
  if (Number(data.errorId ?? 0) !== 0) {
    const code = String(data.errorCode ?? "ERROR");
    const why = ERROR_HINTS[code] ?? String(data.errorDescription ?? "unknown error");
    throw new CaptchaServiceError(`${label}: ${why} (${code})`.split(key).join("••••••••"), code);
  }
  return data as T;
}

export async function solverBalance(id: SolverId | null = activeSolver()): Promise<number> {
  if (!id) throw new HttpError(409, "No CAPTCHA solver is selected.");
  try {
    const data = await callService<{ balance?: number }>(id, "getBalance", {}, solverKey(id));
    return Number(data.balance ?? 0);
  } catch (err) {
    if (err instanceof CaptchaServiceError) throw new HttpError(502, err.message, "upstream_error");
    throw err;
  }
}

export type CaptchaTask =
  | { kind: "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile"; found: FoundCaptcha }
  | { kind: "image"; image: string; caseSensitive?: boolean };

/** The service's task for a CAPTCHA, or null when the service doesn't solve that kind. */
export function buildTask(id: SolverId, task: CaptchaTask): Record<string, unknown> | null {
  const cs = id === "capsolver";
  if (task.kind === "image") return { type: "ImageToTextTask", body: task.image, ...(task.caseSensitive && !cs ? { case: true } : {}) };
  const f = task.found;
  const base = { websiteURL: f.url, websiteKey: f.sitekey };
  switch (task.kind) {
    case "recaptcha_v2": {
      const type = cs
        ? f.enterprise
          ? "ReCaptchaV2EnterpriseTaskProxyLess"
          : "ReCaptchaV2TaskProxyLess"
        : f.enterprise
          ? "RecaptchaV2EnterpriseTaskProxyless"
          : "RecaptchaV2TaskProxyless";
      const s = f.s ? (f.enterprise ? { enterprisePayload: { s: f.s } } : { recaptchaDataSValue: f.s }) : {};
      return { type, ...base, ...(f.invisible ? { isInvisible: true } : {}), ...s };
    }
    case "recaptcha_v3":
      if (cs) return { type: f.enterprise ? "ReCaptchaV3EnterpriseTaskProxyLess" : "ReCaptchaV3TaskProxyLess", ...base, ...(f.action ? { pageAction: f.action } : {}) };
      return { type: "RecaptchaV3TaskProxyless", ...base, minScore: 0.7, ...(f.action ? { pageAction: f.action } : {}), ...(f.enterprise ? { isEnterprise: true } : {}) };
    case "turnstile":
      if (cs) {
        const metadata = { ...(f.action ? { action: f.action } : {}), ...(f.cdata ? { cdata: f.cdata } : {}) };
        return { type: "AntiTurnstileTaskProxyLess", ...base, ...(Object.keys(metadata).length ? { metadata } : {}) };
      }
      return { type: "TurnstileTaskProxyless", ...base, ...(f.action ? { action: f.action } : {}), ...(f.cdata ? (id === "2captcha" ? { data: f.cdata } : { cData: f.cdata }) : {}) };
    case "hcaptcha":
      // None of the three services solves hCaptcha any more.
      return null;
  }
}

type Solution = { gRecaptchaResponse?: string; token?: string; text?: string };

/** Send a task and wait for the answer (token or text). */
export async function solveTask(
  id: SolverId,
  task: Record<string, unknown>,
  timeoutMs: number,
  beforeCreate?: () => void,
): Promise<{ answer: string; seconds: number; cost: number | null }> {
  const key = solverKey(id);
  beforeCreate?.();
  const started = Date.now();
  const created = await callService<{ taskId?: string | number; status?: string; solution?: Solution; cost?: string | number }>(id, "createTask", { task }, key);
  const answerOf = (s: Solution | undefined) => s?.gRecaptchaResponse || s?.token || s?.text || "";
  const done = (s: Solution | undefined, cost: unknown) => ({
    answer: answerOf(s),
    seconds: Math.round((Date.now() - started) / 1000),
    cost: cost === undefined || cost === null || Number.isNaN(Number(cost)) ? null : Number(cost),
  });
  if (created.status === "ready" && answerOf(created.solution)) return done(created.solution, created.cost);
  if (created.taskId === undefined || created.taskId === null) throw new CaptchaServiceError(`${SOLVERS[id].label} returned no task id`, "BAD_RESPONSE");
  await sleep(task.type === "ImageToTextTask" ? Math.min(pollMs, 2000) : pollMs * 2);
  while (Date.now() - started < timeoutMs) {
    let r: { status?: string; solution?: Solution; cost?: string | number };
    try {
      r = await callService(id, "getTaskResult", { taskId: created.taskId }, key, timeoutMs - (Date.now() - started));
    } catch (err) {
      // The task is paid for: a dropped connection or a garbled answer is retried until the deadline.
      if (err instanceof CaptchaServiceError && (err.code === "NETWORK" || err.code === "BAD_RESPONSE")) {
        await sleep(pollMs);
        continue;
      }
      throw err;
    }
    if (r.status === "ready") {
      if (!answerOf(r.solution)) throw new CaptchaServiceError(`${SOLVERS[id].label} returned an empty answer`, "BAD_RESPONSE");
      return done(r.solution, r.cost);
    }
    if (r.status === "failed") throw new CaptchaServiceError(`${SOLVERS[id].label} could not solve this CAPTCHA`, "ERROR_CAPTCHA_UNSOLVABLE");
    await sleep(pollMs);
  }
  throw new CaptchaServiceError(`${SOLVERS[id].label} did not answer within ${Math.round(timeoutMs / 1000)} s`, "TIMEOUT");
}

/* ------------------------------------------------------------------ */
/* In-page scripts (main world: the page's grecaptcha / turnstile live there) */
/* ------------------------------------------------------------------ */

const ROOTS = String.raw`
  const roots = [];
  const collect = (root, depth) => {
    if (depth > 6 || roots.length > 200) return;
    roots.push(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        try { const d = el.contentDocument; if (d && d.documentElement) collect(d, depth + 1); } catch {}
      }
    }
  };
  collect(document, 0);
  const all = (sel) => roots.flatMap((r) => { try { return [...r.querySelectorAll(sel)]; } catch { return []; } });
`;

export const DETECT = String.raw`(() => {
  ${ROOTS}
  const out = [];
  const seen = new Map();
  const add = (c) => {
    if (!c.sitekey && c.kind !== "cloudflare_challenge") return;
    const id = c.kind + ":" + c.sitekey;
    const known = seen.get(id);
    if (known) {
      for (const [k, v] of Object.entries(c)) if (v && !known[k]) known[k] = v;
      return;
    }
    const entry = { url: location.href, ...c };
    seen.set(id, entry);
    out.push(entry);
  };
  const param = (src, name) => { try { const u = new URL(src, location.href); return u.searchParams.get(name) || new URLSearchParams(u.hash.slice(1)).get(name) || ""; } catch { return ""; } };

  for (const f of all("iframe[src*='/recaptcha/api2/anchor'], iframe[src*='/recaptcha/enterprise/anchor']")) {
    const src = f.getAttribute("src") || "";
    const invisible = param(src, "size") === "invisible";
    add({ kind: "recaptcha_v2", sitekey: param(src, "k"), invisible, enterprise: src.includes("/enterprise/"), action: param(src, "sa") || undefined });
  }
  for (const el of all(".g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha")) {
    add({ kind: "recaptcha_v2", sitekey: el.getAttribute("data-sitekey") || "", invisible: el.getAttribute("data-size") === "invisible", s: el.getAttribute("data-s") || undefined });
  }
  for (const f of all("iframe[src*='hcaptcha.com']")) {
    const key = param(f.getAttribute("src") || "", "sitekey");
    if (key) add({ kind: "hcaptcha", sitekey: key });
  }
  for (const el of all(".h-captcha[data-sitekey]")) add({ kind: "hcaptcha", sitekey: el.getAttribute("data-sitekey") || "" });
  for (const el of all(".cf-turnstile[data-sitekey], [data-sitekey][class*='turnstile']")) {
    add({ kind: "turnstile", sitekey: el.getAttribute("data-sitekey") || "", action: el.getAttribute("data-action") || undefined, cdata: el.getAttribute("data-cdata") || undefined });
  }
  for (const f of all("iframe[src*='challenges.cloudflare.com']")) {
    const m = (f.getAttribute("src") || "").match(/\/(0x[0-9A-Za-z_-]{10,})\//);
    if (m) add({ kind: "turnstile", sitekey: m[1] });
  }
  // reCAPTCHA v3 loads api.js?render=<key>; its anchor frame is only the badge. Keys are either v2 or v3, never both.
  for (const s of all("script[src*='recaptcha/api.js'], script[src*='recaptcha/enterprise.js']")) {
    const src = s.getAttribute("src") || "";
    const key = param(src, "render");
    if (!/^[\w-]{20,}$/.test(key)) continue;
    for (const c of out) if (c.kind === "recaptcha_v2" && c.sitekey === key) c.kind = "badge";
    const inline = all("script:not([src])").map((el) => el.textContent || "").join("\n");
    const action = (inline.match(/execute\([^)]*?action\s*:\s*["']([\w/.-]{1,60})["']/) || [])[1];
    add({ kind: "recaptcha_v3", sitekey: key, enterprise: src.includes("enterprise.js"), action });
  }
  const isChallenge = window === window.top && !!(window._cf_chl_opt || document.querySelector("#challenge-form, #challenge-stage, script[src*='/cdn-cgi/challenge-platform/']")) && /just a moment|attention required|einen moment/i.test(document.title);
  if (isChallenge) add({ kind: "cloudflare_challenge", sitekey: "" });
  return out.filter((c) => c.kind !== "badge");
})()`;

export const INJECT = String.raw`(({ kind, token, sitekey }) => {
  ${ROOTS}
  const names = kind === "turnstile" ? ["cf-turnstile-response", "g-recaptcha-response"] : kind === "hcaptcha" ? ["h-captcha-response", "g-recaptcha-response"] : ["g-recaptcha-response"];
  const setValue = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  let filled = 0;
  for (const n of names) {
    for (const el of all("textarea[name='" + n + "'], input[name='" + n + "'], textarea[id^='" + n + "']")) { setValue(el, token); filled++; }
  }
  const widgets = all("[data-sitekey]").filter((el) => !sitekey || el.getAttribute("data-sitekey") === sitekey);
  if (!filled && kind !== "recaptcha_v3") {
    // No response field yet (explicitly rendered widget): add one to the widget's form.
    const form = widgets.map((w) => w.closest("form")).find(Boolean) || (all("form").length === 1 ? all("form")[0] : null);
    if (form) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = names[0];
      input.value = token;
      form.appendChild(input);
      filled++;
    }
  }
  let patched = false;
  const wrap = (obj) => {
    if (!obj) return;
    try {
      if (typeof obj.getResponse === "function") { obj.getResponse = () => token; patched = true; }
      if (kind !== "turnstile" && typeof obj.execute === "function") { obj.execute = () => Promise.resolve(token); patched = true; }
    } catch {}
  };
  if (kind === "recaptcha_v2" || kind === "recaptcha_v3") { wrap(window.grecaptcha); wrap(window.grecaptcha && window.grecaptcha.enterprise); }
  if (kind === "turnstile") wrap(window.turnstile);
  if (kind === "hcaptcha") wrap(window.hcaptcha);
  let called = 0;
  const call = (cb) => {
    try {
      const fn = typeof cb === "function" ? cb : typeof cb === "string" ? cb.split(".").reduce((o, k) => (o ? o[k] : undefined), window) : null;
      if (typeof fn === "function") { fn(token); called++; return true; }
    } catch {}
    return false;
  };
  for (const w of widgets) call(w.getAttribute("data-callback"));
  if (!called && (kind === "recaptcha_v2" || kind === "recaptcha_v3")) {
    const cfg = window.___grecaptcha_cfg;
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 6 || seen.has(o) || o.nodeType) return;
      seen.add(o);
      for (const k of Object.keys(o)) {
        let v;
        try { v = o[k]; } catch { continue; }
        if (k === "callback" && (typeof v === "function" || typeof v === "string") && (!o.sitekey || !sitekey || o.sitekey === sitekey)) call(v);
        else if (v && typeof v === "object") walk(v, depth + 1);
      }
    };
    if (cfg && cfg.clients) for (const c of Object.values(cfg.clients)) walk(c, 0);
  }
  return { filled, called, patched };
})`;

/* ------------------------------------------------------------------ */
/* Driver                                                               */
/* ------------------------------------------------------------------ */

export interface SolveOptions {
  /** Restrict to one kind; default: whatever is on the page. */
  kind?: Exclude<CaptchaKind, "cloudflare_challenge">;
  /** Image CAPTCHA: the picture and the field its text goes into. */
  imageSelector?: string;
  inputSelector?: string;
  caseSensitive?: boolean;
  urlContains?: string;
}

export interface SolveResult {
  ok: boolean;
  url: string;
  detail: string;
  kind?: CaptchaKind;
  solver?: SolverId | "local";
}

type BrowserHandle = { client: CdpClient; port?: number; chatPage?: (urlContains?: string) => PageTarget | null };

const TOKEN_TIMEOUT_MS = 150_000;
const CLICKABLE = new Set<CaptchaKind>(["recaptcha_v2", "hcaptcha", "turnstile", "cloudflare_challenge"]);
const IMAGE_TIMEOUT_MS = 60_000;

async function detect(sessions: PageSession[]): Promise<FoundCaptcha[]> {
  const found: FoundCaptcha[] = [];
  for (const [frame, s] of sessions.entries()) {
    try {
      const list = await s.evaluate<Omit<FoundCaptcha, "frame">[]>(DETECT, { timeoutMs: 8000 });
      for (const c of list ?? []) found.push({ ...c, frame });
    } catch {
      /* frame gone or navigating */
    }
  }
  // The widget the human would solve first: a visible challenge before script-only v3.
  const rank: Record<CaptchaKind, number> = { cloudflare_challenge: 0, recaptcha_v2: 1, turnstile: 2, hcaptcha: 3, recaptcha_v3: 4, image: 5 };
  return found.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

const MAX_IMAGE = { width: 600, height: 300 };

async function imageOf(page: PageSession, selector: string): Promise<string | null> {
  // Only a picture, and only CAPTCHA-sized: nothing else of the page goes to the service's workers.
  const box = await page.evaluate<{ x: number; y: number; width: number; height: number } | null>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      const pic = ["IMG", "CANVAS", "svg", "SVG"].includes(el.tagName) || (el.tagName === "INPUT" && el.type === "image") || getComputedStyle(el).backgroundImage.includes("url(");
      if (!pic) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }; })()`,
  );
  if (!box || box.width < 4 || box.height < 4 || box.width > MAX_IMAGE.width || box.height > MAX_IMAGE.height) return null;
  const { data } = await page.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
    captureBeyondViewport: true,
  });
  return data;
}

async function typeInto(page: PageSession, selector: string, text: string): Promise<boolean> {
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const ok = await page.evaluate<boolean>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || !("value" in el)) return false; el.focus(); el.select && el.select(); return true; })()`,
  );
  if (!ok) return false;
  await page.insertText(text);
  return page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).value.includes(${JSON.stringify(text)})`);
}

/** Why the daily limit stops another solve, or null. */
function limitReached(): string | null {
  const limit = getSettings().browser.captchaDailyLimit;
  if (limit > 0 && solvedToday() >= limit) {
    return `The daily limit of ${limit} CAPTCHAs is used up. Give the human a task to solve this one in the live view, or ask them to raise the limit in Settings → Browser.`;
  }
  return null;
}

/** Solve the CAPTCHA on an attached page and put the answer in. */
export async function solveOnPage(page: PageSession, url: string, opts: SolveOptions = {}): Promise<SolveResult> {
  const local = localSolverOn();
  const id = captchaSolverReady() ? activeSolver() : null;
  if (!id && !local) return { ok: false, url, detail: "CAPTCHA solving is off. The human can switch it on in Settings → Browser → CAPTCHA solving." };
  const label = id ? SOLVERS[id].label : "";

  if (opts.kind === "image" || opts.imageSelector) {
    if (!id) return { ok: false, url, kind: "image", detail: "Image CAPTCHAs need a solving service, and none is set up. Give the human a task to type it in the live view." };
    if (!opts.imageSelector || !opts.inputSelector) return { ok: false, url, detail: "For an image CAPTCHA pass imageSelector (the picture) and inputSelector (the field for its text)." };
    const image = await imageOf(page, opts.imageSelector);
    if (!image) return { ok: false, url, detail: `"${opts.imageSelector}" is not a CAPTCHA picture on the page (an img, canvas or svg up to ${MAX_IMAGE.width}×${MAX_IMAGE.height} px).` };
    const refused = limitReached();
    if (refused) return { ok: false, url, detail: refused };
    const task = buildTask(id, { kind: "image", image, caseSensitive: opts.caseSensitive });
    const solved = await solveTask(id, task!, IMAGE_TIMEOUT_MS, countSolve);
    if (!(await typeInto(page, opts.inputSelector, solved.answer))) return { ok: false, url, detail: `No text field matches "${opts.inputSelector}".` };
    return { ok: true, url, kind: "image", solver: id, detail: `${label} read the image CAPTCHA in ${solved.seconds} s and Godmode typed the text into ${opts.inputSelector}. Submit the form now; if the site says it was wrong, call captcha_solve again on the new image.` };
  }

  const frames = [page, ...(await childFrameSessions(page))];
  const found = (await detect(frames)).filter((c) => !opts.kind || c.kind === opts.kind);
  const target = found[0];
  if (!target) {
    return {
      ok: false,
      url,
      detail: opts.kind
        ? `No ${CAPTCHA_KIND_LABEL[opts.kind]} found on ${url}.`
        : `No reCAPTCHA, hCaptcha or Turnstile found on ${url}. For a picture with distorted text pass imageSelector and inputSelector. A puzzle that is none of these needs the human (live view).`,
    };
  }
  const what = CAPTCHA_KIND_LABEL[target.kind];
  const host = hostnameOf(target.url) || url;
  let clickNote = "";
  if (local && target.frame === 0 && CLICKABLE.has(target.kind) && !(target.kind === "recaptcha_v2" && target.invisible)) {
    const r = await clickSolve(page, target.kind as ClickKind);
    if (r.ok) {
      const how = r.clicked ? "clicked its checkbox and the site let the browser through" : "waited and it passed on its own";
      const next = target.kind === "cloudflare_challenge" ? "The page behind it is open now; carry on." : "Submit the form now if the site hasn't already continued.";
      return { ok: true, url, kind: target.kind, solver: "local", detail: `Godmode passed the ${what} on ${host} in ${r.seconds} s (it ${how}). ${next}` };
    }
    clickNote =
      r.reason === "challenge"
        ? `Godmode clicked the ${what} checkbox, but the site wants a picture puzzle. `
        : r.clicked
          ? `Godmode clicked the ${what} checkbox, but the site didn't let the browser through. `
          : "";
  }
  if (!id) {
    if (target.kind === "recaptcha_v3") return { ok: false, url, kind: target.kind, detail: `${what} has nothing to click: it rates the browser in the background. Just carry on; if the site turns you away, give the human a task to do it in the live view.` };
    return { ok: false, url, kind: target.kind, solver: "local", detail: `${clickNote}Give the human a task to solve the ${what} on ${host} in the live view. (A solving service in Settings → Browser → CAPTCHA solving could take these over.)` };
  }
  if (target.kind === "cloudflare_challenge") {
    return { ok: false, url, kind: target.kind, detail: `${clickNote}This is a ${what} ("Just a moment…"), which solving services can't pass from outside this browser. Wait 10 to 20 seconds and reload once; if it stays, give the human a task to pass it in the live view.` };
  }
  const task = buildTask(id, { kind: target.kind, found: target });
  if (!task) return { ok: false, url, kind: target.kind, detail: `${clickNote}${label} doesn't solve ${what}. Give the human a task to solve it in the live view.` };
  const refused = limitReached();
  if (refused) return { ok: false, url, kind: target.kind, detail: refused };

  const solved = await solveTask(id, task, TOKEN_TIMEOUT_MS, countSolve);
  const session = frames[target.frame] ?? page;
  const r = await session.evaluate<{ filled: number; called: number; patched: boolean }>(
    `(${INJECT})(${JSON.stringify({ kind: target.kind, token: solved.answer, sitekey: target.sitekey })})`,
    { timeoutMs: 10_000 },
  );
  const how = [
    r.filled ? `filled the answer into ${r.filled === 1 ? "the response field" : `${r.filled} response fields`}` : "",
    r.called ? "called the site's CAPTCHA callback" : "",
    r.patched ? "answered the page's CAPTCHA script" : "",
  ].filter(Boolean);
  if (!how.length) {
    return { ok: false, url, kind: target.kind, solver: id, detail: `${label} solved the ${what} on ${host}, but the page has no field or callback to take the answer. Give the human a task to solve it in the live view.` };
  }
  const next = r.called
    ? "The site may already have continued: check the page, and submit the form if it is still there."
    : "Submit the form now (the answer expires in about 2 minutes).";
  return {
    ok: true,
    url,
    kind: target.kind,
    solver: id,
    detail: `${label} solved the ${what} on ${host} in ${solved.seconds} s; Godmode ${how.join(" and ")}. ${next} The checkbox may still look unticked; that is fine. If the site rejects it, call captcha_solve once more.`,
  };
}

/** Solve on the chat's tab (or the active page) of a browser reached over CDP — Godmode's Chromium or a VM's Chrome. */
export async function solveInBrowser(browser: BrowserHandle, opts: SolveOptions = {}): Promise<SolveResult> {
  let page: PageSession | null = null;
  let url = "";
  try {
    const target = browser.chatPage ? browser.chatPage(opts.urlContains) : await pickActivePage(browser.client, { port: browser.port, urlContains: opts.urlContains });
    if (!target) {
      const detail = opts.urlContains
        ? `No open tab${browser.chatPage ? " of this chat" : ""} has a URL containing "${opts.urlContains}".`
        : browser.chatPage
          ? "This chat has no open tab yet. Open the page with the browser tools first."
          : "The browser has no open tab.";
      return { ok: false, url: "", detail };
    }
    url = target.url;
    page = await attachToPage(browser.client, target.targetId);
    return await solveOnPage(page, url, opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, url, detail: `Could not solve the CAPTCHA: ${detail}` };
  } finally {
    await page?.detach();
  }
}
