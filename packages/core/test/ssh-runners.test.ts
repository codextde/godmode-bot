import { describe, expect, test } from "bun:test";
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
