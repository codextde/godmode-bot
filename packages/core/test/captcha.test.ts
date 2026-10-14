/**
 * CAPTCHA solving: task types per service, the createTask / getTaskResult loop, the daily limit, and (with a real
 * Chromium) finding widgets on a page and putting the answer in. The solving service is always a fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb, setMeta } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import * as vault from "../src/vault/vault";
import { findChrome } from "../src/browser/chrome";
import { attachToPage, listPages } from "../src/browser/cdp";
import { getRunning } from "../src/browser/state";
import * as manager from "../src/browser/manager";
import {
  __setCaptchaFetchForTests,
  __setCaptchaPollForTests,
  buildTask,
  captchaSolverReady,
  captchaStatus,
  solveTask,
  solverBalance,
  type FoundCaptcha,
} from "../src/browser/captcha";

const KEY = "cap_test_key_0123456789";
let dataDir = "";

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
/** Fake service: createTask → id 7; getTaskResult → processing once, then ready. */
function fakeService(answer: { createTask?: Record<string, unknown>; result?: Record<string, unknown> } = {}) {
  let polls = 0;
  calls = [];
  __setCaptchaFetchForTests(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    const method = url.split("/").pop();
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (method === "getBalance") return json({ errorId: 0, balance: 4.21 });
    if (method === "createTask") {
      if (body.task?.type === "ImageToTextTask") return json({ errorId: 0, taskId: "img", status: "ready", solution: { text: "W68HP" } });
      return json(answer.createTask ?? { errorId: 0, taskId: 7 });
    }
    polls++;
    if (polls === 1) return json({ errorId: 0, status: "processing" });
    return json(answer.result ?? { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "TOKEN-123", token: "TOKEN-123" }, cost: "0.00299" });
  });
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-captcha-"));
  const cfg = loadConfig({ dataDir });
  openDb(cfg.dbPath);
  resetSettingsCache();
  await vault.setup("correct horse battery staple", false);
  __setCaptchaPollForTests(5);
});

