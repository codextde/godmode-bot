import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, launchScript, parseLaunchOutput } from "../src/remote/sshRunners";
import { forwardedClaudeLogin, setForwardedClaudeLogin } from "../src/remote/claudeLogin";

describe("runners on SSH servers", () => {
  test("the launch script reports the home folder and the link port it serves on", () => {
    expect(parseLaunchOutput("Installing…\nhome:/home/dev\nport:41234\n")).toEqual({ home: "/home/dev", port: 41234 });
    expect(parseLaunchOutput("home:/home/dev\n")).toBeNull();
    expect(parseLaunchOutput("home:/home/dev\nport:0\n")).toBeNull();
    expect(parseLaunchOutput("home:relative\nport:4000\n")).toBeNull();
  });

  test("the runner listens on loopback only, starts lean and installs the same version", () => {
    const script = launchScript("1.2.3");
    expect(script).toContain("--link-host 127.0.0.1");
    expect(script).toContain("GODMODE_RUNNER_LEAN=1");
    expect(script).toContain("WANT='1.2.3'");
    expect(script).toContain("TAG='v1.2.3'");
    expect(launchScript("0.2.41-54")).toContain("TAG='v0.2.41-canary.54'");
  });

  test("the launch script is valid POSIX shell", async () => {
    const proc = Bun.spawn(["sh", "-n"], { stdin: new TextEncoder().encode(launchScript("1.2.3")), stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });

  test("a canary without a build for the server falls back to the latest stable release once", async () => {
    const home = mkdtempSync(join(tmpdir(), "gm-ssh-launch-"));
    const bin = join(home, "fakebin");
    const log = join(home, "installs.log");
    const fake = `#!/bin/sh
case "$1" in
  version) echo 0.2.42 ;;
  runner) mkdir -p "$HOME/.godmode-runner"; printf '{"pid": %s, "linkPort": 41234, "version": "0.2.42"}' $$ > "$HOME/.godmode-runner/runner.json"; exec sleep 30 ;;
esac
`;
    const installer = `echo "$GODMODE_VERSION" >> ${log}
[ "$GODMODE_VERSION" = latest ] || exit 1
mkdir -p "$GODMODE_INSTALL_DIR"
cat > "$GODMODE_INSTALL_DIR/godmode" <<'BIN'
${fake}BIN
chmod 755 "$GODMODE_INSTALL_DIR/godmode"
`;
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\ncat <<'SH'\n${installer}SH\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const run = () => {
      const proc = Bun.spawnSync(["sh", "-s"], { stdin: new TextEncoder().encode(launchScript("0.2.45-121")), env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stderr: "pipe" });
      return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
    };
    try {
      const first = run();
      expect(first.code).toBe(0);
      expect(parseLaunchOutput(first.out)).toEqual({ home, port: 41234 });
      expect(first.err).toContain("installing the latest stable release instead");
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["v0.2.45-canary.121", "latest"]);
      expect(readFileSync(join(home, ".godmode-runner", "stable-fallback"), "utf8").trim()).toBe("0.2.45-121");
      expect(run().code).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      const pid = existsSync(join(home, ".godmode-runner", "runner.json")) ? /"pid": (\d+)/.exec(readFileSync(join(home, ".godmode-runner", "runner.json"), "utf8"))?.[1] : null;
      if (pid) process.kill(Number(pid));
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a stable version without a build for the server fails without a fallback", () => {
    const script = launchScript("1.2.3");
    expect(script).toContain("*-canary.*)");
    expect(script).toContain('install_godmode "$TAG"');
  });

  test("~ in a remote folder is the server's home folder", () => {
    expect(expandHome("~", "/home/dev")).toBe("/home/dev");
    expect(expandHome("~/code/app", "/home/dev/")).toBe("/home/dev/code/app");
    expect(expandHome("/srv/app", "/home/dev")).toBe("/srv/app");
  });

  test("a forwarded Claude login is used until shortly before it expires", () => {
    const now = 1_000_000_000;
    setForwardedClaudeLogin({ token: "t", expiresAt: now + 10 * 60_000, label: "x" });
    expect(forwardedClaudeLogin(now)?.token).toBe("t");
    expect(forwardedClaudeLogin(now + 9 * 60_000)).toBeNull();
    setForwardedClaudeLogin({ token: "long", expiresAt: null, label: "x" });
    expect(forwardedClaudeLogin(now)?.token).toBe("long");
    setForwardedClaudeLogin(null);
    expect(forwardedClaudeLogin(now)).toBeNull();
  });
});
