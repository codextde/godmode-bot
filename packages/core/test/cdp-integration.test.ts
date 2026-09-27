/**
 * Integration tests against a real managed Chromium (skipped when no Chromium-family browser is installed):
 * launch, secret filling by kind, split OTP boxes, cross-origin iframes, live view frames, human takeover,
 * cookie round-trips and importing sessions from another profile's cookie store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { bus } from "../src/events/bus";
import { findChrome } from "../src/browser/chrome";
import { attachToPage, getCookies, listPages, type PageSession } from "../src/browser/cdp";
import { getRunning } from "../src/browser/state";
import { startLiveView, stopLiveView, dispatchInput } from "../src/browser/screencast";
import * as manager from "../src/browser/manager";

const chrome = findChrome();
const suite = chrome && !process.env.GODMODE_SKIP_BROWSER_TESTS ? describe : describe.skip;

const LOGIN = `<!doctype html><title>Login</title>
<form id="f" onsubmit="event.preventDefault(); window.__submitted = (window.__submitted || 0) + 1;">
  <label>Email <input id="user" name="login" autocomplete="username"></label>
  <input id="pass" type="password" name="password">
  <textarea id="note"></textarea>
  <input id="search" type="search" name="q">
  <button>Sign in</button>
</form>
<script>
  window.__inputEvents = 0;
  document.getElementById("pass").addEventListener("input", () => window.__inputEvents++);
</script>`;

const OTP_SPLIT = `<!doctype html><title>Verify</title>
<div class="otp">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="d" data-i="${i}" maxlength="1" inputmode="numeric">`).join("")}</div>`;

const OTP_SINGLE = `<!doctype html><title>2FA</title>
<p>Enter the code from your authenticator</p>
<input id="name" name="display_name" placeholder="Name" value="keep me">
<input id="code" name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6">`;

const OUTER = (innerOrigin: string) => `<!doctype html><title>Outer</title>
<h1>Embedded login</h1><iframe id="login" src="${innerOrigin}/inner" width="400" height="300"></iframe>`;

const INNER = `<!doctype html><title>Inner</title><input id="ipass" type="password" name="pw">`;

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let dataDir = "";

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(100);
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ""}`);
}

/** A separate CDP session on the page whose URL contains `needle` (to verify results independently). */
async function pageSession(profileId: string, needle: string): Promise<PageSession> {
  const rb = getRunning(profileId)!;
  const page = await waitFor(async () => (await listPages(rb.client)).find((p) => p.url.includes(needle)));
  return attachToPage(rb.client, page.targetId);
}

async function evalOn<T>(profileId: string, needle: string, expr: string): Promise<T> {
  const s = await pageSession(profileId, needle);
  try {
    return await s.evaluate<T>(expr);
  } finally {
    await s.detach();
  }
}

async function openPage(profileId: string, path: string) {
  await manager.navigate(profileId, `${origin}${path}`);
  await waitFor(() => evalOn<boolean>(profileId, path, "document.readyState === 'complete'"));
}

