import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appBundle,
  chromeCandidates,
  clearLaunchMarker,
  defaultChromeArgs,
  findChrome,
  findFreePort,
  isProcessAlive,
  LAUNCH_MARKER,
  playwrightChromiumCandidates,
  readLaunchMarker,
  writeLaunchMarker,
} from "../src/browser/chrome";
import { BROWSER_USE_SPEC, browserUseCommand, browserUseEnv, splitCommand, writeBrowserUseConfig } from "../src/browser/browserUse";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "godmode-chrome-test-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function touchExe(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

describe("Chromium executable detection", () => {
  test("macOS: system apps first, then ~/Applications, then Playwright's newest Chromium", () => {
    const home = join(tmp, "mac-home");
    touchExe(join(home, "Library", "Caches", "ms-playwright", "chromium-1100", "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"));
    touchExe(join(home, "Library", "Caches", "ms-playwright", "chromium-1223", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
    mkdirSync(join(home, "Library", "Caches", "ms-playwright", "chromium_headless_shell-1223"), { recursive: true });
    const c = chromeCandidates({ platform: "darwin", home, env: {} });
    expect(c[0]).toEqual({ browser: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    expect(c.map((x) => x.browser)).toContain("Brave");
    expect(c.some((x) => x.path === join(home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"))).toBe(true);
    const pw = c.filter((x) => x.browser === "Chromium (Playwright)").map((x) => x.path);
    expect(pw[0]).toContain("chromium-1223");
    expect(pw.some((p) => p.includes("headless_shell"))).toBe(false);
  });

  test("Windows: Program Files, Program Files (x86) and LocalAppData locations", () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    const paths = chromeCandidates({ platform: "win32", home: "C:\\Users\\me", env }).map((c) => c.path);
    expect(paths[0]).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(paths).toContain("C:\\Users\\me\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe");
    expect(paths).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(paths).toContain("C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe");
  });

  test("Linux: PATH lookups, well-known paths, snap last before Playwright", () => {
    const home = join(tmp, "linux-home");
    touchExe(join(home, ".cache", "ms-playwright", "chromium-1200", "chrome-linux", "chrome"));
    const onPath: Record<string, string> = { "google-chrome-stable": "/usr/bin/google-chrome-stable", chromium: "/usr/bin/chromium" };
    const c = chromeCandidates({ platform: "linux", home, env: {}, which: (b) => onPath[b] ?? null });
    expect(c[0]).toEqual({ browser: "Google Chrome", path: "/usr/bin/google-chrome-stable" });
    const snap = c.findIndex((x) => x.path === "/snap/bin/chromium");
    const pw = c.findIndex((x) => x.browser === "Chromium (Playwright)");
    expect(snap).toBeGreaterThan(0);
    expect(pw).toBeGreaterThan(snap);
  });

  test("PLAYWRIGHT_BROWSERS_PATH is searched first", () => {
    const custom = join(tmp, "pw-custom");
    touchExe(join(custom, "chromium-1300", "chrome-linux64", "chrome"));
    const c = playwrightChromiumCandidates({ platform: "linux", home: join(tmp, "nohome"), env: { PLAYWRIGHT_BROWSERS_PATH: custom } });
    expect(c[0]!.path).toBe(join(custom, "chromium-1300", "chrome-linux64", "chrome"));
  });

  test("a custom path (file or .app bundle) wins over auto-detection", () => {
    const exe = join(tmp, "custom", "my-chrome");
    touchExe(exe);
    expect(findChrome(exe)).toEqual({ browser: "Custom", path: exe });
    const bundle = join(tmp, "Custom Browser.app");
    touchExe(join(bundle, "Contents", "MacOS", "Custom Browser"));
    expect(findChrome(bundle)?.path).toBe(join(bundle, "Contents", "MacOS", "Custom Browser"));
  });

  test("appBundle finds the .app a macOS executable lives in", () => {
    expect(appBundle("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe("/Applications/Google Chrome.app");
    expect(appBundle("/c/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).toBe(
      "/c/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app",
    );
    expect(appBundle("/usr/bin/chromium")).toBeNull();
    expect(appBundle("/Applications/Google Chrome.app")).toBeNull();
    expect(appBundle("/Applications/Google Chrome.app/Contents/Frameworks/Helper")).toBeNull();
  });

  test("launch switches keep debugging on loopback and add headless only when asked", () => {
    const args = defaultChromeArgs(9333, "/tmp/p", true);
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--user-data-dir=/tmp/p");
    expect(args).toContain("--headless=new");
    expect(defaultChromeArgs(1, "/x", false)).not.toContain("--headless=new");
  });

  test("findFreePort returns a bindable loopback port", () => {
    const port = findFreePort();
    expect(port).toBeGreaterThan(1024);
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
  });

  test("launch marker round-trip (used to adopt a browser after a core restart)", () => {
    const dir = join(tmp, "marker");
    mkdirSync(dir, { recursive: true });
    expect(readLaunchMarker(dir)).toBeNull();
    writeLaunchMarker(dir, { pid: process.pid, port: 51234, headless: true, stealth: true });
    expect(readLaunchMarker(dir)).toEqual({ pid: process.pid, port: 51234, headless: true, stealth: true });
    writeFileSync(join(dir, LAUNCH_MARKER), JSON.stringify({ pid: process.pid, port: 51234, headless: false }));
    expect(readLaunchMarker(dir)).toEqual({ pid: process.pid, port: 51234, headless: false, stealth: false });
    writeFileSync(join(dir, LAUNCH_MARKER), '{"pid":"x","port":1}');
    expect(readLaunchMarker(dir)).toBeNull();
    clearLaunchMarker(dir);
    expect(readLaunchMarker(dir)).toBeNull();
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe("browser-use MCP wiring", () => {
  test("splitCommand handles quotes and escapes", () => {
    expect(splitCommand(`uvx --from "browser-use==0.13.10" browser-use --mcp`)).toEqual(["uvx", "--from", "browser-use==0.13.10", "browser-use", "--mcp"]);
    expect(splitCommand(`'/path with spaces/bu' --flag "a \\"b\\""`)).toEqual(["/path with spaces/bu", "--flag", 'a "b"']);
    expect(splitCommand(`  a   ""  b `)).toEqual(["a", "", "b"]);
  });

  test("default command is the pinned uvx invocation; custom commands override it", () => {
    expect(browserUseCommand("", "/home/me/.local/bin/uvx")).toEqual({
      command: "/home/me/.local/bin/uvx",
      args: ["--from", BROWSER_USE_SPEC, "browser-use", "--mcp"],
    });
    expect(browserUseCommand("", null)).toBeNull();
    expect(browserUseCommand("uvx --from browser-use==0.14.0 browser-use --cli-mcp", "/opt/uvx")).toEqual({
      command: "/opt/uvx",
      args: ["--from", "browser-use==0.14.0", "browser-use", "--cli-mcp"],
    });
    expect(browserUseCommand("/abs/browser-use --mcp", null)).toEqual({ command: "/abs/browser-use", args: ["--mcp"] });
  });

  test("config.json uses browser-use's DB-style schema with cdp_url and stable ids", () => {
    const configDir = join(tmp, "bu-config");
    const input = {
      configDir,
      cdpUrl: "http://127.0.0.1:9222",
      headless: false,
      userDataDir: join(tmp, "profile"),
      downloadsPath: join(tmp, "downloads"),
      fileSystemPath: join(tmp, "files"),
    };
    const path = writeBrowserUseConfig(input);
    const first = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(first).sort()).toEqual(["agent", "browser_profile", "llm"]);
    const [id, entry] = Object.entries(first.browser_profile)[0] as [string, Record<string, unknown>];
    expect(entry.id).toBe(id);
    expect(entry.default).toBe(true);
    expect(entry.cdp_url).toBe("http://127.0.0.1:9222");
    expect(entry.keep_alive).toBe(true);
    expect(entry.downloads_path).toBe(input.downloadsPath);
    writeBrowserUseConfig({ ...input, cdpUrl: "http://127.0.0.1:9333" });
    const second = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(second.browser_profile)).toEqual([id]);
    expect(second.browser_profile[id].cdp_url).toBe("http://127.0.0.1:9333");
    // Paths containing "chrome" would make browser-use copy the profile on every start.
    writeBrowserUseConfig({ ...input, userDataDir: "/Users/x/Library/Application Support/Google/Chrome" });
    const third = JSON.parse(readFileSync(path, "utf8"));
    expect(third.browser_profile[id].user_data_dir).toBe(join(configDir, "user-data"));
  });

  test("env disables telemetry/cloud sync and carries PATH + config dir only", () => {
    const env = browserUseEnv("/cfg", "/bin:/usr/bin");
    expect(env).toMatchObject({
      PATH: "/bin:/usr/bin",
      BROWSER_USE_CONFIG_DIR: "/cfg",
      ANONYMIZED_TELEMETRY: "false",
      BROWSER_USE_CLOUD_SYNC: "false",
      BROWSER_USE_LOGGING_LEVEL: "warning",
    });
    expect(Object.keys(env).some((k) => /API_KEY|TOKEN|SECRET/i.test(k))).toBe(false);
  });
});
