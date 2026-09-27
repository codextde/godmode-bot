/**
 * Chromium-family executable detection (per OS) and process launch with remote debugging on loopback.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { sleep, which } from "../util";
import { probeCdp } from "./cdp";

export interface ChromeCandidate {
  browser: string;
  path: string;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Resolve a bare command name on PATH (injectable for tests). */
  which?: (bin: string) => string | null;
}

const MAC_APPS: [browser: string, bundle: string, exe: string][] = [
  ["Google Chrome", "Google Chrome.app", "Google Chrome"],
  ["Google Chrome Beta", "Google Chrome Beta.app", "Google Chrome Beta"],
  ["Google Chrome Dev", "Google Chrome Dev.app", "Google Chrome Dev"],
  ["Google Chrome Canary", "Google Chrome Canary.app", "Google Chrome Canary"],
  ["Chromium", "Chromium.app", "Chromium"],
  ["Microsoft Edge", "Microsoft Edge.app", "Microsoft Edge"],
  ["Brave", "Brave Browser.app", "Brave Browser"],
];

const LINUX_BINS: [browser: string, bin: string][] = [
  ["Google Chrome", "google-chrome"],
  ["Google Chrome", "google-chrome-stable"],
  ["Google Chrome Beta", "google-chrome-beta"],
  ["Google Chrome Dev", "google-chrome-unstable"],
  ["Chromium", "chromium"],
  ["Chromium", "chromium-browser"],
  ["Microsoft Edge", "microsoft-edge"],
  ["Microsoft Edge", "microsoft-edge-stable"],
  ["Brave", "brave-browser"],
  ["Brave", "brave"],
];

