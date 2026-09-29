/**
 * Bot-detection hardening for the Chromium Godmode launches, so sites see a regular Chrome:
 * - `navigator.webdriver` stays false (`--disable-blink-features=AutomationControlled`).
 * - Headless: every request, frame and worker carries the user agent the same Chrome sends with a window (learned once
 *   per executable from a throwaway headless launch), and the screen is a desktop display larger than the window.
 * browser-use doesn't emulate a viewport over it either (see browserUse.ts), so a page never outgrows its window.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../util";
import { launchChrome, type ChromeProcess } from "./chrome";

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

const userAgents = new Map<string, Promise<string | null>>();

/** The user agent `executable` sends with a window; null when it can't be learned (the next launch tries again). */
export function windowedUserAgent(executable: string): Promise<string | null> {
  let key = executable;
  try {
    key += `@${statSync(executable).mtimeMs}`;
  } catch {
    /* the path alone */
  }
  let ua = userAgents.get(key);
  if (!ua) {
    ua = probeUserAgent(executable);
    userAgents.set(key, ua);
    void ua.then((v) => {
      if (!v) userAgents.delete(key);
    });
  }
  return ua;
}

async function probeUserAgent(executable: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "godmode-ua-"));
  let proc: ChromeProcess | null = null;
  try {
    proc = await launchChrome({ executable, userDataDir: dir, headless: true, timeoutMs: 15_000 });
    return proc.userAgent ? withoutHeadless(proc.userAgent) : null;
  } catch {
    return null;
  } finally {
    if (proc) {
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, sleep(3000)]);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
