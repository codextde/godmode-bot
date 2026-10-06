import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerStatus, DependencyId, DependencyStatus, DoctorReport, Run } from "@godmode/shared";
import { defaultRunnerDataDir, loadConfig } from "../src/config";
import { closeDb, openDb, setMeta } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { probeFullDiskAccess, protectedPaths } from "../src/services/fullDiskAccess";
import { bootstrapDependencies, fixCheck, runnerHealth, setHealthDeps, type HealthDeps } from "../src/remote/health";
import { keepAwakeStatus, restartKeepAwake, setKeepAwakeDeps, setWorking, startKeepAwake, stopKeepAwake } from "../src/remote/keepAwake";
import {
  installService,
  plistPath,
  renderPlist,
  restartService,
  SERVICE_LABEL,
  serviceStatus,
  setLaunchdDeps,
  uninstallService,
} from "../src/remote/launchd";

let tmp: string;

beforeAll(() => {
  setLogLevel("error");
  tmp = mkdtempSync(join(tmpdir(), "godmode-remote-health-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  stopKeepAwake();
  setHealthDeps(null);
  setLaunchdDeps(null);
  setKeepAwakeDeps(null);
});

/* ------------------------------------------------------------------ */
/* launchd                                                              */
/* ------------------------------------------------------------------ */

const LAUNCHCTL = "/bin/launchctl";
const TARGET = `gui/501/${SERVICE_LABEL}`;

/** launchctl as the tests see it: `loaded` is what `print` answers, in order (the last answer repeats). */
function fakeLaunchd(opts: { loaded?: boolean[]; fail?: string[]; pid?: number } = {}) {
  const calls: string[][] = [];
  const answers = [...(opts.loaded ?? [false])];
  const agentsDir = mkdtempSync(join(tmp, "agents-"));
  setLaunchdDeps({
    platform: "darwin",
    agentsDir,
    uid: 501,
    sleep: async () => {},
    exec: async (argv) => {
      calls.push(argv);
      const verb = argv[1]!;
      if (verb === "print") {
        const loaded = answers.length > 1 ? answers.shift()! : answers[0]!;
        return loaded ? { code: 0, stdout: `${TARGET} = {\n\tstate = running\n\tpid = ${opts.pid ?? 4242}\n}\n`, stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
      }
      return opts.fail?.includes(verb) ? { code: 5, stdout: "", stderr: `${verb} failed: 5: Input/output error` } : { code: 0, stdout: "", stderr: "" };
    },
  });
  return { calls, agentsDir, verbs: () => calls.map((c) => c[1]) };
}

describe("the runner service definition", () => {
  test("renders the LaunchAgent macOS expects", () => {
    const plist = renderPlist({ binary: "/Users/alex/.local/bin/godmode", dataDir: "/Users/alex/.godmode-runner" });
    expect(plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.codext.godmode.runner</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/alex/.local/bin/godmode</string>
		<string>runner</string>
		<string>serve</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>StandardOutPath</key>
	<string>/Users/alex/.godmode-runner/logs/service.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/alex/.godmode-runner/logs/service.log</string>
</dict>
</plist>
`);
  });

  test("passes a data dir that isn't the default one to the service, and only then", () => {
    const custom = renderPlist({ binary: "/usr/local/bin/godmode", dataDir: "/Volumes/Work/runner", runnerHome: "/Volumes/Work/runner" });
    expect(custom).toContain("\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>GODMODE_RUNNER_HOME</key>\n\t\t<string>/Volumes/Work/runner</string>\n\t</dict>\n");
    expect(renderPlist({ binary: "/usr/local/bin/godmode", dataDir: "/Volumes/Work/runner" })).not.toContain("EnvironmentVariables");
  });

  test("runs from source with bun and the entry script", () => {
    const plist = renderPlist({ binary: "/opt/homebrew/bin/bun", script: "/src/godmode/packages/core/src/index.ts", dataDir: "/tmp/r" });
    expect(plist).toContain("\t<array>\n\t\t<string>/opt/homebrew/bin/bun</string>\n\t\t<string>/src/godmode/packages/core/src/index.ts</string>\n\t\t<string>runner</string>\n\t\t<string>serve</string>\n\t</array>\n");
  });

  test("escapes paths so they can't break out of the XML", () => {
    const plist = renderPlist({ binary: "/Users/a&b/<bin>/godmode", dataDir: "/Users/a&b/data", runnerHome: "/Users/a&b/data</string><string>x" });
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;bin&gt;/godmode</string>");
    expect(plist).toContain("<string>/Users/a&amp;b/data&lt;/string&gt;&lt;string&gt;x</string>");
    expect(plist).toContain("<string>/Users/a&amp;b/data/logs/service.log</string>");
    expect(plist).not.toContain("a&b");
    expect(plist).not.toContain("<bin>");
  });
});

describe("installing the runner service", () => {
  test("writes the definition and loads it into the desktop session", async () => {
    const launchd = fakeLaunchd();
    const dataDir = mkdtempSync(join(tmp, "data-"));
    await installService({ binary: "/Users/alex/.local/bin/godmode", dataDir });

    const plist = join(launchd.agentsDir, `${SERVICE_LABEL}.plist`);
    expect(plistPath()).toBe(plist);
    expect(launchd.calls).toEqual([
      [LAUNCHCTL, "print", TARGET],
      [LAUNCHCTL, "enable", TARGET],
      [LAUNCHCTL, "bootstrap", "gui/501", plist],
    ]);
    // A temp data dir is not the default one, so the service is told where its data lives.
    expect(dataDir).not.toBe(defaultRunnerDataDir());
    expect(readFileSync(plist, "utf8")).toBe(renderPlist({ binary: "/Users/alex/.local/bin/godmode", dataDir, runnerHome: dataDir }));
    expect(existsSync(join(dataDir, "logs"))).toBe(true);
  });

  test("replaces a service that is already running, waiting until the old one is gone", async () => {
    const launchd = fakeLaunchd({ loaded: [true, true, false] });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    await installService({ binary: "/old/godmode", dataDir });
    expect(launchd.verbs()).toEqual(["print", "bootout", "print", "print", "enable", "bootstrap"]);
    expect(launchd.calls[1]).toEqual([LAUNCHCTL, "bootout", TARGET]);
  });

  test("falls back to `load -w` when bootstrap is refused, and says why when that fails too", async () => {
    const launchd = fakeLaunchd({ fail: ["bootstrap"] });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    await installService({ binary: "/bin/godmode", dataDir });
    expect(launchd.verbs()).toEqual(["print", "enable", "bootstrap", "load"]);
    expect(launchd.calls[3]).toEqual([LAUNCHCTL, "load", "-w", plistPath()]);

    fakeLaunchd({ fail: ["bootstrap", "load"] });
    await expect(installService({ binary: "/bin/godmode", dataDir })).rejects.toThrow("load failed: 5: Input/output error");
  });

  test("uninstalling stops the service and deletes the definition", async () => {
    const launchd = fakeLaunchd({ loaded: [false, true, false] });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    await installService({ binary: "/bin/godmode", dataDir });
    launchd.calls.length = 0;

    expect(await uninstallService()).toBe(true);
    expect(launchd.calls).toEqual([
      [LAUNCHCTL, "print", TARGET],
      [LAUNCHCTL, "bootout", TARGET],
      [LAUNCHCTL, "print", TARGET],
    ]);
    expect(existsSync(plistPath())).toBe(false);
    // The runner's data is not the service's to delete.
    expect(existsSync(dataDir)).toBe(true);

    launchd.calls.length = 0;
    expect(await uninstallService()).toBe(false);
    expect(launchd.verbs()).toEqual(["print"]);
  });

  test("uses `unload` when bootout is refused", async () => {
    const launchd = fakeLaunchd({ loaded: [false, true, false], fail: ["bootout"] });
    await installService({ binary: "/bin/godmode", dataDir: mkdtempSync(join(tmp, "data-")) });
    launchd.calls.length = 0;
    const plist = plistPath();
    await uninstallService();
    expect(launchd.calls.slice(0, 3)).toEqual([
      [LAUNCHCTL, "print", TARGET],
      [LAUNCHCTL, "bootout", TARGET],
      [LAUNCHCTL, "unload", plist],
    ]);
  });

  test("the status tells whether it is installed, loaded and which binary it runs", async () => {
    fakeLaunchd({ loaded: [false] });
    expect(await serviceStatus()).toEqual({ installed: false, loaded: false, pid: null, binary: null });

    fakeLaunchd({ loaded: [false, true], pid: 777 });
    await installService({ binary: "/Users/a&b/godmode", dataDir: mkdtempSync(join(tmp, "data-")) });
    expect(await serviceStatus()).toEqual({ installed: true, loaded: true, pid: 777, binary: "/Users/a&b/godmode" });
  });

  test("restarting kicks the service, or reloads it when macOS refuses", async () => {
    const kicked = fakeLaunchd();
    await restartService();
    expect(kicked.calls).toEqual([[LAUNCHCTL, "kickstart", "-k", TARGET]]);

    const reloaded = fakeLaunchd({ fail: ["kickstart"] });
    await restartService();
    expect(reloaded.verbs()).toEqual(["kickstart", "unload", "load"]);
  });

  test("other systems have no service: nothing is installed and launchctl is never called", async () => {
    const calls: string[][] = [];
    setLaunchdDeps({
      platform: "linux",
      agentsDir: join(tmp, "never"),
      exec: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await expect(installService({ binary: "/bin/godmode", dataDir: join(tmp, "never-data") })).rejects.toThrow("only available on macOS");
    expect(await serviceStatus()).toEqual({ installed: false, loaded: false, pid: null, binary: null });
    expect(await uninstallService()).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(tmp, "never"))).toBe(false);
    expect(existsSync(join(tmp, "never-data"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Health                                                               */
/* ------------------------------------------------------------------ */

const DEPENDENCIES: { id: DependencyId; name: string; required: boolean; installable: boolean }[] = [
  { id: "claude", name: "Claude Code CLI", required: true, installable: true },
  { id: "claude-auth", name: "Claude login", required: true, installable: false },
  { id: "uv", name: "uv (uvx)", required: true, installable: true },
  { id: "browser-use", name: "browser-use", required: true, installable: true },
  { id: "chrome", name: "Chrome / Chromium", required: true, installable: true },
  { id: "git", name: "git", required: false, installable: false },
  { id: "claude-mem", name: "claude-mem (memory)", required: false, installable: true },
  { id: "cua-driver", name: "Cua Driver (computer use)", required: false, installable: true },
];

function doctorReport(overrides: Partial<Record<DependencyId, Partial<DependencyStatus>>> = {}): DoctorReport {
  const dependencies: DependencyStatus[] = DEPENDENCIES.map((d) => ({
    ...d,
    ok: true,
    version: "1.2.3",
    path: `/usr/local/bin/${d.id}`,
    detail: `${d.id} 1.2.3`,
    installHint: `Install ${d.name} by hand`,
    ...overrides[d.id],
  }));
  return { ok: dependencies.every((d) => d.ok || !d.required), platform: "darwin", arch: "arm64", checkedAt: new Date(0).toISOString(), dependencies };
}

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    enabled: true,
    platform: "darwin",
    permissions: { accessibility: true, screenRecording: true },
    native: { available: true, detail: "ready" },
    cua: { enabled: true, installed: true, running: false, version: null, detail: "Ready" },
    supports: { desktop: true, displays: true, windows: true, tabs: true },
    ...overrides,
  };
}

/** A machine where everything is in order; each test breaks what it is about. Nothing here touches the real one. */
async function until(cond: () => boolean, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function machineDeps(overrides: Partial<HealthDeps> = {}) {
  const commands: string[][] = [];
  const installs: DependencyId[] = [];
  const state = { report: doctorReport(), doctorCalls: 0, permissionRequests: 0, keepAwakeRestarts: 0 };
  const deps: HealthDeps = {
    platform: "darwin",
    dataDir: () => "/Users/alex/.godmode-runner",
    doctor: async () => {
      state.doctorCalls++;
      return state.report;
    },
    install: async (id) => {
      installs.push(id);
      return { ok: true, output: `installed ${id}` };
    },
    resolveGh: () => "/opt/homebrew/bin/gh",
    exec: async (argv) => {
      commands.push(argv);
      if (argv[0] === "/opt/homebrew/bin/gh") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n", stderr: "" };
      if (argv[1] === "managername") return { code: 0, stdout: "Aqua\n", stderr: "" };
      if (argv[1] === "--getglobalstate") return { code: 0, stdout: "Firewall is disabled. (State = 0)\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    computer: async () => computer(),
    requestPermissions: async () => {
      state.permissionRequests++;
      return computer();
    },
    fullDiskAccess: () => true,
    vault: () => ({ initialized: true, unlocked: true }),
    configDigest: () => "digest-1",
    service: async () => ({ installed: true, loaded: true, pid: 4242, binary: "/Users/alex/.local/bin/godmode" }),
    keepAwake: () => ({ supported: true, active: true, display: false }),
    restartKeepAwake: () => {
      state.keepAwakeRestarts++;
    },
    freeBytes: () => 200 * 1024 ** 3,
    ...overrides,
  };
  return { deps, commands, installs, state };
}

function machine(overrides: Partial<HealthDeps> = {}) {
  const m = machineDeps(overrides);
  setHealthDeps(m.deps);
  return m;
}

const MAC_CHECKS = ["accessibility", "screen-recording", "full-disk-access", "service", "keep-awake", "gui-session", "firewall"];

describe("runner health", () => {
  test("a runner with everything in place is ok and offers nothing to fix", async () => {
    machine();
    const health = await runnerHealth(true);
    expect(health.ok).toBe(true);
    expect(health.platform).toBe("darwin");
    expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    expect(health.checks.map((c) => c.id)).toEqual([
      "claude",
      "claude-auth",
      "uv",
      "browser-use",
      "chrome",
      "git",
      "gh",
      "cua-driver",
      "accessibility",
      "screen-recording",
      "full-disk-access",
      "vault",
      "config",
      "service",
      "keep-awake",
      "gui-session",
      "disk",
      "firewall",
    ]);
    for (const check of health.checks) {
      expect(check.status).toBe("ok");
      expect(check.fix).toBeNull();
      expect(check.detail.length).toBeGreaterThan(0);
    }
    const byId = Object.fromEntries(health.checks.map((c) => [c.id, c]));
    expect(byId.claude).toMatchObject({ group: "software", name: "Claude Code CLI", required: true, detail: "claude 1.2.3" });
    expect(byId.gh).toMatchObject({ group: "software", required: false, detail: "Signed in to github.com as octocat" });
    expect(byId.accessibility).toMatchObject({ group: "permissions", required: true });
    expect(byId["full-disk-access"]).toMatchObject({ group: "permissions", required: false });
    expect(byId.vault).toMatchObject({ group: "access", required: true });
    expect(byId.config).toMatchObject({ group: "access", required: true });
    expect(byId["gui-session"]).toMatchObject({ group: "system", required: true });
    expect(byId.disk).toMatchObject({ group: "system", required: false, detail: "200 GB free" });
    // The memory backend is the controller's business, not a runner check.
    expect(byId["claude-mem"]).toBeUndefined();
  });

  test("a missing required dependency makes it not ok and offers to install it", async () => {
    const m = machine();
    m.state.report = doctorReport({ claude: { ok: false, version: null, path: null, detail: "claude CLI not found" } });
    const health = await runnerHealth(true);
    expect(health.ok).toBe(false);
    const claude = health.checks.find((c) => c.id === "claude")!;
    expect(claude).toMatchObject({ status: "fail", required: true, detail: "claude CLI not found", fix: { kind: "install", label: "Install" } });
    // Everything else is still fine.
    expect(health.checks.filter((c) => c.status !== "ok").map((c) => c.id)).toEqual(["claude"]);
  });

  test("what isn't required only warns: the runner stays ok", async () => {
    const m = machine({
      resolveGh: () => null,
      fullDiskAccess: () => false,
      service: async () => ({ installed: false, loaded: false, pid: null, binary: null }),
      keepAwake: () => ({ supported: true, active: false, display: false }),
      exec: async (argv) =>
        argv[1] === "--getglobalstate" ? { code: 0, stdout: "Firewall is enabled. (State = 1)\n", stderr: "" } : { code: 0, stdout: "Aqua\n", stderr: "" },
    });
    m.state.report = doctorReport({ git: { ok: false, detail: "git not found", installHint: "Run: xcode-select --install" }, "cua-driver": { ok: false, detail: "Not installed" } });
    const health = await runnerHealth(true);
    expect(health.ok).toBe(true);
    const fixes = Object.fromEntries(health.checks.filter((c) => c.status !== "ok").map((c) => [c.id, { status: c.status, kind: c.fix?.kind }]));
    expect(fixes).toEqual({
      git: { status: "warn", kind: "manual" },
      gh: { status: "warn", kind: "manual" },
      "cua-driver": { status: "warn", kind: "install" },
      "full-disk-access": { status: "warn", kind: "open-settings" },
      service: { status: "warn", kind: "manual" },
      "keep-awake": { status: "warn", kind: "restart" },
      firewall: { status: "warn", kind: "manual" },
    });
    const byId = Object.fromEntries(health.checks.map((c) => [c.id, c]));
    expect(byId.git!.fix!.hint).toBe("Run: xcode-select --install");
    expect(byId.gh!.fix!.hint).toBe("Run `gh auth login` on the runner so coding tasks can open pull requests.");
    expect(byId.service!.fix!.hint).toBe("Run `godmode runner install` on the runner so it starts when you log in.");
    expect(byId.firewall!.fix!.hint).toBe("The macOS firewall is on: allow incoming connections for godmode when macOS asks.");
  });

  test("browser tools are only required while the browser is on", async () => {
    const m = machine();
    const missing = { ok: false, required: false, detail: "not found" };
    m.state.report = doctorReport({ uv: missing, "browser-use": missing, chrome: missing });
    const health = await runnerHealth(true);
    expect(health.ok).toBe(true);
    for (const id of ["uv", "browser-use", "chrome"]) {
      expect(health.checks.find((c) => c.id === id)).toMatchObject({ status: "warn", required: false, fix: { kind: "install" } });
    }
  });

  test("missing screen permissions block work only while computer use is on", async () => {
    const denied = { accessibility: false, screenRecording: false };
    machine({ computer: async () => computer({ permissions: denied }) });
    const on = await runnerHealth(true);
    expect(on.ok).toBe(false);
    expect(on.checks.find((c) => c.id === "accessibility")).toMatchObject({
      status: "fail",
      required: true,
      fix: { kind: "request", hint: "System Settings → Privacy & Security → Accessibility → turn on Godmode" },
    });
    expect(on.checks.find((c) => c.id === "screen-recording")).toMatchObject({ status: "fail", required: true, fix: { kind: "request" } });

    machine({ computer: async () => computer({ enabled: false, permissions: denied }) });
    const off = await runnerHealth(true);
    expect(off.ok).toBe(true);
    expect(off.checks.find((c) => c.id === "accessibility")).toMatchObject({ status: "warn", required: false });

    // No helper to ask: unknown, not a failure.
    machine({ computer: async () => computer({ permissions: { accessibility: null, screenRecording: null } }) });
    const unknown = await runnerHealth(true);
    expect(unknown.ok).toBe(true);
    expect(unknown.checks.find((c) => c.id === "screen-recording")!.status).toBe("unknown");
  });

  test("without the vault key or a copied setup the runner can't work, and Godmode fixes both by syncing", async () => {
    machine({ vault: () => ({ initialized: true, unlocked: false }), configDigest: () => null });
    const health = await runnerHealth(true);
    expect(health.ok).toBe(false);
    expect(health.checks.find((c) => c.id === "vault")).toMatchObject({
      status: "fail",
      fix: { kind: "sync", hint: "Unlock the vault in Godmode; the key is sent to the runner with the next sync." },
    });
    expect(health.checks.find((c) => c.id === "config")).toMatchObject({ status: "fail", fix: { kind: "sync" } });

    machine({ vault: () => ({ initialized: false, unlocked: false }) });
    expect((await runnerHealth(true)).checks.find((c) => c.id === "vault")!.status).toBe("fail");
  });

  test("a runner started outside the desktop session is told to log in on the screen", async () => {
    machine({ exec: async (argv) => (argv[1] === "managername" ? { code: 0, stdout: "Background\n", stderr: "" } : { code: 0, stdout: "(State = 0)", stderr: "" }) });
    const health = await runnerHealth(true);
    expect(health.ok).toBe(false);
    expect(health.checks.find((c) => c.id === "gui-session")).toMatchObject({
      status: "fail",
      detail: "No desktop session (Background)",
      fix: { kind: "manual", hint: "Log in on the runner's screen (or enable automatic login): the browser and screen control need a desktop session." },
    });
  });

  test("little disk space warns below 10 GB and fails below 2 GB without blocking work", async () => {
    machine({ freeBytes: () => 9.5 * 1024 ** 3 });
    const low = await runnerHealth(true);
    expect(low.checks.find((c) => c.id === "disk")).toMatchObject({ status: "warn", detail: "9.5 GB free", fix: { kind: "manual" } });
    expect(low.ok).toBe(true);

    machine({ freeBytes: () => 1.2 * 1024 ** 3 });
    const full = await runnerHealth(true);
    expect(full.checks.find((c) => c.id === "disk")).toMatchObject({ status: "fail", detail: "1.2 GB free", required: false });
    expect(full.ok).toBe(true);

    machine({ freeBytes: () => null });
    expect((await runnerHealth(true)).checks.find((c) => c.id === "disk")!.status).toBe("unknown");
  });

  test("on other systems the macOS checks are left out instead of failing", async () => {
    const m = machine({
      platform: "linux",
      computer: async () => {
        throw new Error("must not be asked on linux");
      },
      service: async () => {
        throw new Error("must not be asked on linux");
      },
      fullDiskAccess: () => {
        throw new Error("must not be asked on linux");
      },
    });
    const health = await runnerHealth(true);
    expect(health.ok).toBe(true);
    expect(health.platform).toBe("linux");
    expect(health.checks.map((c) => c.id)).toEqual(["claude", "claude-auth", "uv", "browser-use", "chrome", "git", "gh", "cua-driver", "vault", "config", "disk"]);
    // Neither launchctl nor the firewall tool is run.
    expect(m.commands).toEqual([["/opt/homebrew/bin/gh", "auth", "status"]]);
    for (const id of MAC_CHECKS) expect(await fixCheck(id)).toEqual({ ok: false, output: `Unknown check: ${id}` });
  });

  test("Full Disk Access that can't be checked is unknown, not a warning", async () => {
    machine({ fullDiskAccess: () => null });
    const health = await runnerHealth(true);
    expect(health.checks.find((c) => c.id === "full-disk-access")).toMatchObject({
      status: "unknown",
      detail: "Couldn't check — none of the protected folders exist here",
    });
  });

  test("a report is reused for a moment unless a fresh one is asked for", async () => {
    const m = machine();
    const first = await runnerHealth();
    expect(await runnerHealth()).toBe(first);
    expect(m.state.doctorCalls).toBe(1);
    expect(await runnerHealth(true)).not.toBe(first);
    expect(m.state.doctorCalls).toBe(2);
    // A fix changes what there is to find.
    await fixCheck("keep-awake");
    await runnerHealth();
    expect(m.state.doctorCalls).toBe(3);
  });

  test("the setup check reads the digest the last sync stored", async () => {
    const dataDir = mkdtempSync(join(tmp, "db-"));
    loadConfig({ dataDir });
    openDb(join(dataDir, "test.db"));
    try {
      // Everything faked except where the digest comes from.
      const deps: Partial<HealthDeps> = machineDeps().deps;
      delete deps.configDigest;
      setHealthDeps(deps);
      expect((await runnerHealth(true)).checks.find((c) => c.id === "config")!.status).toBe("fail");
      setMeta("link.config_digest", "abc123");
      expect((await runnerHealth(true)).checks.find((c) => c.id === "config")!.status).toBe("ok");
    } finally {
      closeDb();
    }
  });
});

describe("the Full Disk Access probe", () => {
  const place = (name: string) => mkdtempSync(join(tmp, `${name}-`));

  test("nothing protected exists: unknown instead of not allowed", () => {
    const home = place("empty-home");
    expect(probeFullDiskAccess([{ path: join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"), dir: false }, { path: join(home, "Library", "Mail"), dir: true }])).toBeNull();
  });

  test("one readable place is enough, even when the privacy database is missing", () => {
    const home = place("mail-home");
    const mail = join(home, "Library", "Mail");
    mkdirSync(mail, { recursive: true });
    expect(probeFullDiskAccess([{ path: join(home, "TCC.db"), dir: false }, { path: mail, dir: true }])).toBe(true);
  });

  test.if(process.getuid?.() !== 0)("refused everywhere it exists: not allowed", () => {
    const home = place("locked-home");
    const db = join(home, "TCC.db");
    const mail = join(home, "Mail");
    writeFileSync(db, "");
    mkdirSync(mail);
    chmodSync(db, 0o000);
    chmodSync(mail, 0o000);
    try {
      expect(probeFullDiskAccess([{ path: db, dir: false }, { path: join(home, "Safari"), dir: true }, { path: mail, dir: true }])).toBe(false);
    } finally {
      chmodSync(db, 0o600);
      chmodSync(mail, 0o700);
    }
  });

  test("checks the per-user and the system privacy database before the folders", () => {
    expect(protectedPaths("/Users/alex").map((p) => p.path)).toEqual([
      "/Users/alex/Library/Application Support/com.apple.TCC/TCC.db",
      "/Library/Application Support/com.apple.TCC/TCC.db",
      "/Users/alex/Library/Safari",
      "/Users/alex/Library/Mail",
      "/Users/alex/Library/Messages",
    ]);
  });
});

describe("fixing a check", () => {
  test("names every object has are unknown checks, not fixes", async () => {
    machine();
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(await fixCheck(id)).toEqual({ ok: false, output: `Unknown check: ${id}` });
    }
  });

  test("an install fix runs the installer and hands back what it printed", async () => {
    const m = machine();
    expect(await fixCheck("claude")).toEqual({ ok: true, output: "installed claude" });
    expect(m.installs).toEqual(["claude"]);
    // Nothing but the installer ran.
    expect(m.commands).toEqual([]);

    machine({ install: async () => ({ ok: false, output: "curl: (6) Could not resolve host" }) });
    expect(await fixCheck("chrome")).toEqual({ ok: false, output: "curl: (6) Could not resolve host" });
  });

  test("a permission fix asks macOS and says where to allow it when the human still has to", async () => {
    const granted = machine();
    expect(await fixCheck("accessibility")).toEqual({ ok: true, output: "Allowed." });
    expect(granted.state.permissionRequests).toBe(1);

    machine({ requestPermissions: async () => computer({ permissions: { accessibility: true, screenRecording: false } }) });
    expect(await fixCheck("accessibility")).toEqual({ ok: true, output: "Allowed." });
    const pending = await fixCheck("screen-recording");
    expect(pending.ok).toBe(false);
    expect(pending.output).toBe(
      "macOS asks on the runner's own screen. System Settings → Privacy & Security → Screen & System Audio Recording → turn on Godmode",
    );

    machine({
      requestPermissions: async () => {
        throw new Error("The screen helper isn't available");
      },
    });
    expect(await fixCheck("accessibility")).toEqual({ ok: false, output: "The screen helper isn't available" });
  });

  test("the Full Disk Access fix opens the right pane of System Settings", async () => {
    const m = machine();
    const result = await fixCheck("full-disk-access");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Full Disk Access");
    expect(m.commands).toEqual([["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]]);
  });

  test("the keep-awake fix restarts the helper", async () => {
    const m = machine();
    expect(await fixCheck("keep-awake")).toEqual({ ok: true, output: "The runner keeps this Mac awake again." });
    expect(m.state.keepAwakeRestarts).toBe(1);

    machine({ keepAwake: () => ({ supported: true, active: false, display: false }) });
    expect((await fixCheck("keep-awake")).ok).toBe(false);
  });

  test("what only Godmode or the human can do answers with the hint and changes nothing", async () => {
    const m = machine();
    m.state.report = doctorReport({ git: { installHint: "Run: xcode-select --install" } });
    expect(await fixCheck("vault")).toEqual({ ok: false, output: "Unlock the vault in Godmode; the key is sent to the runner with the next sync." });
    expect((await fixCheck("config")).ok).toBe(false);
    expect((await fixCheck("claude-auth")).output).toBe(
      "Run `claude` in Terminal on the runner and sign in, or add an Anthropic API key in Godmode (Settings → AI) and sync.",
    );
    expect(await fixCheck("git")).toEqual({ ok: false, output: "Run: xcode-select --install" });
    expect((await fixCheck("gui-session")).ok).toBe(false);
    expect(await fixCheck("nope")).toEqual({ ok: false, output: "Unknown check: nope" });
    expect(m.installs).toEqual([]);
    expect(m.commands).toEqual([]);
    expect(m.state.permissionRequests).toBe(0);
  });

  test("a report made while a fix runs doesn't answer for the time after it", async () => {
    const m = slowMachine();
    m.state.report = doctorReport({ claude: MISSING });
    const installed = gate();
    m.deps.install = async () => {
      await installed.passed;
      m.state.report = doctorReport();
      return { ok: true, output: "installed claude" };
    };
    setHealthDeps(m.deps);

    const fix = fixCheck("claude");
    // The health view keeps asking while the installer runs.
    expect((await runnerHealth()).ok).toBe(false);
    // And a fresh look ("Check again") is still being put together when the installer is done.
    const answering = gate();
    m.holdNextReport(answering.passed);
    const begunBefore = runnerHealth(true);
    installed.open();
    expect(await fix).toEqual({ ok: true, output: "installed claude" });

    const after = await runnerHealth();
    expect(after.checks.find((c) => c.id === "claude")).toMatchObject({ status: "ok", fix: null });
    expect(after.ok).toBe(true);

    answering.open();
    expect((await begunBefore).ok).toBe(false);
    // What was found before the fix ended is not what the next question gets.
    expect(await runnerHealth()).toBe(after);
  });
});

/** Something a test lets happen when it is ready for it. */
function gate() {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => (open = resolve));
  return { passed, open };
}

const MISSING = { ok: false, version: null, path: null, detail: "not found" };

/** A machine whose doctor can be made to take its time: the next report waits for `until`, and tells what it saw before. */
function slowMachine() {
  const m = machineDeps();
  let hold: Promise<void> | null = null;
  m.deps.doctor = async () => {
    const report = m.state.report;
    const until = hold;
    hold = null;
    await until;
    return report;
  };
  return { ...m, holdNextReport: (until: Promise<void>) => void (hold = until) };
}

describe("a fresh runner installs what it needs", () => {
  test("only what is missing, required and installable — in order, uv before what needs it", async () => {
    const missing = { ok: false, version: null, path: null, detail: "not found" };
    const m = machineDeps();
    m.state.report = doctorReport({
      claude: missing,
      "claude-auth": missing, // required, but a login can't be installed
      uv: missing,
      "browser-use": { ...missing, installable: false }, // needs uv first
      chrome: { ...missing, installable: false },
      git: missing, // not required
      "cua-driver": missing, // installable, but optional
    });
    m.deps.install = async (id) => {
      m.installs.push(id);
      // Like the real doctor: with uv in place, browser-use and Chrome become installable.
      const fixed: Partial<Record<DependencyId, Partial<DependencyStatus>>> = {};
      for (const done of m.installs) fixed[done] = { ok: true };
      const uv = m.installs.includes("uv");
      m.state.report = doctorReport({
        claude: missing,
        "claude-auth": missing,
        uv: missing,
        "browser-use": { ...missing, installable: uv },
        chrome: { ...missing, installable: uv },
        git: missing,
        "cua-driver": missing,
        ...fixed,
      });
      return { ok: true, output: "Done." };
    };
    setHealthDeps(m.deps);

    await bootstrapDependencies();
    expect(m.installs).toEqual(["claude", "uv", "browser-use", "chrome"]);
  });

  test("nothing is installed on a runner that has everything", async () => {
    const m = machine();
    await bootstrapDependencies();
    expect(m.installs).toEqual([]);
  });

  test("browser tools stay away while the browser is off, and a failed install doesn't stop the rest", async () => {
    const missing = { ok: false, version: null, path: null, detail: "not found" };
    const m = machineDeps();
    m.state.report = doctorReport({ claude: missing, uv: { ...missing, required: false }, "browser-use": { ...missing, required: false }, chrome: missing });
    m.deps.install = async (id) => {
      m.installs.push(id);
      return { ok: false, output: "network is down" };
    };
    setHealthDeps(m.deps);
    await bootstrapDependencies();
    expect(m.installs).toEqual(["claude", "chrome"]);
  });

  test("while it installs, the report names everything that is still on its way", async () => {
    const missing = { ok: false, version: null, path: null, detail: "not found" };
    const m = machineDeps();
    m.state.report = doctorReport({ claude: missing, chrome: missing });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    m.deps.install = async (id) => {
      m.installs.push(id);
      await gate;
      return { ok: true, output: "Done." };
    };
    setHealthDeps(m.deps);
    const running = bootstrapDependencies();
    await until(() => m.installs.length === 1);
    expect((await runnerHealth(true)).installing?.sort()).toEqual(["chrome", "claude"]);
    release();
    await running;
    expect((await runnerHealth(true)).installing).toBeUndefined();
  });

  test("runs once per process start", async () => {
    const missing = { ok: false, version: null, path: null, detail: "not found" };
    const m = machine();
    m.state.report = doctorReport({ claude: missing });
    await Promise.all([bootstrapDependencies(), bootstrapDependencies()]);
    await bootstrapDependencies();
    expect(m.installs).toEqual(["claude"]);
  });

  test("a report that was begun before an install finished is not kept as the latest", async () => {
    const m = slowMachine();
    m.state.report = doctorReport({ claude: MISSING });
    const installed = gate();
    m.deps.install = async () => {
      await installed.passed;
      m.state.report = doctorReport();
      return { ok: true, output: "Done." };
    };
    setHealthDeps(m.deps);

    const bootstrap = bootstrapDependencies();
    // Let it get as far as the installer, then ask for the health while that runs.
    await tick();
    const answering = gate();
    m.holdNextReport(answering.passed);
    const begunBefore = runnerHealth();
    installed.open();
    await bootstrap;
    answering.open();
    expect((await begunBefore).ok).toBe(false);
    expect((await runnerHealth()).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Keep awake                                                           */
/* ------------------------------------------------------------------ */

interface FakeHelper {
  argv: string[];
  killed: boolean;
  exited: Promise<void>;
  /** The helper dies by itself. */
  die(): void;
  kill(): void;
}

function fakeCaffeinate(platform: NodeJS.Platform = "darwin") {
  const spawned: FakeHelper[] = [];
  setKeepAwakeDeps({
    platform,
    restartDelayMs: 5,
    spawn: (argv) => {
      let exit!: () => void;
      const helper: FakeHelper = {
        argv,
        killed: false,
        exited: new Promise<void>((resolve) => (exit = resolve)),
        die: () => exit(),
        kill() {
          helper.killed = true;
          exit();
        },
      };
      spawned.push(helper);
      return helper;
    },
  });
  return spawned;
}

const run = (id: string) => ({ id }) as Run;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("keeping the runner awake", () => {
  test("holds the system awake for as long as the runner's process lives", () => {
    const spawned = fakeCaffeinate();
    expect(keepAwakeStatus()).toEqual({ supported: true, active: false, display: false });
    startKeepAwake();
    startKeepAwake();
    expect(spawned.map((h) => h.argv)).toEqual([["/usr/bin/caffeinate", "-i", "-m", "-s", "-w", String(process.pid)]]);
    expect(keepAwakeStatus()).toEqual({ supported: true, active: true, display: false });

    stopKeepAwake();
    expect(spawned[0]!.killed).toBe(true);
    expect(keepAwakeStatus()).toEqual({ supported: true, active: false, display: false });
  });

  test("keeps the display on while runs work, and lets it sleep when the last one finishes or pauses", () => {
    const spawned = fakeCaffeinate();
    startKeepAwake();
    bus.emit({ type: "run.started", run: run("run_a") });
    expect(spawned.map((h) => h.argv[1])).toEqual(["-i", "-d"]);
    expect(spawned[1]!.argv).toEqual(["/usr/bin/caffeinate", "-d", "-w", String(process.pid)]);
    expect(keepAwakeStatus().display).toBe(true);

    bus.emit({ type: "run.started", run: run("run_b") });
    // A paused run that continues announces itself again; it still counts once.
    bus.emit({ type: "run.started", run: run("run_b") });
    expect(spawned.length).toBe(2);
    bus.emit({ type: "run.finished", run: run("run_a") });
    expect(keepAwakeStatus().display).toBe(true);
    bus.emit({ type: "run.paused", run: run("run_b") });
    expect(spawned[1]!.killed).toBe(true);
    expect(keepAwakeStatus()).toEqual({ supported: true, active: true, display: false });

    setWorking(true);
    expect(spawned.length).toBe(3);
    expect(keepAwakeStatus().display).toBe(true);
  });

  test("starts caffeinate again when it dies, but not after the runner stopped", async () => {
    const spawned = fakeCaffeinate();
    startKeepAwake();
    spawned[0]!.die();
    await tick();
    expect(keepAwakeStatus().active).toBe(false);
    await tick(30);
    expect(spawned.length).toBe(2);
    expect(keepAwakeStatus().active).toBe(true);

    spawned[1]!.die();
    await tick();
    stopKeepAwake();
    await tick(30);
    expect(spawned.length).toBe(2);
  });

  test("a restart replaces the helpers and remembers that runs are working", () => {
    const spawned = fakeCaffeinate();
    startKeepAwake();
    bus.emit({ type: "run.started", run: run("run_a") });
    restartKeepAwake();
    expect(spawned.map((h) => h.killed)).toEqual([true, true, false, false]);
    expect(spawned.slice(2).map((h) => h.argv[1])).toEqual(["-i", "-d"]);
    expect(keepAwakeStatus()).toEqual({ supported: true, active: true, display: true });
  });

  test("does nothing on systems without caffeinate", () => {
    const spawned = fakeCaffeinate("linux");
    startKeepAwake();
    setWorking(true);
    bus.emit({ type: "run.started", run: run("run_a") });
    expect(spawned).toEqual([]);
    expect(keepAwakeStatus()).toEqual({ supported: false, active: false, display: false });
  });
});