/** Well-known install locations, in preference order (system browsers before Playwright's Chromium). */
export function chromeCandidates(opts: DetectOptions = {}): ChromeCandidate[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const resolve = opts.which ?? which;
  const out: ChromeCandidate[] = [];

  if (platform === "darwin") {
    for (const base of ["/Applications", join(home, "Applications")]) {
      for (const [browser, bundle, exe] of MAC_APPS) out.push({ browser, path: join(base, bundle, "Contents", "MacOS", exe) });
    }
  } else if (platform === "win32") {
    const roots = {
      pf: env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files",
      pf86: env["ProgramFiles(x86)"] || env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      local: env.LOCALAPPDATA || env.LocalAppData || join(home, "AppData", "Local"),
    };
    const win = (...parts: string[]) => parts.join("\\");
    for (const root of [roots.pf, roots.pf86, roots.local]) out.push({ browser: "Google Chrome", path: win(root, "Google", "Chrome", "Application", "chrome.exe") });
    for (const root of [roots.pf, roots.pf86, roots.local]) out.push({ browser: "Google Chrome Beta", path: win(root, "Google", "Chrome Beta", "Application", "chrome.exe") });
    out.push({ browser: "Google Chrome Canary", path: win(roots.local, "Google", "Chrome SxS", "Application", "chrome.exe") });
    out.push({ browser: "Chromium", path: win(roots.local, "Chromium", "Application", "chrome.exe") });
    for (const root of [roots.pf86, roots.pf, roots.local]) out.push({ browser: "Microsoft Edge", path: win(root, "Microsoft", "Edge", "Application", "msedge.exe") });
    for (const root of [roots.pf, roots.pf86, roots.local]) out.push({ browser: "Brave", path: win(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe") });
  } else {
    for (const [browser, bin] of LINUX_BINS) {
      const found = resolve(bin);
      if (found) out.push({ browser, path: found });
    }
    for (const [browser, path] of [
      ["Google Chrome", "/opt/google/chrome/chrome"],
      ["Chromium", "/usr/bin/chromium"],
      ["Chromium", "/usr/bin/chromium-browser"],
      ["Microsoft Edge", "/opt/microsoft/msedge/msedge"],
      ["Brave", "/opt/brave.com/brave/brave"],
      // Snap Chromium last: its confinement can interfere with remote debugging.
      ["Chromium", "/snap/bin/chromium"],
    ] as const) {
      out.push({ browser, path });
    }
  }
  out.push(...playwrightChromiumCandidates({ platform, env, home }));
  return out;
}

/** Playwright's cache (ms-playwright/chromium-<rev>/…), newest revision first. */
export function playwrightChromiumCandidates(opts: DetectOptions = {}): ChromeCandidate[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const roots: string[] = [];
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== "0") roots.push(custom);
  if (platform === "darwin") roots.push(join(home, "Library", "Caches", "ms-playwright"));
  else if (platform === "win32") roots.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright"));
  else roots.push(join(env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright"));

  const subpaths =
    platform === "darwin"
      ? [
          ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
          ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
          ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
          ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
        ]
      : platform === "win32"
        ? [
            ["chrome-win64", "chrome.exe"],
            ["chrome-win", "chrome.exe"],
          ]
        : [
            ["chrome-linux64", "chrome"],
            ["chrome-linux", "chrome"],
          ];

  const out: ChromeCandidate[] = [];
  for (const root of roots) {
    let revisions: string[] = [];
    try {
      revisions = readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    } catch {
      continue;
    }
    for (const rev of revisions) {
      for (const sub of subpaths) out.push({ browser: "Chromium (Playwright)", path: join(root, rev, ...sub) });
    }
  }
  return out;
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A user-supplied path may point at a macOS .app bundle; resolve it to the binary inside. */
function resolveCustomPath(path: string): string | null {
  if (isExecutableFile(path)) return path;
  if (path.endsWith(".app")) {
    const exe = join(path, "Contents", "MacOS", basename(path, ".app"));
    if (isExecutableFile(exe)) return exe;
    try {
      const plist = readFileSync(join(path, "Contents", "Info.plist"), "utf8");
      const m = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
      if (m) {
        const named = join(path, "Contents", "MacOS", m[1]!);
        if (isExecutableFile(named)) return named;
      }
    } catch {
      /* not a bundle */
    }
  }
  const onPath = which(path);
  return onPath && isExecutableFile(onPath) ? onPath : null;
}

/** First existing Chromium-family executable: `customPath` (settings) first, then auto-detection. */
export function findChrome(customPath?: string, opts: DetectOptions = {}): ChromeCandidate | null {
  if (customPath && customPath.trim()) {
    const resolved = resolveCustomPath(customPath.trim());
    if (resolved) return { browser: "Custom", path: resolved };
  }
  for (const c of chromeCandidates(opts)) {
    if (isExecutableFile(c.path)) return c;
  }
  return null;
}

/** A free TCP port on 127.0.0.1 (the OS picks it; we release it right away). */
export function findFreePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/**
 * Written into the user-data-dir while Godmode runs a browser on it, so a restarted core can find (and adopt)
 * a browser the previous process left running. Chrome itself only writes DevToolsActivePort for port 0.
 */
export const LAUNCH_MARKER = "Godmode-DevTools.json";

export interface LaunchMarker {
  pid: number;
  port: number;
  headless: boolean;
}

export function writeLaunchMarker(userDataDir: string, marker: LaunchMarker) {
  try {
    writeFileSync(join(userDataDir, LAUNCH_MARKER), JSON.stringify(marker), { mode: 0o600 });
  } catch {
    /* adoption is best effort */
  }
}

export function readLaunchMarker(userDataDir: string): LaunchMarker | null {
  try {
    const m = JSON.parse(readFileSync(join(userDataDir, LAUNCH_MARKER), "utf8")) as Partial<LaunchMarker>;
    const valid = Number.isInteger(m.pid) && m.pid! > 0 && Number.isInteger(m.port) && m.port! > 0 && m.port! <= 65535;
    return valid ? { pid: m.pid!, port: m.port!, headless: !!m.headless } : null;
  } catch {
    return null;
  }
}

export function clearLaunchMarker(userDataDir: string) {
  try {
    rmSync(join(userDataDir, LAUNCH_MARKER), { force: true });
  } catch {
    /* ignore */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LaunchOptions {
  executable: string;
  userDataDir: string;
  headless: boolean;
  /** Extra Chrome switches (appended after the defaults). */
  extraArgs?: string[];
  /** URL to open instead of the browser's default start page. */
  startUrl?: string;
  timeoutMs?: number;
}

export interface ChromeProcess {
  pid: number;
  port: number;
  wsUrl: string;
  browserVersion: string;
  proc: Subprocess;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  isAlive(): boolean;
  stderrTail(): string;
  kill(signal?: NodeJS.Signals): void;
}

export class ChromeLaunchError extends Error {}

/** Default switches for every Chromium Godmode starts. */
export function defaultChromeArgs(port: number, userDataDir: string, headless: boolean): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1280,900",
    // Keep pages rendering and timers running when the window is in the background (automation + live view).
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    ...(headless ? ["--headless=new"] : []),
  ];
}

/** Spawn Chromium with remote debugging on a free loopback port and wait until CDP answers. */
export async function launchChrome(opts: LaunchOptions): Promise<ChromeProcess> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastError: Error | null = null;
  // One retry covers the (rare) race where another process grabs the port we picked.
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = findFreePort();
    const args = [...defaultChromeArgs(port, opts.userDataDir, opts.headless), ...(opts.extraArgs ?? [])];
    if (opts.startUrl) args.push(opts.startUrl);
    const proc = Bun.spawn([opts.executable, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });

    let tail = "";
    let alive = true;
    const exited = proc.exited.then(
      (code) => {
        alive = false;
        return code;
      },
      () => {
        alive = false;
        return null;
      },
    );
    // Chrome logs a lot to stderr; drain it continuously (a full pipe would block the browser).
    void (async () => {
      try {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          tail = (tail + decoder.decode(value, { stream: true })).slice(-4000);
        }
      } catch {
        /* stream closed */
      }
    })();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive) break;
      const version = await probeCdp(port, 1000);
      if (version) {
        return {
          pid: proc.pid,
          port,
          wsUrl: version.webSocketDebuggerUrl,
          browserVersion: version.Browser,
          proc,
          exited,
          isAlive: () => alive,
          stderrTail: () => tail,
          kill: (signal: NodeJS.Signals = "SIGTERM") => {
            try {
              proc.kill(signal);
            } catch {
              /* already exited */
            }
          },
        };
      }
      await sleep(150);
    }

    if (alive) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      lastError = new ChromeLaunchError(`Chromium did not open its DevTools endpoint within ${Math.round(timeoutMs / 1000)} s.${formatTail(tail)}`);
      continue;
    }
    const code = await exited;
    // 0: handed the command line to an existing instance; 21: RESULT_CODE_PROFILE_IN_USE.
    if (code === 0 || code === 21) {
      throw new ChromeLaunchError(`The profile directory is already in use by another browser process (${opts.userDataDir}).`);
    }
    lastError = new ChromeLaunchError(`Chromium exited during startup (code ${code}).${formatTail(tail)}`);
    if (!/address already in use|bind\(\) failed/i.test(tail)) break;
  }
  throw lastError ?? new ChromeLaunchError("Chromium failed to start");
}

function formatTail(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5);
  return lines.length ? ` Last output:\n${lines.join("\n")}` : "";
}

/** Does the executable path exist? (exported for doctor/importer) */
export function executableExists(path: string | null | undefined): path is string {
  return !!path && existsSync(path) && isExecutableFile(path);
}
