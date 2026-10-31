import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { all, closeDb, openDb, run } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { powerStatus, resetPowerState, ruleFile, setLidClosedAwake, setPowerDeps, setupScript, startPower, stopPower, type Exec } from "../src/services/power";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import { HttpError, sleep } from "../src/util";

let dataDir: string;

/** A MacBook as pmset, ioreg, sudo and osascript see it. */
interface FakeMac {
  hasLid: boolean;
  hasBattery: boolean;
  sleepDisabled: boolean;
  lidClosed: boolean;
  percent: number;
  charging: boolean;
  rule: boolean;
  password: "ok" | "cancel" | "hang";
  calls: string[][];
}
let mac: FakeMac;

function exec(argv: string[], signal?: AbortSignal): Promise<Exec> {
  mac.calls.push(argv);
  const ok = (stdout = ""): Exec => ({ code: 0, stdout, stderr: "" });
  const [bin, ...args] = argv;
  if (bin === "/usr/bin/pmset" && args.join(" ") === "-g") return Promise.resolve(ok(` sleep 1\n${mac.sleepDisabled ? " SleepDisabled\t\t1\n" : ""} displaysleep 5\n`));
  if (bin === "/usr/bin/pmset" && args.join(" ") === "-g batt") {
    const source = mac.charging ? "AC Power" : "Battery Power";
    if (!mac.hasBattery) return Promise.resolve(ok(`Now drawing from 'AC Power'\n`));
    return Promise.resolve(ok(`Now drawing from '${source}'\n -InternalBattery-0 (id=1)\t${mac.percent}%; discharging; 3:00 remaining present: true\n`));
  }
  if (bin === "/usr/sbin/ioreg") return Promise.resolve(ok(mac.hasLid ? `  "AppleClamshellState" = ${mac.lidClosed ? "Yes" : "No"}\n` : ""));
  if (bin === "/usr/bin/sudo") {
    if (!mac.rule) return Promise.resolve({ code: 1, stdout: "", stderr: "sudo: a password is required" });
    if (args[1] === "-l") return Promise.resolve(ok());
    mac.sleepDisabled = args.at(-1) === "1";
    return Promise.resolve(ok());
  }
  if (bin === "/usr/bin/osascript") {
    if (mac.password === "hang") {
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ code: 143, stdout: "", stderr: "terminated" })));
    }
    if (mac.password === "cancel") return Promise.resolve({ code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" });
    mac.rule = true;
    mac.sleepDisabled = /disablesleep 1$/.test(args[1]!.split(" with prompt")[0]!.replace(/"$/, ""));
    return Promise.resolve(ok());
  }
  return Promise.resolve({ code: 127, stdout: "", stderr: `unexpected ${argv.join(" ")}` });
}

const marker = () => join(dataDir, "power-sleep-disabled");

function runEvent(type: "run.started" | "run.finished", id: string) {
  bus.emit({ type, run: { id } as Run } as never);
}

async function settle() {
  await sleep(30);
}

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-power-"));
  loadConfig({ dataDir, token: "test-token" });
  openDb(join(dataDir, "godmode.db"));
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mac = { hasLid: true, hasBattery: true, sleepDisabled: false, lidClosed: false, percent: 80, charging: true, rule: false, password: "ok", calls: [] };
  resetSettingsCache();
  updateSettings({ power: { lidClosedAwake: false, onlyWhileWorking: false, minBattery: 20 } });
  rmSync(marker(), { force: true });
  resetPowerState();
  setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 60_000, idleGraceMs: 60_000 });
});

afterEach(async () => {
  await stopPower();
  setPowerDeps(null);
});

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected a rejection");
}

