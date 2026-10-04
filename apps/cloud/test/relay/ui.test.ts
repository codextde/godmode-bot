import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { CloudUiContext } from "@godmode/shared";
import { db, deviceAccess, devices, sessions } from "@/server/db";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { INDEX_HTML, PUBLIC_URL, UI_DIR, baseline, call, makeDevice, makeUser, startCloud, writeUiBuild, type Running, type TestDevice, type TestUser } from "./harness";

let cloud: Running;
let owner: TestUser;
let device: TestDevice;

beforeAll(resetDatabase);
afterAll(closeDatabase);

beforeEach(async () => {
  await truncateAll();
  writeUiBuild();
  cloud = await startCloud();
  await baseline(cloud);
  owner = await makeUser("owner@example.com", "role_owner");
  device = await makeDevice(owner.id);
});

afterEach(async () => {
  await cloud.close();
});

function metaContext(html: string): CloudUiContext {
  const match = /<head><meta name="godmode-cloud" content="([^"]*)">/.exec(html);
  if (!match) throw new Error("no meta tag right after <head>");
  const decoded = match[1]!.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  return JSON.parse(decoded) as CloudUiContext;
}

describe("own endpoints", () => {
  test("/api/health answers without Next or the database", async () => {
    const res = await call(cloud.port, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, name: "godmode-cloud", version: "1.2.3" });
  });

  test("everything else goes to Next with the socket's address in x-godmode-peer, never the client's", async () => {
    const res = await call(cloud.port, "GET", "/login?next=/devices", { "x-godmode-peer": "203.0.113.1" });
    expect(res.json()).toEqual({ next: true, url: "/login?next=/devices", peer: "127.0.0.1" });
  });

  test("/relay, /d and /gw never reach Next", async () => {
    for (const path of ["/relay/v1/connect", "/d", "/d/", "/gw", `/gw/${device.id}`, "/d/nope/api/x"]) {
      const res = await call(cloud.port, "GET", path);
      expect(res.status, path).toBe(404);
      expect(res.json().next, path).toBeUndefined();
    }
  });
});

