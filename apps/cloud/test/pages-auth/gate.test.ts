import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { contentSecurityPolicy, gateRedirect } from "@/app/setup/_lib/gate";
import { config, proxy } from "@/proxy";
import { createSession, sessionCookieName } from "@/server/auth/sessions";
import { db, sessions } from "@/server/db";
import { bootstrapData, finishSetup } from "@/server/setup";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { makeUser } from "../platform/fixtures";

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await bootstrapData();
});
afterAll(closeDatabase);

describe("gateRedirect", () => {
  test("claim: everything but /setup goes to /setup", () => {
    expect(gateRedirect("claim", "/")).toBe("/setup");
    expect(gateRedirect("claim", "/login")).toBe("/setup");
    expect(gateRedirect("claim", "/invite/abc")).toBe("/setup");
    expect(gateRedirect("claim", "/setup")).toBeNull();
  });
  test("wizard: sign-in, sign-out and invitations work, the rest goes to /setup", () => {
    expect(gateRedirect("wizard", "/login")).toBeNull();
    expect(gateRedirect("wizard", "/auth/verify")).toBeNull();
    expect(gateRedirect("wizard", "/logout")).toBeNull();
    expect(gateRedirect("wizard", "/invite/abc")).toBeNull();
    expect(gateRedirect("wizard", "/setup")).toBeNull();
    expect(gateRedirect("wizard", "/")).toBe("/setup");
    expect(gateRedirect("wizard", "/devices")).toBe("/setup");
    expect(gateRedirect("wizard", "/admin/users")).toBe("/setup");
  });
  test("done: /setup leads home, nothing else is touched", () => {
    expect(gateRedirect("done", "/setup")).toBe("/");
    expect(gateRedirect("done", "/setup/")).toBe("/");
    expect(gateRedirect("done", "/")).toBeNull();
    expect(gateRedirect("done", "/login")).toBeNull();
    expect(gateRedirect("done", "/setupx")).toBeNull();
  });
});

describe("contentSecurityPolicy", () => {
  test("allows eval only in development", () => {
    const prod = contentSecurityPolicy("abc", false);
    expect(prod).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("form-action 'self' https://checkout.stripe.com https://billing.stripe.com");
    expect(contentSecurityPolicy("abc", true)).toContain("'strict-dynamic' 'unsafe-eval'");
  });
});

describe("matcher", () => {
  const pattern = new RegExp(`^${config.matcher[0]!.replace(/\(\(\?!/, "((?!")}$`);
  const matches = (path: string) => pattern.test(path);
  test("skips machine APIs, relay paths and files", () => {
    for (const path of ["/api/health", "/api/stripe/webhook", "/api/device/v1/me", "/ui/index.js", "/d/dvc_1/", "/gw/dvc_1/api/health", "/relay/v1/connect", "/_next/static/x.js", "/_next/image", "/theme-init.js", "/icon.svg"]) {
      expect(matches(path), path).toBe(false);
    }
  });
  test("covers pages", () => {
    for (const path of ["/", "/login", "/setup", "/auth/verify", "/invite/abcDEF_-123", "/admin/users", "/devices/dvc_1"]) {
      expect(matches(path), path).toBe(true);
    }
  });
});

const html = { accept: "text/html,application/xhtml+xml" };
const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3210${path}`, { headers });

describe("proxy", () => {
  test("sends every page to /setup while nobody has an account, with a relative Location", async () => {
    const response = await proxy(req("/login", html));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/setup");
    expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    const ok = await proxy(req("/setup", html));
    expect(ok.status).toBe(200);
  });

  test("forwards the nonce, CSP and path, and sets security headers", async () => {
    await makeUser({ role: "owner" });
    const response = await proxy(req("/login?next=%2Fbilling", html));
    expect(response.status).toBe(200);
    const nonce = response.headers.get("x-middleware-request-x-nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/login?next=%2Fbilling");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    // Two requests never share a nonce.
    const again = await proxy(req("/login", html));
    expect(again.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
  });

  test("drops the RSC request id from x-pathname", async () => {
    await finishSetup(await makeUser({ role: "owner" }));
    const response = await proxy(req("/devices?_rsc=abc&page=2", { rsc: "1" }));
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/devices?page=2");
  });

  test("wizard: /login works, other pages go to /setup; done: /setup goes home", async () => {
    const owner = await makeUser({ role: "owner" });
    expect((await proxy(req("/login", html))).status).toBe(200);
    expect((await proxy(req("/invite/abc", html))).status).toBe(200);
    expect(new URL((await proxy(req("/devices", html))).headers.get("location")!).pathname).toBe("/setup");
    await finishSetup(owner);
    expect(new URL((await proxy(req("/setup", html))).headers.get("location")!).pathname).toBe("/");
    expect((await proxy(req("/devices", html))).status).toBe(200);
  });

  test("does not redirect form posts (server actions check for themselves)", async () => {
    const response = await proxy(new NextRequest("http://localhost:3210/devices", { method: "POST", headers: html }));
    expect(response.status).toBe(200);
  });

  test("re-sends the session cookie on a page load when the session was extended", async () => {
    const owner = await makeUser({ role: "owner" });
    await finishSetup(owner);
    const { token, session } = await createSession(owner.user.id, { ip: "127.0.0.1", userAgent: null });
    const cookie = `${sessionCookieName()}=${token}`;
    // Fresh session: nothing to re-send.
    const fresh = await proxy(req("/devices", { ...html, cookie }));
    expect(fresh.headers.get("set-cookie")).toBeNull();
    // Less than half of the lifetime left: validateSessionToken extends it and the cookie follows.
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(sessions.id, session.id));
    const renewed = await proxy(req("/devices", { ...html, cookie }));
    const header = renewed.headers.get("set-cookie") ?? "";
    expect(header).toContain(`${sessionCookieName()}=${token}`);
    expect(header.toLowerCase()).toContain("httponly");
    expect(header).toMatch(/Expires=/);
    // An RSC navigation is left alone (no extra query).
    const rsc = await proxy(req("/devices", { rsc: "1", cookie }));
    expect(rsc.headers.get("set-cookie")).toBeNull();
    // A revoked session gets nothing.
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
    expect((await proxy(req("/devices", { ...html, cookie }))).headers.get("set-cookie")).toBeNull();
  });
});