suite("managed Chromium (CDP integration)", () => {
  let profileId = "";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "godmode-cdp-test-"));
    const cfg = loadConfig({ dataDir });
    openDb(cfg.dbPath);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
        switch (url.pathname) {
          case "/login":
            return html(LOGIN);
          case "/otp-split":
            return html(OTP_SPLIT);
          case "/otp":
            return html(OTP_SINGLE);
          case "/outer":
            // localhost vs 127.0.0.1 are different sites → the iframe runs out of process.
            return html(OUTER(`http://localhost:${server.port}`));
          case "/inner":
            return html(INNER);
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    manager.ensureDefaultProfile();
    profileId = manager.createProfile({ name: "Integration", workspaceId: null }).id;
    await manager.launchBrowser(profileId, { headless: true });
  }, 60_000);

  afterAll(async () => {
    await manager.shutdownBrowsers();
    server?.stop(true);
    closeDb();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  test("launch reports a live CDP endpoint and reuses the running browser", async () => {
    const profile = manager.getProfile(profileId);
    expect(profile.running).toBe(true);
    expect(profile.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const again = await manager.launchBrowser(profileId);
    expect(again.cdpUrl).toBe(profile.cdpUrl!);
    const res = await fetch(`${profile.cdpUrl}/json/version`);
    expect(res.ok).toBe(true);
  });

  test("fills username and password by kind without a selector (and never into the focused wrong field)", async () => {
    await openPage(profileId, "/login");
    const user = await manager.fillIntoPage(profileId, { text: "alice@example.com", kind: "username" });
    expect(user.ok).toBe(true);
    expect(user.url).toContain("/login");
    // The username field is focused now; a password fill must still go to the password input.
    const pass = await manager.fillIntoPage(profileId, { text: "s3cr3t-P@ss!", kind: "password" });
    expect(pass.ok).toBe(true);
    expect(pass.detail).not.toContain("s3cr3t");
    expect(user.detail).not.toContain("alice");
    const values = await evalOn<{ user: string; pass: string; events: number }>(
      profileId,
      "/login",
      "({ user: document.getElementById('user').value, pass: document.getElementById('pass').value, events: window.__inputEvents })",
    );
    expect(values.user).toBe("alice@example.com");
    expect(values.pass).toBe("s3cr3t-P@ss!");
    expect(values.events).toBeGreaterThan(0);
  }, 30_000);

  test("replaces existing content, honours selectors and submits with Enter", async () => {
    const again = await manager.fillIntoPage(profileId, { text: "bob@example.com", kind: "username" });
    expect(again.ok).toBe(true);
    const note = await manager.fillIntoPage(profileId, { text: "hello world", selector: "#note" });
    expect(note.ok).toBe(true);
    const submit = await manager.fillIntoPage(profileId, { text: "another-secret", kind: "password", submit: true });
    expect(submit.ok).toBe(true);
    const values = await evalOn<{ user: string; pass: string; note: string; submitted: number }>(
      profileId,
      "/login",
      "({ user: user.value, pass: pass.value, note: note.value, submitted: window.__submitted || 0 })",
    );
    expect(values).toEqual({ user: "bob@example.com", pass: "another-secret", note: "hello world", submitted: 1 });
  }, 30_000);

  test("refuses to type a password into a non-password field and reports bad selectors", async () => {
    const refused = await manager.fillIntoPage(profileId, { text: "should-not-appear", kind: "password", selector: "#search" });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("Refusing");
    const missing = await manager.fillIntoPage(profileId, { text: "x", selector: "#does-not-exist" });
    expect(missing.ok).toBe(false);
    const invalid = await manager.fillIntoPage(profileId, { text: "x", selector: "##" });
    expect(invalid.ok).toBe(false);
    const search = await evalOn<string>(profileId, "/login", "document.getElementById('search').value");
    expect(search).toBe("");
  }, 30_000);

  test("types a TOTP code into split one-digit boxes", async () => {
    await openPage(profileId, "/otp-split");
    const res = await manager.fillIntoPage(profileId, { text: "493027", kind: "totp" });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("6 one-digit boxes");
    const digits = await evalOn<string>(profileId, "/otp-split", "[...document.querySelectorAll('input.d')].map((i) => i.value).join('')");
    expect(digits).toBe("493027");
  }, 30_000);

  test("finds a single one-time-code input and leaves other fields alone", async () => {
    await openPage(profileId, "/otp");
    const res = await manager.fillIntoPage(profileId, { text: "112233", kind: "totp" });
    expect(res.ok).toBe(true);
    const values = await evalOn<{ code: string; name: string }>(profileId, "/otp", "({ code: code.value, name: document.getElementById('name').value })");
    expect(values).toEqual({ code: "112233", name: "keep me" });
  }, 30_000);

  test("fills a password inside a cross-origin iframe", async () => {
    await openPage(profileId, "/outer");
    const rb = getRunning(profileId)!;
    await waitFor(async () => {
      const { targetInfos } = await rb.client.send<{ targetInfos: { type: string; url: string }[] }>("Target.getTargets");
      return targetInfos.some((t) => t.type === "iframe" && t.url.includes("/inner"));
    });
    const res = await manager.fillIntoPage(profileId, { text: "frame-secret", kind: "password" });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("embedded frame");
    const { targetInfos } = await rb.client.send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
    const frame = targetInfos.find((t) => t.type === "iframe" && t.url.includes("/inner"))!;
    const s = await attachToPage(rb.client, frame.targetId);
    try {
      expect(await s.evaluate<string>("document.getElementById('ipass').value")).toBe("frame-secret");
    } finally {
      await s.detach();
    }
  }, 30_000);

  test("currentPage returns the active tab", async () => {
    const page = await manager.currentPage(profileId);
    expect(page?.url).toContain("/outer");
    expect(page?.title).toBe("Outer");
  });

  test("live view emits frames and human takeover types into the page", async () => {
    await openPage(profileId, "/login");
    const frames: Extract<ServerEvent, { type: "browser.frame" }>[] = [];
    const off = bus.on((e) => {
      if (e.type === "browser.frame" && e.profileId === profileId) frames.push(e);
    });
    try {
      await startLiveView(profileId);
      const frame = await waitFor(() => frames[0], 15_000);
      expect(frame.data.length).toBeGreaterThan(100);
      expect(frame.width).toBeGreaterThan(100);
      expect(frame.height).toBeGreaterThan(100);
      expect(frame.url).toContain("/login");
      expect(Buffer.from(frame.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG

      // Click into the (empty) textarea using frame coordinates, then type.
      const rect = await evalOn<{ x: number; y: number }>(profileId, "/login", "(() => { note.value = ''; const r = note.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      await dispatchInput(profileId, { type: "click", x: rect.x, y: rect.y });
      await dispatchInput(profileId, { type: "text", text: "typed by human" });
      await dispatchInput(profileId, { type: "key", key: "Enter" });
      await dispatchInput(profileId, { type: "text", text: "line 2" });
      const note = await evalOn<string>(profileId, "/login", "note.value");
      expect(note).toBe("typed by human\nline 2");
      await dispatchInput(profileId, { type: "scroll", x: 100, y: 100, deltaY: 200 });
    } finally {
      off();
      await stopLiveView(profileId);
    }
  }, 40_000);

  test("imports cookie JSON (Cookie-Editor, Playwright, CDP) and keeps host-only cookies host-only", async () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const cookieEditor = [
      { domain: ".example.com", hostOnly: false, name: "ce_domain", value: "1", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: future },
      { domain: "app.example.com", hostOnly: true, name: "ce_host", value: "2", path: "/", secure: true, httpOnly: false, sameSite: "lax", session: true },
      { domain: ".example.com", name: "ce_expired", value: "x", path: "/", secure: true, expirationDate: 1000 },
    ];
    const r1 = await manager.importChromeSession(profileId, { cookiesJson: JSON.stringify(cookieEditor) });
    expect(r1.imported).toBe(2);
    expect(r1.skipped).toBe(1);
    expect(r1.method).toBe("json");

    const playwright = { cookies: [{ name: "pw", value: "3", domain: "shop.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Strict" }], origins: [] };
    const r2 = await manager.importChromeSession(profileId, { cookiesJson: JSON.stringify(playwright), domains: ["shop.test"] });
    expect(r2.imported).toBe(1);

    const cdp = [{ name: "cdp", value: "4", domain: ".other.test", path: "/", expires: future, size: 4, httpOnly: false, secure: true, session: false, sameSite: "Lax", priority: "Medium" }];
    await expect(manager.importChromeSession(profileId, { cookiesJson: JSON.stringify(cdp), domains: ["nomatch.test"] })).rejects.toThrow("No cookies match nomatch.test");
    await expect(manager.importChromeSession(profileId, { cookiesJson: "not json" })).rejects.toThrow("Cookie data must be JSON");
  }, 30_000);

  test("cookie store round-trip reflects the imports", async () => {
    const rb = getRunning(profileId)!;
    const cookies = await getCookies(rb.client);
    const byName = new Map(cookies.map((c) => [c.name, c]));
    expect(byName.get("ce_domain")?.domain).toBe(".example.com");
    expect(byName.get("ce_domain")?.httpOnly).toBe(true);
    expect(byName.get("ce_domain")?.sameSite).toBe("None");
    expect(byName.get("ce_host")?.domain).toBe("app.example.com");
    expect(byName.get("ce_host")?.session).toBe(true);
    expect(byName.get("pw")?.domain).toBe("shop.test");
    expect(byName.has("ce_expired")).toBe(false);
    expect(byName.has("cdp")).toBe(false);
    expect(manager.getProfile(profileId).cookieCount).toBe(cookies.length);
  });

  test("imports sessions from another profile's cookie store (profile-use technique)", async () => {
    // Stop the source browser so its cookie store is flushed to disk, then import it into a fresh profile.
    await manager.stopBrowser(profileId);
    expect(manager.getProfile(profileId).running).toBe(false);
    const source = manager.getProfile(profileId);
    const target = manager.createProfile({ name: "Imported", workspaceId: null });
    const result = await manager.importChromeSession(target.id, { sourcePath: join(source.userDataDir, "Default"), domains: ["example.com"] });
    expect(result.method).toBe("cdp");
    expect(result.imported).toBeGreaterThanOrEqual(1);
    expect(result.domains).toContain("example.com");
    // The target was started only for the import and is stopped again; relaunch and check the cookie persisted.
    expect(manager.getProfile(target.id).running).toBe(false);
    await manager.launchBrowser(target.id, { headless: true });
    const cookies = await getCookies(getRunning(target.id)!.client);
    expect(cookies.find((c) => c.name === "ce_domain")?.value).toBe("1");
    expect(cookies.find((c) => c.name === "pw")).toBeUndefined(); // filtered by domains
    expect(manager.getProfile(target.id).importedFrom).toBeTruthy();
    await manager.stopBrowser(target.id);
  }, 90_000);
});
