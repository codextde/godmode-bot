import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyId } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { installDependency, resolveChrome, resolveClaudeBinary, resolveUvx, runCommand, runDoctor, stripAnsi, toolPath } from "../src/services/doctor";

let dataDir: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-doctor-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("doctor", () => {
  test("runDoctor reports every dependency with consistent fields (real machine check)", async () => {
    const report = await runDoctor(true);
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    const ids = report.dependencies.map((d) => d.id).sort();
    expect(ids).toEqual(["browser-use", "chrome", "claude", "claude-auth", "claude-mem", "cua-driver", "git", "uv"]);
    for (const d of report.dependencies) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.detail).toBe("string");
      expect(d.installHint.length).toBeGreaterThan(0);
      if (d.ok && d.id !== "claude-auth" && d.id !== "browser-use") expect(d.path).toBeTruthy();
    }
    expect(report.ok).toBe(report.dependencies.every((d) => d.ok || !d.required));
    expect(report.dependencies.find((d) => d.id === "git")!.required).toBe(false);
    // Path resolution agrees with the report.
    expect(report.dependencies.find((d) => d.id === "claude")!.path).toBe(resolveClaudeBinary());
    expect(report.dependencies.find((d) => d.id === "uv")!.path).toBe(resolveUvx());
    expect(report.dependencies.find((d) => d.id === "chrome")!.path).toBe(resolveChrome());
    console.log(report.dependencies.map((d) => `${d.ok ? "ok " : "-- "} ${d.id.padEnd(12)} ${d.version ?? ""} ${d.detail}`).join("\n"));
  }, 240_000);

  test("reports are cached unless refresh is requested", async () => {
    const a = await runDoctor(false);
    const b = await runDoctor(false);
    expect(b).toBe(a);
    const c = await runDoctor(true);
    expect(c).not.toBe(a);
  }, 240_000);

  test("browser dependencies are optional when the browser is disabled", async () => {
    updateSettings({ browser: { enabled: false } });
    const report = await runDoctor(true);
    for (const id of ["uv", "browser-use", "chrome"] as DependencyId[]) expect(report.dependencies.find((d) => d.id === id)!.required).toBe(false);
    updateSettings({ browser: { enabled: true } });
  }, 240_000);

  test("non-installable dependencies return guidance instead of running anything", async () => {
    const auth = await installDependency("claude-auth");
    expect(auth.ok).toBe(false);
    expect(auth.output).toContain("claude");
    const git = await installDependency("git");
    expect(git.ok).toBe(false);
    const unknown = await installDependency("nope" as DependencyId);
    expect(unknown.ok).toBe(false);
  });

  test("runCommand captures output, exit codes and timeouts without throwing", async () => {
    const ok = await runCommand([process.execPath, "-e", "console.log('hi'); console.error('err')"], { timeoutMs: 20_000 });
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe("hi");
    expect(ok.stderr.trim()).toBe("err");
    const missing = await runCommand(["/definitely/not/a/binary"]);
    expect(missing.code).toBeNull();
    const slow = await runCommand([process.execPath, "-e", "await Bun.sleep(10000)"], { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    expect(stripAnsi("\u001b[32mgreen\u001b[0m")).toBe("green");
    expect(toolPath().split(process.platform === "win32" ? ";" : ":").length).toBeGreaterThan(1);
  }, 30_000);
});
