import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerStatus, DependencyStatus, DoctorReport, RunnerCheck, RunnerHealth } from "@godmode/shared";
import { loadConfig, VERSION } from "../src/config";
import { closeDb, get, getMeta, insert, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { answerHealth, HEALTH_PATH, runnerFile, runningRunner, runRunnerCli, servingRunner, type RunnerProcess } from "../src/remote/cli";
import { runnerHealth, setHealthDeps, type HealthDeps } from "../src/remote/health";
import { plistPath, SERVICE_LABEL, setLaunchdDeps } from "../src/remote/launchd";
import { getAccessToken } from "../src/server/auth";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { childEnv } from "../src/util";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let tmp: string;
/** Listeners that stand in for a serving runner, stopped after each test. */
const listeners: { stop(force?: boolean): unknown }[] = [];

beforeAll(() => {
  setLogLevel("error");
  tmp = mkdtempSync(join(tmpdir(), "godmode-remote-cli-"));
});

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  // The runner children start fake Claude probes (doctor, model catalog) that can outlive them by a moment and make
  // their state folder again: clear up once more after they are gone.
  await new Promise((r) => setTimeout(r, 3_000));
  rmSync(tmp, { recursive: true, force: true });
}, 10_000);

afterEach(() => {
  closeDb();
  resetSettingsCache();
  setHealthDeps(null);
  setLaunchdDeps(null);
  for (const listener of listeners.splice(0)) listener.stop(true);
});

/** Runs `godmode runner <argv…>` in this process and collects what it prints. */
async function runner(argv: string[], serve: (values: Record<string, unknown>) => Promise<void> = async () => {}) {
  const lines: string[] = [];
  const code = await runRunnerCli(argv, { serve, print: (line) => lines.push(line) });
  return { code, lines, output: lines.join("\n") };
}