afterAll(() => {
  __setCaptchaFetchForTests(null);
  __setCaptchaPollForTests(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const found = (over: Partial<FoundCaptcha>): FoundCaptcha => ({ kind: "recaptcha_v2", sitekey: "6Lkey", url: "https://shop.example/login", frame: 0, ...over });

describe("tasks per service", () => {
  test("reCAPTCHA v2, invisible and enterprise", () => {
    expect(buildTask("2captcha", { kind: "recaptcha_v2", found: found({ invisible: true, s: "SVAL" }) })).toEqual({
      type: "RecaptchaV2TaskProxyless",
      websiteURL: "https://shop.example/login",
      websiteKey: "6Lkey",
      isInvisible: true,
      recaptchaDataSValue: "SVAL",
    });
    expect(buildTask("capsolver", { kind: "recaptcha_v2", found: found({}) })?.type).toBe("ReCaptchaV2TaskProxyLess");
    expect(buildTask("capsolver", { kind: "recaptcha_v2", found: found({ enterprise: true }) })?.type).toBe("ReCaptchaV2EnterpriseTaskProxyLess");
    expect(buildTask("anticaptcha", { kind: "recaptcha_v2", found: found({ enterprise: true }) })?.type).toBe("RecaptchaV2EnterpriseTaskProxyless");
  });

  test("reCAPTCHA v3 asks for a good score", () => {
    expect(buildTask("2captcha", { kind: "recaptcha_v3", found: found({ kind: "recaptcha_v3", action: "login" }) })).toMatchObject({ type: "RecaptchaV3TaskProxyless", minScore: 0.7, pageAction: "login" });
    expect(buildTask("capsolver", { kind: "recaptcha_v3", found: found({ kind: "recaptcha_v3", enterprise: true }) })?.type).toBe("ReCaptchaV3EnterpriseTaskProxyLess");
  });

  test("Turnstile carries action and cData the way each service wants them", () => {
    const t = found({ kind: "turnstile", sitekey: "0x4AAAAAAAkey", action: "signup", cdata: "cd" });
    expect(buildTask("2captcha", { kind: "turnstile", found: t })).toMatchObject({ type: "TurnstileTaskProxyless", action: "signup", data: "cd" });
    expect(buildTask("capsolver", { kind: "turnstile", found: t })).toMatchObject({ type: "AntiTurnstileTaskProxyLess", metadata: { action: "signup", cdata: "cd" } });
    expect(buildTask("anticaptcha", { kind: "turnstile", found: t })).not.toHaveProperty("data");
  });

  test("hCaptcha is not offered; images are", () => {
    expect(buildTask("2captcha", { kind: "hcaptcha", found: found({ kind: "hcaptcha" }) })).toBeNull();
    expect(buildTask("capsolver", { kind: "image", image: "iVBOR" })).toEqual({ type: "ImageToTextTask", body: "iVBOR" });
    expect(buildTask("2captcha", { kind: "image", image: "iVBOR", caseSensitive: true })).toEqual({ type: "ImageToTextTask", body: "iVBOR", case: true });
  });
});

describe("service API", () => {
  beforeEach(() => {
    updateSettings({ browser: { captchaSolver: "2captcha", captchaDailyLimit: 30 } });
    vault.setAppSecret("twocaptcha_api_key", KEY);
  });

  test("ready only with a solver and its key", () => {
    expect(captchaSolverReady()).toBe(true);
    expect(captchaStatus()).toMatchObject({ solver: "2captcha", hasApiKey: true, secretKey: "twocaptcha_api_key", dailyLimit: 30 });
    vault.setAppSecret("twocaptcha_api_key", null);
    expect(captchaSolverReady()).toBe(false);
    updateSettings({ browser: { captchaSolver: "off" } });
    expect(captchaStatus()).toMatchObject({ solver: "off", hasApiKey: false, secretKey: null });
  });

  test("creates the task, polls until ready and returns the token", async () => {
    fakeService();
    const r = await solveTask("2captcha", { type: "RecaptchaV2TaskProxyless", websiteURL: "https://x.test", websiteKey: "k" }, 5000);
    expect(r.answer).toBe("TOKEN-123");
    expect(r.cost).toBeCloseTo(0.00299);
    expect(calls.map((c) => c.url)).toEqual(["https://api.2captcha.com/createTask", "https://api.2captcha.com/getTaskResult", "https://api.2captcha.com/getTaskResult"]);
    expect(calls[0]!.body.clientKey).toBe(KEY);
    expect(calls[1]!.body.taskId).toBe(7);
  });

  test("a dropped connection while polling is retried", async () => {
    let n = 0;
    __setCaptchaFetchForTests(async (url) => {
      if (url.endsWith("createTask")) return new Response(JSON.stringify({ errorId: 0, taskId: 3 }));
      if (++n === 1) throw new Error("socket hang up");
      if (n === 2) return new Response("<html>502</html>", { status: 502 });
      return new Response(JSON.stringify({ errorId: 0, status: "ready", solution: { token: "T" } }));
    });
    expect((await solveTask("2captcha", { type: "TurnstileTaskProxyless" }, 5000)).answer).toBe("T");
  });

  test("explains service errors without the key", async () => {
    fakeService({ createTask: { errorId: 10, errorCode: "ERROR_ZERO_BALANCE", errorDescription: `no money for ${KEY}` } });
    const err = await solveTask("2captcha", { type: "RecaptchaV2TaskProxyless" }, 5000).then(() => new Error("solved"), (e: Error) => e);
    expect(err.message).toContain("no balance left");
    expect(err.message).not.toContain(KEY);
    fakeService({ createTask: { errorId: 1, errorCode: "ERROR_SOMETHING", errorDescription: `bad key ${KEY}` } });
    const err2 = await solveTask("2captcha", { type: "RecaptchaV2TaskProxyless" }, 5000).then(() => new Error("solved"), (e: Error) => e);
    expect(err2.message).not.toContain(KEY);
  });

  test("gives up when the service takes too long", async () => {
    calls = [];
    __setCaptchaFetchForTests(async (url) => new Response(JSON.stringify(url.endsWith("createTask") ? { errorId: 0, taskId: 1 } : { errorId: 0, status: "processing" })));
    const err = await solveTask("2captcha", { type: "RecaptchaV2TaskProxyless" }, 50).then(() => new Error("solved"), (e: Error) => e);
    expect(err.message).toContain("did not answer");
  });

  test("balance", async () => {
    fakeService();
    expect(await solverBalance()).toBeCloseTo(4.21);
  });
});

/* ------------------------------------------------------------------ */
/* Real browser                                                         */
/* ------------------------------------------------------------------ */

const RECAPTCHA = `<!doctype html><title>Sign up</title>
<form id="f"><input name="email"><div class="g-recaptcha" data-sitekey="6LcV2key" data-callback="onCaptcha"></div>
<textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea><button>Go</button></form>
<script>window.onCaptcha = (t) => { window.__callback = t; };</script>`;

const TURNSTILE = `<!doctype html><title>Contact</title>
<form><div class="cf-turnstile" data-sitekey="0x4AAAAAAAturnstile" data-action="contact"></div><button>Send</button></form>`;

const V3 = `<!doctype html><title>Login</title>
<script>window.grecaptcha = { execute: () => Promise.resolve("REAL"), getResponse: () => "", ready: (f) => f() };</script>
<script src="/recaptcha/api.js?render=6LcV3key_0123456789abcdef"></script>
<script>grecaptcha.ready(() => grecaptcha.execute("6LcV3key_0123456789abcdef", { action: "login" }));</script>
<iframe title="reCAPTCHA" width="256" height="60" src="/recaptcha/api2/anchor?ar=1&k=6LcV3key_0123456789abcdef&co=x&hl=en&size=invisible"></iframe>
<form><input name="user"><button>Log in</button></form>`;

const IMAGE = `<!doctype html><title>Old form</title>
<img id="cap" width="160" height="50" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="50"><rect width="160" height="50" fill="#eee"/><text x="20" y="35" font-size="28">W68HP</text></svg>')}">
<input id="answer" name="captcha">`;

const NONE = `<!doctype html><title>Plain</title><p>Nothing to solve</p>`;

const chrome = findChrome();
const browserSuite = chrome && !process.env.GODMODE_SKIP_BROWSER_TESTS ? describe : describe.skip;

browserSuite("on a page", () => {
  let server: ReturnType<typeof Bun.serve>;
  let profileId = "";
  let origin = "";

  const open = async (path: string) => {
    await manager.navigate(profileId, `${origin}${path}`);
    const rb = getRunning(profileId)!;
    for (let i = 0; i < 100; i++) {
      const page = (await listPages(rb.client)).find((p) => p.url.endsWith(path));
      if (page) {
        const s = await attachToPage(rb.client, page.targetId);
        try {
          if ((await s.evaluate<string>("document.readyState")) === "complete") return;
        } finally {
          await s.detach();
        }
      }
      await Bun.sleep(100);
    }
    throw new Error(`${path} did not load`);
  };
  const evalOn = async <T,>(path: string, expr: string): Promise<T> => {
    const rb = getRunning(profileId)!;
    const page = (await listPages(rb.client)).find((p) => p.url.endsWith(path))!;
    const s = await attachToPage(rb.client, page.targetId);
    try {
      return await s.evaluate<T>(expr);
    } finally {
      await s.detach();
    }
  };

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const html = (b: string) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8" } });
        const path = new URL(req.url).pathname;
        if (path === "/recaptcha/api2/anchor") return html("<p>badge</p>");
        if (path === "/recaptcha/api.js") return new Response("", { headers: { "content-type": "text/javascript" } });
        const pages: Record<string, string> = { "/recaptcha": RECAPTCHA, "/turnstile": TURNSTILE, "/v3": V3, "/image": IMAGE, "/none": NONE };
        return pages[path] ? html(pages[path]!) : new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    manager.ensureDefaultProfile();
    profileId = manager.createProfile({ name: "Captcha", workspaceId: null }).id;
    await manager.launchBrowser(profileId, { headless: true });
  }, 60_000);

  afterAll(async () => {
    await manager.shutdownBrowsers();
    server?.stop(true);
  }, 60_000);

  beforeEach(() => {
    updateSettings({ browser: { captchaSolver: "2captcha", captchaDailyLimit: 30 } });
    vault.setAppSecret("twocaptcha_api_key", KEY);
    fakeService();
  });

  test("reCAPTCHA v2: token in the response field and the site's callback called", async () => {
    await open("/recaptcha");
    const r = await manager.solveCaptchaInPage(profileId, {});
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("recaptcha_v2");
    expect(r.detail).not.toContain("TOKEN-123");
    expect(calls[0]!.body.task).toMatchObject({ type: "RecaptchaV2TaskProxyless", websiteKey: "6LcV2key", websiteURL: `${origin}/recaptcha` });
    expect(await evalOn<string>("/recaptcha", "document.getElementById('g-recaptcha-response').value")).toBe("TOKEN-123");
    expect(await evalOn<string>("/recaptcha", "window.__callback")).toBe("TOKEN-123");
  }, 30_000);

  test("Turnstile: adds the response field to the form", async () => {
    await open("/turnstile");
    const r = await manager.solveCaptchaInPage(profileId, {});
    expect(r.ok).toBe(true);
    expect(calls[0]!.body.task).toMatchObject({ type: "TurnstileTaskProxyless", websiteKey: "0x4AAAAAAAturnstile", action: "contact" });
    expect(await evalOn<string>("/turnstile", "document.querySelector('form input[name=cf-turnstile-response]').value")).toBe("TOKEN-123");
  }, 30_000);

  test("reCAPTCHA v3: the page's execute() answers with the token", async () => {
    await open("/v3");
    const r = await manager.solveCaptchaInPage(profileId, {});
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("recaptcha_v3");
    expect(calls[0]!.body.task).toMatchObject({ type: "RecaptchaV3TaskProxyless", websiteKey: "6LcV3key_0123456789abcdef", pageAction: "login" });
    expect(await evalOn<string>("/v3", "grecaptcha.execute('6LcV3key_0123456789abcdef', { action: 'login' })")).toBe("TOKEN-123");
  }, 30_000);

  test("image CAPTCHA: sends the picture and types the text", async () => {
    await open("/image");
    const r = await manager.solveCaptchaInPage(profileId, { imageSelector: "#cap", inputSelector: "#answer" });
    expect(r.ok).toBe(true);
    const task = calls[0]!.body.task as { type: string; body: string };
    expect(task.type).toBe("ImageToTextTask");
    expect(Buffer.from(task.body, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(await evalOn<string>("/image", "document.getElementById('answer').value")).toBe("W68HP");
  }, 30_000);

  test("nothing on the page: no task, no count", async () => {
    await open("/none");
    const before = captchaStatus().solvedToday;
    const r = await manager.solveCaptchaInPage(profileId, {});
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(captchaStatus().solvedToday).toBe(before);
  }, 30_000);

  test("an image selector must point at a picture", async () => {
    await open("/image");
    const r = await manager.solveCaptchaInPage(profileId, { imageSelector: "body", inputSelector: "#answer" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  }, 30_000);

  test("stops at the daily limit", async () => {
    await open("/recaptcha");
    const d = new Date();
    setMeta(`captcha.solved.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, "5");
    updateSettings({ browser: { captchaDailyLimit: 5 } });
    const r = await manager.solveCaptchaInPage(profileId, {});
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("daily limit");
    expect(calls).toHaveLength(0);
  }, 30_000);
});
