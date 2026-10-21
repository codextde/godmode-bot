import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpCookie } from "../src/browser/cdp";
import { loadConfig } from "../src/config";
import { closeDb, getMeta, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { acceptedCookies, browserSignIns, cookiesFor, sessionBoundSite, setBrowserSignIns } from "../src/remote/browserSessions";
import { copyCookies } from "../src/remote/runners";
import { HttpError } from "../src/util";

let dataDir: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-browser-sessions-"));
  openDb(loadConfig({ dataDir }).dbPath);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const cookie = (domain: string, name: string, value = "1"): CdpCookie => ({ name, value, domain, path: "/", expires: -1, httpOnly: true, secure: true, session: true });

describe("sites whose sessions stay on one computer", () => {
  test("Google, Microsoft, Apple, Amazon, PayPal, Meta and the others, under every subdomain and country domain", () => {
    for (const host of [
      "google.com",
      ".google.com",
      "mail.google.com",
      "accounts.google.com",
      "google.de",
      "google.co.uk",
      "www.google.com.au",
      "GOOGLE.COM.",
      "www.youtube.com",
      "gmail.com",
      "login.microsoftonline.com",
      "login.live.com",
      "outlook.com",
      "appleid.apple.com",
      ".icloud.com",
      "www.amazon.de",
      ".amazon.co.uk",
      "www.paypal.com",
      "facebook.com",
      "www.instagram.com",
      "web.whatsapp.com",
      ".linkedin.com",
      "x.com",
      ".twitter.com",
      "www.tiktok.com",
      "accounts.shopify.com",
      "dashboard.stripe.com",
      "app.klarna.com",
    ]) {
      expect(sessionBoundSite(host), host).toBe(true);
    }
  });

  test("lookalikes and other sites are not", () => {
    for (const host of [
      "notgoogle.com",
      "mygoogle.de",
      "google.com.evil.com",
      "googleusercontent.com",
      "amazonaws.com",
      "box.com",
      "admin.shopify.com",
      "github.com",
      ".example.co.uk",
      "localhost",
      "",
      ".",
    ]) {
      expect(sessionBoundSite(host), host).toBe(false);
    }
  });
});

describe("what goes to a runner or a device", () => {
  const cookies = [cookie(".google.com", "SID"), cookie("github.com", "user_session"), cookie(".amazon.de", "at-main"), cookie(".shop.test", "cart")];
  const names = (list: CdpCookie[]) => list.map((c) => c.name);

  test("runners get everything but the session-bound sites, whatever the group's choice, and replace", () => {
    for (const policy of ["own", "seed"] as const) {
      const out = cookiesFor("runner", policy, cookies);
      expect(out.mode).toBe("replace");
      expect(names(out.cookies)).toEqual(["user_session", "cart"]);
    }
  });

  test("devices get nothing when each signs in by itself, and seed the rest otherwise", () => {
    expect(cookiesFor("device", "own", cookies)).toEqual({ cookies: [], mode: "seed" });
    const seed = cookiesFor("device", "seed", cookies);
    expect(seed.mode).toBe("seed");
    expect(names(seed.cookies)).toEqual(["user_session", "cart"]);
  });

  test("the group's choice: each computer signs in by itself unless set otherwise", () => {
    expect(browserSignIns()).toBe("own");
    setBrowserSignIns("seed");
    expect(browserSignIns()).toBe("seed");
    expect(getMeta("link.group.browserSignIns")).toBe("seed");
    setBrowserSignIns("own");
    expect(browserSignIns()).toBe("own");
    expect(() => setBrowserSignIns("all" as never)).toThrow(HttpError);
  });
});

describe("what the other computer takes", () => {
  // As the receiver sees them after normalizing: domain cookies with a dot, host-only ones by URL.
  const incoming = [
    { name: "SID", value: "theirs", domain: ".google.com" },
    { name: "MSPAuth", value: "theirs", url: "https://login.live.com/" },
    { name: "user_session", value: "theirs", url: "https://github.com/" },
    { name: "gist", value: "theirs", domain: ".gist.github.com" },
    { name: "basket", value: "theirs", url: "https://www.example.co.uk/" },
    { name: "cart", value: "theirs", domain: ".shop.test" },
  ];
  const existing = [cookie(".google.com", "SID", "mine"), cookie("github.com", "user_session", "mine"), cookie("account.example.co.uk", "login", "mine")];
  const names = (list: { name: string }[]) => list.map((c) => c.name);

  test("replace (also from an older controller): everything but the session-bound sites", () => {
    expect(names(acceptedCookies(incoming, "replace", existing))).toEqual(["user_session", "gist", "basket", "cart"]);
    expect(names(acceptedCookies(incoming, "replace", []))).toEqual(["user_session", "gist", "basket", "cart"]);
  });

  test("seed: only sites the profile has no cookies for yet, so its own sign-ins stay", () => {
    expect(names(acceptedCookies(incoming, "seed", existing))).toEqual(["cart"]);
    // A fresh profile takes everything but the session-bound sites.
    expect(names(acceptedCookies(incoming, "seed", []))).toEqual(["user_session", "gist", "basket", "cart"]);
  });
});

describe("copyCookies", () => {
  const posts: { path: string; body: { cookies: CdpCookie[]; mode: string } }[] = [];
  let failing = false;
  const fakeLink = {
    json: async <T>(_method: string, path: string, body?: unknown): Promise<T> => {
      if (failing) throw new Error("link down");
      posts.push({ path, body: body as { cookies: CdpCookie[]; mode: string } });
      return {} as T;
    },
  };
  let reads = 0;
  let profile: CdpCookie[] = [];
  const read = async () => {
    reads++;
    return profile;
  };
  const runner = { id: "rnr_test", kind: "runner" as const };
  const device = { id: "dev_test", kind: "device" as const };

  test("sends what goes there once, and again only when that changed", async () => {
    profile = [cookie(".google.com", "SID", "a"), cookie("github.com", "user_session", "a")];
    expect(await copyCookies(runner, fakeLink, "prof_1", read)).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/api/link/browser/prof_1/cookies");
    expect(posts[0]!.body.mode).toBe("replace");
    expect(posts[0]!.body.cookies.map((c) => c.name)).toEqual(["user_session"]);

    expect(await copyCookies(runner, fakeLink, "prof_1", read)).toBe(false);
    // A new Google session never goes, so it isn't a change either.
    profile = [cookie(".google.com", "SID", "b"), cookie("github.com", "user_session", "a")];
    expect(await copyCookies(runner, fakeLink, "prof_1", read)).toBe(false);
    expect(posts).toHaveLength(1);

    profile = [cookie(".google.com", "SID", "b"), cookie("github.com", "user_session", "b")];
    expect(await copyCookies(runner, fakeLink, "prof_1", read)).toBe(true);
    expect(posts).toHaveLength(2);
  });

  test("nothing to send: only session-bound sites", async () => {
    profile = [cookie(".google.com", "SID"), cookie(".apple.com", "myacinfo")];
    expect(await copyCookies(runner, fakeLink, "prof_2", read)).toBe(false);
    expect(posts).toHaveLength(2);
    expect(getMeta("link.cookies.rnr_test.prof_2")).toBeNull();
  });

  test("a failed copy is tried again", async () => {
    profile = [cookie("github.com", "user_session", "c")];
    failing = true;
    await expect(copyCookies(runner, fakeLink, "prof_3", read)).rejects.toThrow("link down");
    failing = false;
    expect(await copyCookies(runner, fakeLink, "prof_3", read)).toBe(true);
    expect(posts).toHaveLength(3);
  });

  test("devices: not even read while each signs in by itself, seeded otherwise", async () => {
    profile = [cookie(".google.com", "SID"), cookie("github.com", "user_session")];
    const before = reads;
    expect(await copyCookies(device, fakeLink, "prof_1", read)).toBe(false);
    expect(reads).toBe(before);
    expect(posts).toHaveLength(3);

    setBrowserSignIns("seed");
    try {
      expect(await copyCookies(device, fakeLink, "prof_1", read)).toBe(true);
      expect(posts[3]!.body.mode).toBe("seed");
      expect(posts[3]!.body.cookies.map((c) => c.name)).toEqual(["user_session"]);
      expect(await copyCookies(device, fakeLink, "prof_1", read)).toBe(false);
      expect(posts).toHaveLength(4);
    } finally {
      setBrowserSignIns("own");
    }
  });
});