/** launchctl and the LaunchAgents folder, faked. `onStart` stands in for the service coming up. */
function fakeLaunchd(opts: { platform?: NodeJS.Platform; loaded?: boolean; onStart?: () => void } = {}) {
  const calls: string[][] = [];
  let loaded = opts.loaded ?? false;
  setLaunchdDeps({
    platform: opts.platform ?? "darwin",
    agentsDir: mkdtempSync(join(tmp, "agents-")),
    uid: 501,
    sleep: async () => {},
    exec: async (argv) => {
      calls.push(argv);
      const verb = argv[1];
      if (verb === "print") return loaded ? { code: 0, stdout: "\tpid = 4242\n", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
      if (verb === "bootout") loaded = false;
      if (verb === "bootstrap") {
        loaded = true;
        opts.onStart?.();
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { calls, verbs: () => calls.map((c) => c[1]) };
}

function writeRunnerFile(dataDir: string, info: Partial<RunnerProcess> = {}) {
  const full: RunnerProcess = { pid: process.pid, apiPort: 50123, linkPort: 7788, startedAt: new Date().toISOString(), version: VERSION, ...info };
  writeFileSync(runnerFile(dataDir), JSON.stringify(full), { mode: 0o600 });
}

/** A loopback port nothing listens on. */
function closedPort(): number {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  return port;
}

/** What a serving runner answers `runner status`: checks only it can make are among them. */
function reportedHealth(overrides: Partial<Record<string, Partial<RunnerCheck>>> = {}): RunnerHealth {
  const check = (id: string, name: string, detail: string, extra: Partial<RunnerCheck> = {}): RunnerCheck => ({
    id,
    group: "system",
    name,
    status: "ok",
    detail,
    required: true,
    fix: null,
    ...extra,
    ...overrides[id],
  });
  const checks = [
    check("claude", "Claude Code CLI", "claude 2.0.0"),
    check("gh", "GitHub CLI", "gh is not installed", {
      status: "warn",
      required: false,
      fix: { kind: "manual", label: "Sign in to GitHub", hint: "Run `gh auth login` on the runner so coding tasks can open pull requests." },
    }),
    check("accessibility", "Accessibility", "Allowed"),
    check("vault", "Vault", "Unlocked"),
    check("keep-awake", "Keep awake", "This Mac stays awake", { required: false }),
    check("gui-session", "Desktop session", "Logged in on the screen"),
  ];
  return { ok: !checks.some((c) => c.required && c.status === "fail"), checkedAt: new Date().toISOString(), platform: "darwin", checks };
}

/** Stands in for the runner that serves from `dataDir`: answers on loopback like one, and remembers who asked for its checks. */
function standInRunner(dataDir: string, answer: (req: Request) => Response | Promise<Response>) {
  const asked: (string | null)[] = [];
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/health") return Response.json({ ok: true, name: "godmode-bot" });
      if (path !== HEALTH_PATH) return new Response("Not found", { status: 404 });
      asked.push(req.headers.get("authorization"));
      return answer(req);
    },
  });
  listeners.push(listener);
  writeRunnerFile(dataDir, { apiPort: listener.port!, linkPort: 7790 });
  return { asked };
}

/** A terminal that is allowed nothing and has no desktop session — which says nothing about the runner. */
const BARE_TERMINAL: Partial<HealthDeps> = {
  computer: async () => ({
    enabled: true,
    platform: "darwin",
    permissions: { accessibility: false, screenRecording: false },
    native: { available: true, detail: "ready" },
    cua: { enabled: true, installed: true, running: false, version: null, detail: "Ready" },
    supports: { desktop: true, displays: true, windows: true, tabs: true },
  }),
  fullDiskAccess: () => false,
  exec: async (argv) => ({ code: 0, stdout: argv[1] === "managername" ? "Background\n" : "Firewall is disabled. (State = 0)\n", stderr: "" }),
};

/** A healthy machine for `runner status`; nothing here looks at the real one. */
function fakeHealth(overrides: Partial<HealthDeps> = {}) {
  const dependency = (id: DependencyStatus["id"], name: string, required: boolean): DependencyStatus => ({
    id,
    name,
    ok: true,
    version: "1.0.0",
    path: `/usr/local/bin/${id}`,
    detail: `${id} 1.0.0`,
    required,
    installable: true,
    installHint: `Install ${name}`,
  });
  const report: DoctorReport = {
    ok: true,
    platform: "darwin",
    arch: "arm64",
    checkedAt: new Date(0).toISOString(),
    dependencies: [dependency("claude", "Claude Code CLI", true), dependency("claude-auth", "Claude login", true), dependency("git", "git", false)],
  };
  const computer: ComputerStatus = {
    enabled: true,
    platform: "darwin",
    permissions: { accessibility: true, screenRecording: true },
    native: { available: true, detail: "ready" },
    cua: { enabled: true, installed: true, running: false, version: null, detail: "Ready" },
    supports: { desktop: true, displays: true, windows: true, tabs: true },
  };
  const deps: HealthDeps = {
    platform: "darwin",
    dataDir: () => tmp,
    doctor: async () => report,
    install: async () => ({ ok: true, output: "Done." }),
    resolveGh: () => null,
    exec: async (argv) => ({ code: 0, stdout: argv[1] === "managername" ? "Aqua\n" : "Firewall is disabled. (State = 0)\n", stderr: "" }),
    computer: async () => computer,
    requestPermissions: async () => computer,
    fullDiskAccess: () => true,
    vault: () => ({ initialized: true, unlocked: true }),
    configDigest: () => "digest-1",
    service: async () => ({ installed: true, loaded: true, pid: 4242, binary: "/usr/local/bin/godmode" }),
    // What this process knows about keeping awake says nothing about the serving runner.
    keepAwake: () => ({ supported: true, active: false, display: false }),
    restartKeepAwake: () => {},
    freeBytes: () => 100 * 1024 ** 3,
    ...overrides,
  };
  setHealthDeps(deps);
}

describe("godmode runner install", () => {
  test("without the service it prepares the data dir and the link port and says how to start", async () => {
    const launchd = fakeLaunchd();
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const result = await runner(["install", "--no-service", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.output).toContain(dataDir);
    expect(result.output).toContain("godmode runner serve");
    expect(existsSync(join(dataDir, "godmode.db"))).toBe(true);
    expect(getMeta("link.port")).toBe("7788");
    expect(launchd.calls).toEqual([]);
    expect(existsSync(plistPath())).toBe(false);
  });

  test("a link port that was chosen stays until another one is asked for", async () => {
    fakeLaunchd();
    const dataDir = mkdtempSync(join(tmp, "data-"));
    expect((await runner(["install", "--no-service", "--data-dir", dataDir, "--port", "9100"])).code).toBe(0);
    expect(getMeta("link.port")).toBe("9100");
    closeDb();
    expect((await runner(["install", "--no-service", "--data-dir", dataDir])).code).toBe(0);
    expect(getMeta("link.port")).toBe("9100");
    closeDb();
    expect((await runner(["install", "--no-service", "--data-dir", dataDir, "--port", "9200"])).code).toBe(0);
    expect(getMeta("link.port")).toBe("9200");
  });

  test("refuses something that isn't a port before touching anything", async () => {
    const launchd = fakeLaunchd();
    const dataDir = join(tmp, "never-created");
    for (const port of ["0", "70000", "abc", "80.5"]) {
      const result = await runner(["install", "--data-dir", dataDir, "--port", port]);
      expect(result.code).toBe(2);
      expect(result.output).toContain("isn't a port");
    }
    expect(existsSync(dataDir)).toBe(false);
    expect(launchd.calls).toEqual([]);
  });

  test("installs the service and waits until the runner it started is up", async () => {
    const dataDir = mkdtempSync(join(tmp, "data-"));
    // What an earlier instance left behind must not be taken for the new one.
    writeRunnerFile(dataDir, { pid: process.pid, startedAt: new Date(Date.now() - 60_000).toISOString() });
    const launchd = fakeLaunchd({ onStart: () => writeRunnerFile(dataDir, { startedAt: new Date(Date.now() + 1_000).toISOString() }) });

    const result = await runner(["install", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`pid ${process.pid}`);
    expect(launchd.verbs()).toEqual(["print", "enable", "bootstrap"]);
    const plist = readFileSync(plistPath(), "utf8");
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("\t\t<string>runner</string>\n\t\t<string>serve</string>\n\t</array>");
    expect(plist).toContain(`<key>GODMODE_RUNNER_HOME</key>\n\t\t<string>${dataDir}</string>`);
    expect(plist).toContain(`<string>${join(dataDir, "logs", "service.log")}</string>`);
    expect(getMeta("link.port")).toBe("7788");
  });

  test("running it again replaces the service and restarts it", async () => {
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const launchd = fakeLaunchd({ loaded: true, onStart: () => writeRunnerFile(dataDir, { startedAt: new Date(Date.now() + 1_000).toISOString() }) });
    expect((await runner(["install", "--data-dir", dataDir])).code).toBe(0);
    expect(launchd.verbs()).toEqual(["print", "bootout", "print", "enable", "bootstrap"]);
  });

  test("on other systems there is no service to install, only the way to start it", async () => {
    const launchd = fakeLaunchd({ platform: "linux" });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const result = await runner(["install", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("only available on macOS");
    expect(result.output).toContain("godmode runner serve");
    expect(launchd.calls).toEqual([]);
  });
});

describe("godmode runner status", () => {
  test("shows the service, the link port and the checks the serving runner made itself", async () => {
    fakeLaunchd({ loaded: true });
    // What this terminal is allowed says nothing about the runner: it must not even be looked at.
    let looked = false;
    fakeHealth({
      ...BARE_TERMINAL,
      doctor: async () => {
        looked = true;
        throw new Error("the terminal looked for itself");
      },
    });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const served = standInRunner(dataDir, () => Response.json(reportedHealth()));
    const result = await runner(["status", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`Godmode runner ${VERSION} — ${dataDir}`);
    // The definition is not there (nothing was installed in this test), but launchd knows the service.
    expect(result.output).toContain("Service    installed, running (pid 4242)");
    expect(result.output).toContain(`Runner     running (pid ${process.pid})`);
    expect(result.output).toContain("Link port  7790");
    expect(result.output).toContain(`✅ ${"Claude Code CLI".padEnd(22)} claude 2.0.0`);
    expect(result.output).toContain(`✅ ${"Vault".padEnd(22)} Unlocked`);
    expect(result.output).toContain(`⚠️  ${"GitHub CLI".padEnd(22)} gh is not installed — Run \`gh auth login\` on the runner so coding tasks can open pull requests.`);
    expect(result.output).toContain(`✅ ${"Accessibility".padEnd(22)} Allowed`);
    expect(result.output).toContain(`✅ ${"Desktop session".padEnd(22)} Logged in on the screen`);
    // Keeping the Mac awake is the serving process's doing, and that is the one that answered.
    expect(result.output).toContain(`✅ ${"Keep awake".padEnd(22)} This Mac stays awake`);
    expect(result.output).not.toContain("from this terminal");
    expect(looked).toBe(false);
    // Asked once, with the access token.
    expect(served.asked).toEqual([`Bearer ${getAccessToken()}`]);
  });

  test("exits with 1 when the serving runner finds a required check failing, although this terminal finds nothing wrong", async () => {
    fakeLaunchd({ loaded: true });
    fakeHealth();
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const hint = "System Settings → Privacy & Security → Accessibility → turn on Godmode";
    standInRunner(dataDir, () =>
      Response.json(
        reportedHealth({ accessibility: { status: "fail", detail: "Not allowed — agents can't click or type", fix: { kind: "request", label: "Ask for permission", hint } } }),
      ),
    );
    const result = await runner(["status", "--data-dir", dataDir]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`❌ ${"Accessibility".padEnd(22)} Not allowed — agents can't click or type — ${hint}`);
  });

  test("status and a serving runner understand each other", async () => {
    fakeLaunchd({ loaded: true });
    fakeHealth({ keepAwake: () => ({ supported: true, active: true, display: false }) });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const served = standInRunner(dataDir, answerHealth);
    const result = await runner(["status", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(served.asked.length).toBe(1);
    expect(result.output).not.toContain("from this terminal");
    expect(result.output).toContain(`✅ ${"Keep awake".padEnd(22)} This Mac stays awake`);
    expect(result.output).toContain(`✅ ${"Screen Recording".padEnd(22)} Allowed`);
  });

  test("when the runner can't be asked, what only it can check is left out and doesn't decide the exit code", async () => {
    fakeLaunchd({ loaded: true });
    fakeHealth(BARE_TERMINAL);
    const dataDir = mkdtempSync(join(tmp, "data-"));
    // An older Godmode serves there: it doesn't know the question.
    const served = standInRunner(dataDir, () => Response.json({ error: "Not found", code: "not_found" }, { status: 404 }));
    const result = await runner(["status", "--data-dir", dataDir]);
    expect(served.asked.length).toBe(1);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`Runner     running (pid ${process.pid})`);
    expect(result.output).toContain("The runner didn't answer, so these checks were made from this terminal.");
    for (const name of ["Accessibility", "Screen Recording", "Full Disk Access", "Desktop session", "Keep awake"]) expect(result.output).not.toContain(name);
    expect(result.output).toContain(`✅ ${"Claude Code CLI".padEnd(22)} claude 1.0.0`);
    expect(result.output).toContain(`✅ ${"Vault".padEnd(22)} Unlocked`);
    expect(result.output).toContain(`✅ ${"Starts at login".padEnd(22)} Installed as a service`);
  });

  test("without a running runner it checks from this terminal, exits with 1 when a required check fails, and names what to do", async () => {
    fakeLaunchd();
    fakeHealth({ ...BARE_TERMINAL, configDigest: () => null, service: async () => ({ installed: false, loaded: false, pid: null, binary: null }) });
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const result = await runner(["status", "--data-dir", dataDir]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Service    not installed");
    expect(result.output).toContain("Runner     not running");
    expect(result.output).toContain("Link port  not set");
    expect(result.output).toContain("The runner isn't running, so these checks were made from this terminal.");
    expect(result.output).toContain(`❌ ${"Setup".padEnd(22)} Nothing copied yet`);
    expect(result.output).toContain("Run `godmode runner install` on the runner so it starts when you log in.");
    // The one required check that fails is the setup: what this terminal isn't allowed is not the runner's failing.
    expect(result.lines.filter((line) => line.startsWith("❌")).length).toBe(1);
    expect(result.output).not.toContain("Accessibility");
  });

  test("a serving runner tells its checks only to who holds the access token", async () => {
    const dataDir = mkdtempSync(join(tmp, "data-"));
    loadConfig({ dataDir, role: "runner" });
    let looks = 0;
    fakeHealth({
      keepAwake: () => ({ supported: true, active: true, display: false }),
      vault: () => {
        looks++;
        return { initialized: true, unlocked: true };
      },
    });
    const ask = (authorization?: string) => answerHealth(new Request(`http://127.0.0.1${HEALTH_PATH}`, { headers: authorization ? { authorization } : {} }));
    for (const refused of [undefined, "Bearer wrong", getAccessToken(), `Basic ${getAccessToken()}`]) {
      const res = await ask(refused);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    // Nobody was told anything, and the machine wasn't even looked at.
    expect(looks).toBe(0);

    const res = await ask(`Bearer ${getAccessToken()}`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as RunnerHealth;
    expect(health).toEqual(await runnerHealth());
    expect(health.ok).toBe(true);
    // Its own look, with what only the serving process knows.
    expect(health.checks.find((c) => c.id === "keep-awake")).toMatchObject({ status: "ok", detail: "This Mac stays awake" });
    expect(health.checks.find((c) => c.id === "gui-session")).toMatchObject({ status: "ok", required: true });
    expect(looks).toBe(1);
  });

  test("falls back to the configured link port while no runner is running", async () => {
    fakeLaunchd();
    fakeHealth();
    const dataDir = mkdtempSync(join(tmp, "data-"));
    await runner(["install", "--no-service", "--data-dir", dataDir, "--port", "9300"]);
    closeDb();
    const result = await runner(["status", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Link port  9300");
  });
});

describe("godmode runner uninstall", () => {
  test("removes the service and leaves the data where it is", async () => {
    const dataDir = mkdtempSync(join(tmp, "data-"));
    const launchd = fakeLaunchd({ onStart: () => writeRunnerFile(dataDir, { startedAt: new Date(Date.now() + 1_000).toISOString() }) });
    await runner(["install", "--data-dir", dataDir]);
    expect(existsSync(plistPath())).toBe(true);
    launchd.calls.length = 0;

    const result = await runner(["uninstall", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(launchd.verbs()).toEqual(["print", "bootout", "print"]);
    expect(existsSync(plistPath())).toBe(false);
    expect(result.output).toContain("stopped and removed");
    expect(result.output).toContain(`stays in ${dataDir}`);
    expect(existsSync(join(dataDir, "godmode.db"))).toBe(true);

    const again = await runner(["uninstall", "--data-dir", dataDir]);
    expect(again.code).toBe(0);
    expect(again.output).toContain("no runner service to remove");
  });
});

describe("godmode runner", () => {
  test("serve hands its flags to the core and reports success once it listens", async () => {
    const served: Record<string, unknown>[] = [];
    const result = await runner(["serve", "--port", "0", "--data-dir", "/somewhere"], async (values) => {
      served.push(values);
    });
    expect(result.code).toBe(0);
    expect(served).toEqual([{ port: "0", "data-dir": "/somewhere" }]);
  });

  test("an unknown or missing command prints the usage and exits with 2", async () => {
    const unknown = await runner(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.output).toContain("Unknown command: runner frobnicate");
    for (const command of ["install", "pair", "serve", "status", "uninstall"]) expect(unknown.output).toContain(`godmode runner ${command}`);
    const missing = await runner([]);
    expect(missing.code).toBe(2);
    expect(missing.output).toContain("godmode runner install");
    // Names every object has are not commands.
    expect((await runner(["constructor"])).code).toBe(2);
  });

  test("a runner.json left behind by a crash doesn't count as a running runner", async () => {
    const dataDir = mkdtempSync(join(tmp, "data-"));
    expect(runningRunner(dataDir)).toBeNull();
    const gone = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    writeRunnerFile(dataDir, { pid: gone.pid });
    expect(runningRunner(dataDir)).toBeNull();
    writeRunnerFile(dataDir, { pid: process.pid });
    expect(runningRunner(dataDir)).toMatchObject({ pid: process.pid, apiPort: 50123, linkPort: 7788 });
  });

  test("a runner only counts as serving when it answers on the port it wrote down", async () => {
    const dataDir = mkdtempSync(join(tmp, "data-"));
    expect(await servingRunner(dataDir)).toBeNull();
    // After a crash and a restart of the computer, the pid in runner.json can be another program's.
    writeRunnerFile(dataDir, { pid: process.pid, apiPort: closedPort() });
    expect(runningRunner(dataDir)).not.toBeNull();
    expect(await servingRunner(dataDir)).toBeNull();
    // Nor does it count when something else has taken the port since.
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, name: "something-else" }) });
    listeners.push(stranger);
    writeRunnerFile(dataDir, { pid: process.pid, apiPort: stranger.port! });
    expect(await servingRunner(dataDir)).toBeNull();

    standInRunner(dataDir, () => new Response("Not found", { status: 404 }));
    expect(await servingRunner(dataDir)).toMatchObject({ pid: process.pid, linkPort: 7790 });
  });
});

/* ------------------------------------------------------------------ */
/* The real thing, as a child process                                   */
/* ------------------------------------------------------------------ */

function godmode(args: string[]) {
  const proc = Bun.spawnSync([process.execPath, INDEX, ...args], { env: childEnv({ GODMODE_LOG_LEVEL: "error" }) as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** A data dir whose runner starts the fake Claude Code instead of the real one. */
function runnerHome(): string {
  const dataDir = mkdtempSync(join(tmp, "serve-"));
  const claude = join(dataDir, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(claude, 0o755);
  loadConfig({ dataDir, role: "runner" });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
  updateSettings({ runner: { claudePath: claude } });
  closeDb();
  resetSettingsCache();
  return dataDir;
}

function spawnRunner(dataDir: string) {
  // Any free port for the link too: the default one (7788) belongs to a real runner on this machine, if there is one.
  return Bun.spawn([process.execPath, INDEX, "runner", "serve", "--data-dir", dataDir, "--port", "0", "--link-port", "0"], {
    // No installs on the machine that runs the tests.
    env: childEnv({ GODMODE_RUNNER_BOOTSTRAP: "0", GODMODE_LOG_LEVEL: "error", FAKE_CLAUDE_STATE: join(dataDir, "fake-claude") }) as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** `godmode runner serve` as a child that has printed its ready line and answers. Whoever starts it kills it. */
async function startRunner(dataDir: string) {
  const child = spawnRunner(dataDir);
  const stderr = new Response(child.stderr).text();
  try {
    // The ready line is what the desktop shell (and `runner install`) wait for.
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let ready: { url: string; port: number; version: string } | null = null;
    const deadline = Date.now() + 20_000;
    while (!ready) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      if (!chunk || chunk.done) throw new Error(`the runner did not get ready\nstdout: ${out.slice(-1000)}\nstderr: ${chunk ? (await stderr).slice(-2000) : "(still running)"}`);
      out += decoder.decode(chunk.value, { stream: true });
      const line = out.split("\n").find((l, i, all) => l.startsWith("GODMODE_READY ") && i < all.length - 1);
      if (line) ready = JSON.parse(line.slice("GODMODE_READY ".length));
    }
    // Keep the pipe empty so the child never blocks on a log line.
    void (async () => {
      while (!(await reader.read()).done);
    })().catch(() => {});
    // It answers only after everything that follows the ready line in the same breath, the signal handlers among it.
    await fetch(`${ready.url}/api/health`);
    return { child, ready };
  } catch (err) {
    child.kill("SIGKILL");
    await child.exited;
    throw err;
  }
}

/** The exit code, or null when the process is still there after `ms`. */
async function exitWithin(child: { exited: Promise<number> }, ms: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([child.exited, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  clearTimeout(timer);
  return code;
}

describe("the godmode binary", () => {
  test("version and help still work, and help lists the runner commands", () => {
    const version = godmode(["version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);

    const help = godmode(["help"]);
    expect(help.code).toBe(0);
    for (const line of ["godmode serve", "godmode token", "godmode password <new>", "godmode doctor", "godmode version"]) expect(help.stdout).toContain(line);
    for (const command of ["install", "pair", "serve", "status", "uninstall"]) expect(help.stdout).toContain(`godmode runner ${command}`);
    expect(godmode(["--help"]).stdout).toBe(help.stdout);

    const unknown = godmode(["runner", "frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("Unknown command: runner frobnicate");
  }, 30_000);

  test("`runner serve` listens on loopback, says so in runner.json and cleans up when it is stopped", async () => {
    const dataDir = runnerHome();
    // What a crash left behind, its pid another program's since: that must not keep the runner from starting.
    writeRunnerFile(dataDir, { pid: process.pid, apiPort: closedPort() });
    const { child, ready } = await startRunner(dataDir);
    try {
      expect(ready.version).toBe(VERSION);
      expect(ready.port).toBeGreaterThan(0);
      expect(ready.url).toBe(`http://127.0.0.1:${ready.port}`);

      const file = runnerFile(dataDir);
      expect(existsSync(file)).toBe(true);
      const info = JSON.parse(readFileSync(file, "utf8")) as RunnerProcess;
      expect(info.pid).toBe(child.pid);
      expect(info.apiPort).toBe(ready.port);
      expect(info.version).toBe(VERSION);
      // The link listener is up on the port it got, on every interface, and says what it is.
      expect(info.linkPort).toBeGreaterThan(0);
      expect(await (await fetch(`http://127.0.0.1:${info.linkPort}/`)).text()).toBe("godmode-runner\n");
      expect(Math.abs(Date.now() - Date.parse(info.startedAt))).toBeLessThan(60_000);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(runningRunner(dataDir)).toEqual(info);
      expect(await servingRunner(dataDir)).toEqual(info);

      const health = await fetch(`${ready.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, name: "godmode-bot" });
      // Everything else on the API still needs the token.
      expect((await fetch(`${ready.url}/api/agents`)).status).toBe(401);
      // So does what the runner finds about itself: it is the runner that answers `runner status` there, and only with the token.
      for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
        const refused = await fetch(`${ready.url}${HEALTH_PATH}`, { headers });
        expect(refused.status).toBe(401);
        expect(refused.headers.get("www-authenticate")).toBe("Bearer");
      }

      child.kill("SIGTERM");
      expect(await exitWithin(child, 8_000)).toBe(0);
      expect(existsSync(file)).toBe(false);
      expect(runningRunner(dataDir)).toBeNull();

      // A runner is the core without what only the human's own Godmode does: no schedules run here.
      const log = readFileSync(join(dataDir, "logs", "godmode.jsonl"), "utf8");
      expect(log).toContain(`Godmode core ${VERSION} listening on ${ready.url} (mode=server`);
      expect(log).toContain("received SIGTERM, shutting down");
      expect(log).not.toContain("scheduler started");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 30_000);

  test("a second runner on the same data dir is turned away before it touches the first one's work", async () => {
    const dataDir = runnerHome();
    const first = await startRunner(dataDir);
    try {
      const file = readFileSync(runnerFile(dataDir), "utf8");
      // A run the first runner is working on, the way the database shows it.
      openDb(join(dataDir, "godmode.db"));
      const agent = get<{ id: string }>("SELECT id FROM agents LIMIT 1")!;
      insert("runs", { id: "run_busy", agent_id: agent.id, conversation_id: "conv_busy", trigger: "chat", status: "running", prompt: "Work", created_at: new Date().toISOString() });
      closeDb();

      const second = spawnRunner(dataDir);
      try {
        const stderr = new Response(second.stderr).text();
        expect(await exitWithin(second, 15_000)).toBe(1);
        expect(await stderr).toContain(`A runner is already serving from ${dataDir} (pid ${first.child.pid}).`);
      } finally {
        second.kill("SIGKILL");
        await second.exited;
      }

      // The first one still serves, is still the one runner.json names, and its run was not taken for an interrupted one.
      expect(readFileSync(runnerFile(dataDir), "utf8")).toBe(file);
      expect((await fetch(`${first.ready.url}/api/health`)).status).toBe(200);
      openDb(join(dataDir, "godmode.db"));
      expect(get<{ status: string; error: string | null }>("SELECT status, error FROM runs WHERE id = ?", "run_busy")).toEqual({ status: "running", error: null });
    } finally {
      first.child.kill("SIGKILL");
      await first.child.exited;
    }
  }, 30_000);

  test("a runner that stops takes only its own runner.json with it", async () => {
    const dataDir = runnerHome();
    const { child } = await startRunner(dataDir);
    try {
      // Another runner has put its name there since.
      writeRunnerFile(dataDir, { pid: process.pid, apiPort: 50124 });
      child.kill("SIGTERM");
      expect(await exitWithin(child, 8_000)).toBe(0);
      expect(runningRunner(dataDir)).toMatchObject({ pid: process.pid, apiPort: 50124 });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 30_000);
});
