import { describe, expect, test } from "bun:test";
import { keychainService, parseCredentials, parseUsage } from "../src/services/claudeUsage";

describe("claudeUsage", () => {
  test("keychain service follows Claude Code's naming", () => {
    expect(keychainService(undefined)).toBe("Claude Code-credentials");
    expect(keychainService("/Users/niclas/.claude-work")).toBe("Claude Code-credentials-25d0cf09");
  });

  test("reads the OAuth sign-in and ignores API-key setups", () => {
    expect(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 5, subscriptionType: "max" } }))).toEqual({
      accessToken: "a",
      expiresAt: 5,
      subscriptionType: "max",
    });
    expect(parseCredentials("{}")).toBeNull();
    expect(parseCredentials("not json")).toBeNull();
  });

  test("maps the windows and drops the 5-hour window when the plan has none", () => {
    const usage = parseUsage({ five_hour: null, seven_day: { utilization: 26, resets_at: "2026-11-04T05:00:00.007109+00:00" } }, "max");
    expect(usage.state).toBe("ok");
    expect(usage.fiveHour).toBeNull();
    expect(usage.week).toEqual({ percent: 26, resetsAt: "2026-11-04T05:00:00.007Z" });
    expect(parseUsage({ seven_day: { utilization: 140 } }, null).week?.percent).toBe(100);
  });
});
