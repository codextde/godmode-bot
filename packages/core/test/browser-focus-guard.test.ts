/**
 * macOS: a visible agent browser gets the native helper's focus guard (a stand-in helper via GODMODE_COMPUTER_HELPER),
 * armed whenever it opens a page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpClient, CdpParams } from "../src/browser/cdp";
import { initFocusGuard } from "../src/browser/focusGuard";
import { registerBrowser, unregisterBrowser, type RunningBrowser } from "../src/browser/state";
import { stopHelper } from "../src/computer/helper";

const suite = process.platform === "darwin" ? describe : describe.skip;

const FAKE_HELPER = `
const { appendFileSync } = require("node:fs");
const logFile = process.argv[2];
process.stdout.write(JSON.stringify({ ready: true, version: "3" }) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    appendFileSync(logFile, line + "\\n");
    process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, ok: true, result: { ok: true } }) + "\\n");
  }
});
`;

function fakeBrowser(profileId: string, opts: { headless?: boolean; pid?: number } = {}) {
  const handlers = new Map<string, Set<(p: CdpParams) => void>>();
  const client = {
    closed: false,
    on(method: string, fn: (p: CdpParams) => void) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(fn);
      return () => handlers.get(method)!.delete(fn);
    },
  };
  const rb = { profileId, headless: opts.headless ?? false, pid: opts.pid ?? 4242, client: client as unknown as CdpClient, stopping: false } as RunningBrowser;
  const created = (type: string) => {
    for (const fn of handlers.get("Target.targetCreated") ?? []) fn({ targetInfo: { targetId: `T${Math.random()}`, type, url: "about:blank", title: "" } });
  };
  return { rb, created };
}

suite("browser focus guard (macOS)", () => {
  let dir: string;
  let logFile: string;
  const calls = (): Record<string, unknown>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const settle = async (count: number) => {
    for (let i = 0; i < 100 && calls().length < count; i++) await Bun.sleep(20);
    await Bun.sleep(50);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "godmode-focus-guard-"));
    logFile = join(dir, "calls.jsonl");
    const script = join(dir, "godmode-computer");
    writeFileSync(script, `#!${process.execPath}\nprocess.argv.push(${JSON.stringify(logFile)});\n${FAKE_HELPER}`);
    chmodSync(script, 0o755);
    await stopHelper();
    process.env.GODMODE_COMPUTER_HELPER = script;
    initFocusGuard();
  });

  afterAll(async () => {
    await stopHelper();
    delete process.env.GODMODE_COMPUTER_HELPER;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => rmSync(logFile, { force: true }));

  test("a visible browser is watched from its start and armed for every page it opens", async () => {
    const { rb, created } = fakeBrowser("bpr_visible", { pid: 4242 });
    registerBrowser(rb);
    await settle(1);
    expect(calls()).toEqual([expect.objectContaining({ cmd: "guardFocus", pid: 4242, ms: 0 })]);

    created("page");
    created("iframe");
    created("service_worker");
    await settle(2);
    expect(calls().slice(1)).toEqual([expect.objectContaining({ cmd: "guardFocus", pid: 4242, ms: 3000 })]);

    unregisterBrowser(rb);
    created("page");
    await Bun.sleep(150);
    expect(calls()).toHaveLength(2);
  });

  test("headless browsers have no window to guard", async () => {
    const { rb, created } = fakeBrowser("bpr_headless", { headless: true });
    registerBrowser(rb);
    created("page");
    await Bun.sleep(150);
    expect(calls()).toEqual([]);
    unregisterBrowser(rb);
  });
});
