import { describe, expect, test } from "bun:test";
import { expandHome, launchScript, parseLaunchOutput } from "../src/remote/sshRunners";

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
    expect(script).toContain("GODMODE_VERSION='v1.2.3'");
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
});