describe("lid-closed mode", () => {
  test("exists only on a Mac with a lid", async () => {
    setPowerDeps({ platform: "linux", exec, user: "alex" });
    expect((await powerStatus()).supported).toBe(false);
    expect((await rejection(setLidClosedAwake(true))).status).toBe(409);

    setPowerDeps({ platform: "darwin", exec, user: "alex" });
    mac.hasLid = false;
    expect((await powerStatus()).supported).toBe(false);
    await startPower();
    expect((await rejection(setLidClosedAwake(true))).status).toBe(409);
    await stopPower();

    // A desktop Mac that reports a clamshell state has no battery.
    mac.hasLid = true;
    mac.hasBattery = false;
    expect((await powerStatus()).supported).toBe(false);
    expect(mac.calls.some(([bin]) => bin === "/usr/bin/osascript")).toBe(false);
  });

  test("the first switch asks macOS for the password once, then switches without it", async () => {
    await startPower();
    const before = await powerStatus();
    expect(before).toMatchObject({ supported: true, enabled: false, active: false, state: "off", permission: false, lidClosed: false });

    const on = await setLidClosedAwake(true);
    expect(on).toMatchObject({ enabled: true, active: true, state: "on", permission: true, error: null });
    expect(getSettings().power.lidClosedAwake).toBe(true);
    expect(existsSync(marker())).toBe(true);
    const asks = mac.calls.filter(([bin]) => bin === "/usr/bin/osascript");
    expect(asks).toHaveLength(1);
    expect(asks[0]![2]).toContain("with administrator privileges");
    expect(asks[0]![2]).toContain("/usr/sbin/visudo -cf");

    const off = await setLidClosedAwake(false);
    expect(off).toMatchObject({ enabled: false, active: false, state: "off" });
    expect(existsSync(marker())).toBe(false);
    await setLidClosedAwake(true);
    expect(mac.calls.filter(([bin]) => bin === "/usr/bin/osascript")).toHaveLength(1);
  });

  test("a cancelled password dialog changes nothing", async () => {
    await startPower();
    mac.password = "cancel";
    const err = await rejection(setLidClosedAwake(true));
    expect(err.status).toBe(409);
    expect(err.code).toBe("power_cancelled");
    expect(getSettings().power.lidClosedAwake).toBe(false);
    expect(mac.sleepDisabled).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  test("low battery lets the Mac sleep until it charges, with a margin", async () => {
    mac.rule = true;
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 20, idleGraceMs: 60_000 });
    await startPower();
    await setLidClosedAwake(true);
    expect(mac.sleepDisabled).toBe(true);

    mac.charging = false;
    mac.percent = 19;
    await settle();
    expect(mac.sleepDisabled).toBe(false);
    expect((await powerStatus()).state).toBe("low_battery");
    expect(all<{ title: string }>("SELECT title FROM notifications WHERE title = 'Lid-closed mode paused'")).toHaveLength(1);

    mac.percent = 23;
    await settle();
    expect(mac.sleepDisabled).toBe(false);
    mac.percent = 26;
    await settle();
    expect(mac.sleepDisabled).toBe(true);
    expect((await powerStatus()).state).toBe("on");

    mac.percent = 5;
    mac.charging = true;
    await settle();
    expect(mac.sleepDisabled).toBe(true);
  });

  test("never sleeps on battery when the limit is 0", async () => {
    mac.rule = true;
    updateSettings({ power: { minBattery: 0 } });
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 20, idleGraceMs: 60_000 });
    await startPower();
    await setLidClosedAwake(true);
    mac.charging = false;
    mac.percent = 3;
    await settle();
    expect(mac.sleepDisabled).toBe(true);
  });

  test("only while agents work: awake during runs, asleep a while after the last one", async () => {
    mac.rule = true;
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 60_000, idleGraceMs: 40 });
    await startPower();
    updateSettings({ power: { onlyWhileWorking: true } });
    await setLidClosedAwake(true);
    expect(mac.sleepDisabled).toBe(true);
    await sleep(120);
    expect(mac.sleepDisabled).toBe(false);
    expect((await powerStatus()).state).toBe("idle");

    runEvent("run.started", "run_a");
    await settle();
    expect(mac.sleepDisabled).toBe(true);
    runEvent("run.started", "run_b");
    runEvent("run.finished", "run_a");
    await sleep(100);
    expect(mac.sleepDisabled).toBe(true);
    runEvent("run.finished", "run_b");
    await settle();
    expect(mac.sleepDisabled).toBe(true);
    await sleep(120);
    expect(mac.sleepDisabled).toBe(false);
  });

  test("quitting lets the Mac sleep again, but leaves a disablesleep set by hand alone", async () => {
    mac.rule = true;
    await startPower();
    await setLidClosedAwake(true);
    await stopPower();
    expect(mac.sleepDisabled).toBe(false);
    expect(existsSync(marker())).toBe(false);

    updateSettings({ power: { lidClosedAwake: false } });
    mac.sleepDisabled = true;
    await startPower();
    await stopPower();
    expect(mac.sleepDisabled).toBe(true);
  });

  test("after a crash the next start repairs what Godmode left behind", async () => {
    mac.rule = true;
    mac.sleepDisabled = true;
    writeFileSync(marker(), "x");
    await startPower();
    expect(mac.sleepDisabled).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  test("turned on with the rule gone: the status says so instead of pretending", async () => {
    mac.rule = true;
    await startPower();
    await setLidClosedAwake(true);
    await stopPower();
    mac.rule = false;
    await startPower();
    const status = await powerStatus();
    expect(status).toMatchObject({ enabled: true, active: false, state: "error", permission: false });
    expect(status.error).toContain("no longer allowed");
    expect(all<{ title: string }>("SELECT title FROM notifications WHERE title = 'Your Mac sleeps with the lid closed'")).toHaveLength(1);
  });

  test("a paused run keeps the Mac awake: the answer it waits for must reach it", async () => {
    mac.rule = true;
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 60_000, idleGraceMs: 40 });
    await startPower();
    updateSettings({ power: { onlyWhileWorking: true } });
    await setLidClosedAwake(true);
    run("PRAGMA foreign_keys = OFF");
    run(
      "INSERT INTO paused_runs (run_id, conversation_id, agent_id, message_id, reason, created_at) VALUES ('run_q', 'c_q', 'agt_x', 'm_q', 'question', ?)",
      new Date().toISOString(),
    );
    runEvent("run.started", "run_q");
    bus.emit({ type: "run.paused", run: { id: "run_q" } as Run } as never);
    await sleep(150);
    expect(mac.sleepDisabled).toBe(true);
  });

  test("turning it on takes over a disablesleep set by hand, so pauses really let the Mac sleep", async () => {
    mac.rule = true;
    mac.sleepDisabled = true;
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 60_000, idleGraceMs: 40 });
    await startPower();
    updateSettings({ power: { onlyWhileWorking: true } });
    await setLidClosedAwake(true);
    await sleep(150);
    expect(mac.sleepDisabled).toBe(false);
    expect((await powerStatus()).state).toBe("idle");
  });

  test("a stale marker never turns off a disablesleep set by hand later", async () => {
    mac.rule = true;
    await startPower();
    await setLidClosedAwake(true);
    mac.sleepDisabled = false;
    await setLidClosedAwake(false);
    expect(existsSync(marker())).toBe(false);
    mac.sleepDisabled = true;
    updateSettings({ power: { minBattery: 30 } });
    await settle();
    await stopPower();
    expect(mac.sleepDisabled).toBe(true);
  });

  test("a release that fails says so instead of claiming the Mac may sleep", async () => {
    mac.rule = true;
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 20, idleGraceMs: 60_000 });
    await startPower();
    await setLidClosedAwake(true);
    mac.rule = false;
    mac.charging = false;
    mac.percent = 10;
    await settle();
    const status = await powerStatus();
    expect(status).toMatchObject({ state: "error", active: true });
    expect(status.error).toContain("couldn't let the Mac sleep");
    expect(all<{ title: string }>("SELECT title FROM notifications WHERE title = 'Your Mac can''t sleep with the lid closed'").length).toBeGreaterThan(0);
  });

  test("quitting at the password dialog closes it and leaves nothing behind", async () => {
    await startPower();
    mac.password = "hang";
    const pending = rejection(setLidClosedAwake(true));
    await settle();
    expect(existsSync(marker())).toBe(true);
    const t = Date.now();
    await stopPower();
    expect(Date.now() - t).toBeLessThan(900);
    const err = await pending;
    expect(err.status).toBe(409);
    expect(getSettings().power.lidClosedAwake).toBe(false);
    expect(mac.sleepDisabled).toBe(false);
    expect(mac.calls.filter(([bin]) => bin === "/usr/bin/osascript")).toHaveLength(1);
    // The marker stays in case root acted at the last moment; the next start finds sleep on and drops it.
    await startPower();
    expect(existsSync(marker())).toBe(false);
  });

  test("paused by hand: the Mac may sleep; a short usage limit keeps it awake", async () => {
    mac.rule = true;
    setPowerDeps({ platform: "darwin", exec, user: "alex", pollMs: 60_000, idleGraceMs: 40 });
    await startPower();
    updateSettings({ power: { onlyWhileWorking: true } });
    await setLidClosedAwake(true);
    // Only the pause rows matter here, not the runs and chats they belong to.
    run("PRAGMA foreign_keys = OFF");
    const pause = (id: string, reason: string, resumeAt: string | null) => {
      run(
        "INSERT INTO paused_runs (run_id, conversation_id, agent_id, message_id, reason, resume_at, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        id, `c_${id}`, "agt_x", `m_${id}`, reason, resumeAt, new Date().toISOString(),
      );
      runEvent("run.started", id);
      bus.emit({ type: "run.paused", run: { id } as Run } as never);
    };
    pause("run_limit", "limit", new Date(Date.now() + 10 * 60_000).toISOString());
    await sleep(150);
    expect(mac.sleepDisabled).toBe(true);
    runEvent("run.finished", "run_limit");
    pause("run_user", "user", null);
    await sleep(150);
    expect(mac.sleepDisabled).toBe(false);
  });

  test("a hand-set disablesleep on a Mac without a lid is not Godmode's", async () => {
    mac.hasBattery = false;
    mac.sleepDisabled = true;
    await startPower();
    expect(await powerStatus()).toMatchObject({ supported: false, active: true, owned: false });
  });

  test("the settings patch can't switch it and checks the rest", () => {
    expect(() => checkSettingsPatch({ power: { lidClosedAwake: true } }, () => {})).toThrow("/api/power/lid");
    expect(() => checkSettingsPatch({ power: { minBattery: 15 } }, () => {})).toThrow("power.minBattery");
    expect(() => checkSettingsPatch({ power: { onlyWhileWorking: "yes" } }, () => {})).toThrow("true or false");
    expect(() => checkSettingsPatch({ power: { onlyWhileWorking: true, minBattery: 30 } }, () => {})).not.toThrow();
  });
});

