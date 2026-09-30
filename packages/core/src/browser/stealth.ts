/**
 * Bot-detection hardening for the Chromium Godmode launches, so sites see a regular Chrome:
 * - `--disable-blink-features=AutomationControlled` keeps `navigator.webdriver` false on every Chromium build.
 * - Headless: every request, frame and worker carries the user agent the same Chrome sends with a window (learned once
 *   per executable from a throwaway headless launch), and the screen is a desktop display larger than the window.
 * browser-use doesn't emulate a viewport over it either (see browserUse.ts), so a page never outgrows its window.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../log";
import { sleep } from "../util";
import { launchChrome, type ChromeProcess, type LaunchOptions } from "./chrome";

const log = logger("browser");

/** A common desktop display minus the menu bar (macOS) or the taskbar (Windows), in `--screen-info` syntax. */
export function headlessScreen(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "{1920x1080 workAreaTop=25}";
  if (platform === "win32") return "{1920x1080 workAreaBottom=48}";
  return "{1920x1080}";
}

export function stealthArgs(opts: { headless: boolean; userAgent: string | null; platform?: NodeJS.Platform }): string[] {
  const args = ["--disable-blink-features=AutomationControlled"];
  if (opts.headless) {
    if (opts.userAgent) args.push(`--user-agent=${opts.userAgent}`);
    args.push(`--screen-info=${headlessScreen(opts.platform)}`);
  }
  return args;
}

/** "… HeadlessChrome/154.0.0.0 Safari/537.36" → "… Chrome/154.0.0.0 Safari/537.36" (Edge keeps its "Edg/" part). */
export function withoutHeadless(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome\//g, "Chrome/");
}

type Launch = (opts: LaunchOptions) => Promise<Pick<ChromeProcess, "userAgent" | "kill" | "exited">>;

const userAgents = new Map<string, Promise<string | null>>();
const probes = new Set<AbortController>();
/** A browser that can't be probed isn't asked again for a while: every headless start would wait for it. */
const RETRY_AFTER_MS = 10 * 60_000;

/** The user agent `executable` sends with a window; null when it can't be learned (then headless keeps its own). */
export function windowedUserAgent(executable: string, launch: Launch = launchChrome): Promise<string | null> {
  let key = executable;
  try {
    key += `@${statSync(executable).mtimeMs}`;
  } catch {
    /* the path alone */
  }
  let ua = userAgents.get(key);
  if (!ua) {
    ua = probeUserAgent(executable, launch);
    userAgents.set(key, ua);
    void ua.then((v) => {
      if (!v) setTimeout(() => userAgents.delete(key), RETRY_AFTER_MS).unref?.();
    });
  }
  return ua;
}

async function probeUserAgent(executable: string, launch: Launch): Promise<string | null> {
  const abort = new AbortController();
  probes.add(abort);
  let dir: string | null = null;
  let proc: Awaited<ReturnType<Launch>> | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "godmode-ua-"));
    proc = await launch({ executable, userDataDir: dir, headless: true, timeoutMs: 5_000, signal: abort.signal });
    return proc.userAgent ? withoutHeadless(proc.userAgent) : null;
  } catch (err) {
    log.warn("could not learn the browser's user agent; headless keeps its own", err);
    return null;
  } finally {
    probes.delete(abort);
    if (proc) {
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, sleep(3000)]);
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* a leftover temp profile is harmless */
      }
    }
  }
}

/** Kill user-agent probes still starting (core shutdown). */
export function stopProbes() {
  for (const abort of probes) abort.abort();
  probes.clear();
}