describe("/ui static files", () => {
  test("assets are served with long caching, other files revalidate; all with nosniff", async () => {
    const asset = await call(cloud.port, "GET", "/ui/assets/app-1a2b.js");
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("console.log('app');");
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    const logo = await call(cloud.port, "GET", "/ui/logo.svg");
    expect(logo.headers["content-type"]).toBe("image/svg+xml");
    expect(logo.headers["cache-control"]).toBe("no-cache");
    const again = await call(cloud.port, "GET", "/ui/logo.svg", { "if-modified-since": logo.headers["last-modified"]! });
    expect(again.status).toBe(304);
    const head = await call(cloud.port, "HEAD", "/ui/assets/app-1a2b.js");
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
  });

  test("the page itself is not public", async () => {
    for (const path of ["/ui", "/ui/", "/ui/index.html", "/ui/%69ndex.html", "/ui/./index.html"]) {
      const res = await call(cloud.port, "GET", path);
      expect(res.status, path).toBe(404);
      expect(res.headers["x-content-type-options"], path).toBe("nosniff");
    }
  });

  test("no way out of the build directory", async () => {
    const attempts = [
      "/ui/../secret.txt",
      "/ui/%2e%2e/secret.txt",
      "/ui/assets/..%2f..%2fsecret.txt",
      "/ui/assets/%2e%2e/%2e%2e/secret.txt",
      "/ui/..%5csecret.txt",
      "/ui/%2fetc%2fpasswd",
      "/ui//etc/passwd",
      "/ui/assets//app-1a2b.js",
      "/ui/.hidden",
      "/ui/assets/%00.js",
      "/ui/%E0%A4%A",
      "/ui/assets",
    ];
    for (const path of attempts) {
      const res = await call(cloud.port, "GET", path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain("outside the build");
    }
  });

  test("only GET and HEAD", async () => {
    expect((await call(cloud.port, "POST", "/ui/logo.svg", {}, "x")).status).toBe(405);
  });
});

describe("dashboard page /d/<id>/", () => {
  test("without a session it sends the browser to sign in and back", async () => {
    const res = await call(cloud.port, "GET", `/d/${device.id}/settings?tab=cloud`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(`/d/${device.id}/settings?tab=cloud`)}`);
  });

  test("without access it goes back to the computer list", async () => {
    const stranger = await makeUser("stranger@example.com");
    const res = await call(cloud.port, "GET", `/d/${device.id}/`, { cookie: stranger.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/devices?denied=1");
  });

  test("the page carries the cloud context, its CSP and safe headers", async () => {
    const res = await call(cloud.port, "GET", `/d/${device.id}/chat/abc`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(
      `default-src 'none'; script-src ${PUBLIC_URL}/ui/ 'wasm-unsafe-eval'; style-src ${PUBLIC_URL}/ui/ 'unsafe-inline'; ` +
        `font-src ${PUBLIC_URL}/ui/ data:; img-src 'self' data: blob: https:; media-src 'self' blob: data:; ` +
        `connect-src 'self' ws://localhost:3210; manifest-src ${PUBLIC_URL}/ui/; worker-src 'none'; object-src 'none'; ` +
        `frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    expect(metaContext(res.text)).toEqual({
      deviceId: device.id,
      deviceName: "Studio Mac",
      base: `/d/${device.id}`,
      home: "/devices",
      login: "/login",
      billing: "/billing",
      role: "owner",
      uiVersion: "9.8.7",
    });
    expect(res.text).toContain('<script type="module" src="/ui/assets/app-1a2b.js"></script>');
  });

  test("names with markup or replacement patterns are escaped, not interpreted", async () => {
    await db.update(devices).set({ name: `"><script>alert(1)</script> $& $' &amp;` }).where(eq(devices.id, device.id));
    const viewer = await makeUser("viewer@example.com");
    await db.insert(deviceAccess).values({ deviceId: device.id, userId: viewer.id, role: "viewer" });
    const res = await call(cloud.port, "GET", `/d/${device.id}/`, { cookie: viewer.cookie });
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text.match(/<head>/g)).toHaveLength(1);
    const context = metaContext(res.text);
    expect(context.deviceName).toBe(`"><script>alert(1)</script> $& $' &amp;`);
    expect(context.role).toBe("viewer");
  });

  test("a missing build, or one without <head>, shows the missing-build page", async () => {
    rmSync(path.join(UI_DIR, "index.html"));
    const missing = await call(cloud.port, "GET", `/d/${device.id}/`, { cookie: owner.cookie });
    expect(missing.status).toBe(503);
    expect(missing.text).toContain("pnpm --filter @godmode/desktop build:cloud");
    expect(missing.text).not.toContain("godmode-cloud");

    writeFileSync(path.join(UI_DIR, "index.html"), INDEX_HTML.replace("<head>", "<head data-x>"));
    const broken = await call(cloud.port, "GET", `/d/${device.id}/`, { cookie: owner.cookie });
    expect(broken.status).toBe(503);
    expect(broken.text).toContain("dashboard build is missing");
  });

  test("a renewed session cookie is sent again; an unchanged one is not", async () => {
    const plain = await call(cloud.port, "GET", `/d/${device.id}/`, { cookie: owner.cookie });
    expect(plain.headers["set-cookie"]).toBeUndefined();
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(sessions.userId, owner.id));
    const renewed = await call(cloud.port, "GET", `/d/${device.id}/`, { cookie: owner.cookie });
    const cookie = renewed.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain(`gmc_session=${owner.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(new Date(/Expires=([^;]+)/.exec(cookie)![1]!).getTime()).toBeGreaterThan(Date.now() + 100 * 86_400_000);
  });

  test("only GET and HEAD", async () => {
    expect((await call(cloud.port, "POST", `/d/${device.id}/`, { cookie: owner.cookie }, "x")).status).toBe(405);
  });
});