describe("setup script", () => {
  test("refuses a user name that could break out of the rule", () => {
    expect(() => setupScript("alex ALL=(ALL) ALL", true)).toThrow();
    expect(() => setupScript("a'b", true)).toThrow();
    expect(() => setupScript("alex.smith", true)).not.toThrow();
    expect(ruleFile("alex.smith")).toBe("/private/etc/sudoers.d/godmode-power-alex_smith");
  });

  const onMac = process.platform === "darwin" && existsSync("/usr/sbin/visudo") ? test : test.skip;

  onMac("writes a rule visudo accepts, and survives AppleScript's string quoting", async () => {
    const dir = mkdtempSync(join(dataDir, "rules-"));
    const out = join(dir, "godmode-power-alex");
    const script = setupScript("alex", true).replaceAll("/private/etc/sudoers.d", dir).replace("&& /usr/bin/pmset -a disablesleep 1", "&& /usr/bin/true");
    const sh = Bun.spawnSync(["/bin/sh", "-c", script]);
    expect(sh.exitCode).toBe(0);
    const rule = readFileSync(out, "utf8");
    expect(rule).toBe("# Godmode: keep working with the lid closed\nalex ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n");
    expect(Bun.spawnSync(["/usr/sbin/visudo", "-cf", out]).exitCode).toBe(0);
    expect(Bun.spawnSync(["/bin/ls", "-A", dir]).stdout.toString().trim()).toBe("godmode-power-alex");

    const original = setupScript("alex", false);
    const quoted = original.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const back = Bun.spawnSync(["/usr/bin/osascript", "-e", `return "${quoted}"`]);
    expect(back.stdout.toString().trimEnd()).toBe(original);
  });
});
