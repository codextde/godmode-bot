import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerInfo } from "@godmode/shared";
import { BUILD, VERSION, loadConfig } from "../src/config";
import { closeDb, deleteMeta, getMeta, openDb, setMeta } from "../src/db";
import { setLogLevel } from "../src/log";
import { __setControllerForTests, bridgeScript, planUpdate } from "../src/remote/runnerUpdates";
import { __resetSelfUpdateForTests, applyUpdate, receiveChunk, releaseAsset, selfUpdateStatus, setRestartHandler, settleUpdate } from "../src/remote/selfUpdate";
import { HttpError, sleep } from "../src/util";

let dir: string;

beforeAll(() => {
  setLogLevel("error");
  dir = mkdtempSync(join(tmpdir(), "godmode-runner-updates-"));
  loadConfig({ dataDir: dir, role: "runner" });
  openDb(join(dir, "godmode.db"));
});

afterAll(() => {
  __resetSelfUpdateForTests();
  __setControllerForTests(null);
  setRestartHandler(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const here = { platform: process.platform, arch: process.arch };
const info = (patch: Partial<RunnerInfo> = {}): RunnerInfo => ({
  name: "Mac mini",
  hostname: "mini",
  platform: process.platform,
  arch: process.arch,
  version: VERSION,
  build: BUILD,
  compiled: true,
  digest: "a".repeat(64),
  protocol: 1,
  vault: { initialized: true, unlocked: true },
  configDigest: null,
  activeRuns: 0,
  ...patch,
});

describe("which Godmode a runner needs", () => {
  beforeEach(() => {
    __setControllerForTests(null);
    deleteMeta("license.key");
  });

  test("the same program as this computer needs nothing; another one gets this computer's over the link", () => {
    __setControllerForTests({ digest: "a".repeat(64) });
    expect(planUpdate({ ...here, version: VERSION }, info()).needed).toBe(false);
    const plan = planUpdate({ ...here, version: VERSION }, info({ digest: "b".repeat(64) }));
    expect(plan).toMatchObject({ needed: true, source: "controller" });
  });

  test("a runner from before the updater fetches this computer's program once on a Mac, else gets a command", () => {
    __setControllerForTests({ digest: "a".repeat(64) });
    const legacy = info({ build: undefined, compiled: undefined, digest: undefined, update: undefined });
    if (process.platform === "darwin") expect(planUpdate({ ...here, version: VERSION }, legacy)).toMatchObject({ needed: true, source: "bridge" });
    const linux = planUpdate({ platform: "linux", arch: "x64", version: "0.0.1" }, { ...legacy, platform: "linux", arch: "x64", version: "0.0.1" });
    expect(linux.source).toBeNull();
    expect(linux.command).toContain("usegodmode.com/runner.sh");
  });

  test("another kind of computer downloads the release of this version, with the licence key", () => {
    const r = { platform: "linux", arch: "arm64", version: "0.0.1" };
    const without = planUpdate(r, info({ ...r }));
    expect(without).toMatchObject({ needed: true, source: null });
    expect(without.reason).toContain("licence key");
    setMeta("license.key", "GM-AAAAA-BBBBB-CCCCC-DDDDD");
    expect(planUpdate(r, info({ ...r }))).toMatchObject({ needed: true, source: "website" });
    // Across platforms only the version counts: the builds always differ.
    expect(planUpdate({ ...r, version: VERSION }, info({ ...r, version: VERSION, build: "other" })).needed).toBe(false);
  });

  test("never back to an older Godmode, nothing for a runner from source", () => {
    __setControllerForTests({ digest: "a".repeat(64) });
    expect(planUpdate({ ...here, version: "99.0.0" }, info({ version: "99.0.0", digest: "b".repeat(64) })).needed).toBe(false);
    const source = planUpdate({ ...here, version: "0.0.1" }, info({ version: "0.0.1", compiled: false, digest: null }));
    expect(source).toMatchObject({ needed: true, source: null, command: null });
  });

  test("an unknown version (never connected) needs nothing yet", () => {
    expect(planUpdate({ ...here, version: null }, undefined).needed).toBe(false);
  });
});

describe("a runner installing a new Godmode", () => {
  let exe: string;
  let restarts = 0;

  /** A stand-in program that answers `version` like Godmode. */
  const program = (version: string) => Buffer.from(`#!/bin/sh\n[ "$1" = version ] && echo ${version}\n`);
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  beforeEach(() => {
    exe = join(mkdtempSync(join(dir, "bin-")), "godmode");
    writeFileSync(exe, program("0.0.1"));
    chmodSync(exe, 0o755);
    __resetSelfUpdateForTests(exe);
    restarts = 0;
    setRestartHandler(() => restarts++);
    deleteMeta("update.pending");
  });

  test("takes the pieces in order, checks them, swaps the program and restarts", async () => {
    const next = program(VERSION);
    const half = Math.ceil(next.byteLength / 2);
    expect(receiveChunk(0, next.byteLength, next.subarray(0, half))).toEqual({ received: half });
    expect(() => receiveChunk(0 + 1, next.byteLength, next.subarray(half))).toThrow(HttpError);
    receiveChunk(half, next.byteLength, next.subarray(half));
    const status = await applyUpdate({ sha256: sha(next), size: next.byteLength, target: { version: VERSION, build: BUILD } });
    expect(status.state).toBe("installing");
    await sleep(600);
    expect(readFileSync(exe).equals(next)).toBe(true);
    expect(existsSync(join(exe, "..", ".godmode-update"))).toBe(false);
    expect(restarts).toBe(1);
    expect(JSON.parse(getMeta("update.pending")!)).toMatchObject({ version: VERSION, build: BUILD });
    // The restarted runner is that build: nothing to report.
    settleUpdate();
    expect(selfUpdateStatus().state).not.toBe("failed");
    expect(getMeta("update.pending")).toBeNull();
  });

  test("a damaged program never replaces the working one", async () => {
    const next = program(VERSION);
    receiveChunk(0, next.byteLength, next);
    await expect(applyUpdate({ sha256: "0".repeat(64), size: next.byteLength, target: { version: VERSION, build: BUILD } })).rejects.toThrow(/damaged/);
    expect(readFileSync(exe).equals(program("0.0.1"))).toBe(true);
    expect(selfUpdateStatus()).toMatchObject({ state: "failed" });
    expect(restarts).toBe(0);
  });

  test("a program that doesn't say the announced version is refused", async () => {
    const next = program("9.9.9");
    receiveChunk(0, next.byteLength, next);
    await expect(applyUpdate({ sha256: sha(next), size: next.byteLength, target: { version: VERSION, build: BUILD } })).rejects.toThrow(/doesn't start/);
    expect(readFileSync(exe).equals(program("0.0.1"))).toBe(true);
  });

  test("a restart that came back as another build is reported as failed", () => {
    setMeta("update.pending", JSON.stringify({ version: VERSION, build: "abc1234 2026-01-01" }));
    settleUpdate();
    expect(selfUpdateStatus()).toMatchObject({ state: "failed", target: { build: "abc1234 2026-01-01" } });
  });
});

describe("downloads and the bridge", () => {
  test("each computer has its server binary on usegodmode.com", () => {
    expect(releaseAsset("darwin", "arm64")).toBe("godmode-darwin-arm64");
    expect(releaseAsset("linux", "x64")).toBe("godmode-linux-x64");
    expect(releaseAsset("win32", "x64")).toBeNull();
  });

  test("the bridge script checks the download before it replaces the service's program", () => {
    const script = bridgeScript(["http://192.168.1.2:4000/tok/godmode", "http://100.64.0.1:4000/tok/godmode"], "f".repeat(64));
    expect(script).toContain("'http://192.168.1.2:4000/tok/godmode' 'http://100.64.0.1:4000/tok/godmode'");
    expect(script.indexOf("shasum -a 256")).toBeLessThan(script.indexOf('mv -f "$tmp" "$bin"'));
    expect(script).toContain("f".repeat(64));
    expect(script).toContain("launchctl kickstart -k");
  });
});
