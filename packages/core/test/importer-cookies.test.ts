import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPIRED,
  browserSources,
  cdpCookieToParam,
  filterByDomains,
  normalizeCookie,
  parseCookieExport,
  parseNetscapeCookies,
  profilesFromLocalState,
} from "../src/browser/importer";
import { HttpError } from "../src/util";

const NOW = 1_800_000_000; // fixed "now" in seconds
const FUTURE = NOW + 3600;

describe("cookie normalization", () => {
  test("Cookie-Editor / EditThisCookie (chrome.cookies API) format", () => {
    const domainCookie = normalizeCookie(
      { domain: ".github.com", expirationDate: FUTURE + 0.5, hostOnly: false, httpOnly: true, name: "_gh_sess", path: "/", sameSite: "lax", secure: true, session: false, storeId: "0", value: "abc", id: 1 },
      NOW,
    );
    expect(domainCookie).toEqual({ name: "_gh_sess", value: "abc", path: "/", secure: true, httpOnly: true, domain: ".github.com", sameSite: "Lax", expires: FUTURE + 0.5 });

    const hostOnly = normalizeCookie({ domain: "github.com", hostOnly: true, name: "__Host-user", value: "u", path: "/", secure: true, session: true, sameSite: "no_restriction" }, NOW);
    expect(hostOnly).toEqual({ name: "__Host-user", value: "u", path: "/", secure: true, httpOnly: false, url: "https://github.com/", sameSite: "None" });

    // hostOnly=false without a leading dot is still a domain cookie.
    expect(normalizeCookie({ domain: "example.org", hostOnly: false, name: "a", value: "1" }, NOW)).toMatchObject({ domain: ".example.org" });
    // "unspecified" sameSite is dropped.
    expect(normalizeCookie({ domain: ".a.com", name: "a", value: "1", sameSite: "unspecified" }, NOW)).not.toHaveProperty("sameSite");
  });

  test("Playwright storage_state format", () => {
    const parsed = parseCookieExport(
      JSON.stringify({
        cookies: [
          { name: "sid", value: "1", domain: "app.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Strict" },
          { name: "pref", value: "dark", domain: ".app.test", path: "/settings", expires: FUTURE, httpOnly: false, secure: false, sameSite: "None" },
        ],
        origins: [{ origin: "https://app.test", localStorage: [] }],
      }),
      NOW,
    );
    expect(parsed.skipped).toBe(0);
    expect(parsed.cookies[0]).toEqual({ name: "sid", value: "1", path: "/", secure: true, httpOnly: true, url: "https://app.test/", sameSite: "Strict" });
    // SameSite=None without Secure would be rejected by Chrome → dropped.
    expect(parsed.cookies[1]).toEqual({ name: "pref", value: "dark", path: "/settings", secure: false, httpOnly: false, domain: ".app.test", expires: FUTURE });
  });

  test("CDP (Storage.getCookies) format incl. partition keys", () => {
    const cdp = {
      name: "chips",
      value: "v",
      domain: "embed.test",
      path: "/",
      expires: FUTURE,
      size: 5,
      httpOnly: false,
      secure: true,
      session: false,
      sameSite: "None",
      priority: "High",
      sourceScheme: "Secure",
      sourcePort: 443,
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false },
    };
    expect(cdpCookieToParam(cdp as never)).toEqual({
      name: "chips",
      value: "v",
      path: "/",
      secure: true,
      httpOnly: false,
      url: "https://embed.test/",
      sameSite: "None",
      expires: FUTURE,
      priority: "High",
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false },
    });
    // Legacy string partition keys are converted; malformed ones are dropped (cookie imported unpartitioned).
    expect(normalizeCookie({ ...cdp, partitionKey: "https://top.test" }, NOW)).toMatchObject({ partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false } });
    expect(normalizeCookie({ ...cdp, partitionKey: { topLevelSite: "top.test" } }, NOW)).not.toHaveProperty("partitionKey");
    // Session cookie from CDP (expires -1).
    expect(normalizeCookie({ ...cdp, session: true, expires: -1 }, NOW)).not.toHaveProperty("expires");
  });

  test("expired, invalid and millisecond timestamps", () => {
    expect(normalizeCookie({ domain: ".a.com", name: "old", value: "1", expires: NOW - 10 }, NOW)).toBe(EXPIRED);
    expect(normalizeCookie({ domain: ".a.com", name: "ms", value: "1", expirationDate: FUTURE * 1000 }, NOW)).toMatchObject({ expires: FUTURE });
    expect(normalizeCookie({ domain: ".a.com", name: "sel", value: "1", expiry: FUTURE }, NOW)).toMatchObject({ expires: FUTURE });
    expect(normalizeCookie({ name: "nodomain", value: "1" }, NOW)).toBeNull();
    expect(normalizeCookie({ domain: "a b.com", name: "x", value: "1" }, NOW)).toBeNull();
    expect(normalizeCookie("nope", NOW)).toBeNull();
    expect(normalizeCookie({ url: "https://site.test/app", name: "fromurl", value: "1" }, NOW)).toMatchObject({ url: "https://site.test/" });
    expect(normalizeCookie({ domain: "localhost", name: "dev", value: "1", secure: false }, NOW)).toMatchObject({ url: "http://localhost/" });
  });

  test("parseCookieExport counts skipped cookies and rejects unknown shapes", () => {
    const res = parseCookieExport(
      JSON.stringify([
        { domain: ".ok.com", name: "a", value: "1" },
        { domain: ".ok.com", name: "b", value: "2", expirationDate: NOW - 1 },
        { value: "no name" },
      ]),
      NOW,
    );
    expect(res.cookies).toHaveLength(1);
    expect(res.skipped).toBe(2);
    expect(parseCookieExport(JSON.stringify({ result: { cookies: [{ domain: ".x.com", name: "c", value: "3" }] } }), NOW).cookies).toHaveLength(1);
    expect(() => parseCookieExport('{"foo": 1}', NOW)).toThrow(HttpError);
    expect(() => parseCookieExport("", NOW)).toThrow(HttpError);
    expect(() => parseCookieExport("definitely not cookies", NOW)).toThrow(HttpError);
  });

  test("Netscape cookies.txt", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      `.example.com\tTRUE\t/\tTRUE\t${FUTURE}\tsid\tabc`,
      `#HttpOnly_app.example.com\tFALSE\t/api\tFALSE\t0\ttoken\tt\tv`,
      "",
    ].join("\n");
    const rows = parseNetscapeCookies(txt);
    expect(rows).toHaveLength(2);
    const res = parseCookieExport(txt, NOW);
    expect(res.cookies[0]).toEqual({ name: "sid", value: "abc", path: "/", secure: true, httpOnly: false, domain: ".example.com", expires: FUTURE });
    expect(res.cookies[1]).toEqual({ name: "token", value: "t\tv", path: "/api", secure: false, httpOnly: true, url: "https://app.example.com/api" });
  });

  test("domain filter keeps exact, sub- and parent-domain cookies", () => {
    const { cookies } = parseCookieExport(
      JSON.stringify([
        { domain: ".google.com", name: "a", value: "1" },
        { domain: "mail.google.com", name: "b", value: "1" },
        { domain: ".github.com", name: "c", value: "1" },
        { domain: "notgoogle.com", name: "d", value: "1" },
      ]),
      NOW,
    );
    const { kept, dropped } = filterByDomains(cookies, ["mail.google.com"]);
    expect(kept.map((c) => c.name)).toEqual(["a", "b"]);
    expect(dropped).toBe(2);
    expect(filterByDomains(cookies, []).kept).toHaveLength(4);
    expect(filterByDomains(cookies, ["google.com"]).kept.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("local browser profiles", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "godmode-localstate-"));
    mkdirSync(join(root, "Default"));
    mkdirSync(join(root, "Profile 2"));
    mkdirSync(join(root, "Profile 10"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("parses Local State info_cache and skips missing folders", () => {
    const localState = JSON.stringify({
      profile: {
        info_cache: {
          "Profile 10": { name: "Side project", user_name: "" },
          Default: { name: "Personal", user_name: "me@example.com" },
          "Profile 2": { name: "", gaia_name: "Work Person", user_name: "work@corp.com" },
          "Profile 3": { name: "Deleted", user_name: "gone@example.com" },
        },
      },
    });
    const profiles = profilesFromLocalState("Google Chrome", root, localState);
    expect(profiles.map((p) => p.profileDir)).toEqual(["Default", "Profile 2", "Profile 10"]);
    expect(profiles[0]).toEqual({ browser: "Google Chrome", profileDir: "Default", name: "Personal", email: "me@example.com", path: join(root, "Default") });
    expect(profiles[1]!.name).toBe("Work Person");
    expect(profiles[2]!.email).toBeNull();
    expect(profilesFromLocalState("Chromium", root, "{broken")).toEqual([]);
  });

  test("knows each browser's user-data-dir per OS", () => {
    const mac = browserSources({ platform: "darwin", home: "/Users/me", env: {} });
    expect(mac.find((s) => s.browser === "Google Chrome")?.root).toBe("/Users/me/Library/Application Support/Google/Chrome");
    expect(mac.find((s) => s.browser === "Brave")?.root).toBe("/Users/me/Library/Application Support/BraveSoftware/Brave-Browser");
    const win = browserSources({ platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
    expect(win.find((s) => s.browser === "Google Chrome Canary")?.root).toBe("C:\\Users\\me\\AppData\\Local\\Google\\Chrome SxS\\User Data");
    expect(win.find((s) => s.browser === "Microsoft Edge")?.root).toBe("C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data");
    const linux = browserSources({ platform: "linux", home: "/home/me", env: {} });
    expect(linux.find((s) => s.browser === "Google Chrome")?.root).toBe("/home/me/.config/google-chrome");
    expect(linux.some((s) => s.root === "/home/me/snap/chromium/common/chromium")).toBe(true);
  });
});
