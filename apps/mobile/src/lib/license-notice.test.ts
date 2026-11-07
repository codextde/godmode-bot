import { describe, expect, mock, test } from "bun:test";

mock.module("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined }));
const { licenseNotice } = await import("./license-notice");

const NOW = new Date("2026-11-07T12:00:00Z");
const base = {
  status: "active",
  plan: null,
  keyHint: null,
  trialEndsAt: null,
  renewsAt: null,
  cancelAtPeriodEnd: false,
  endReason: null,
  graceEndsAt: null,
  unverifiedUntil: null,
  checkedAt: null,
  manageUrl: null,
  message: null,
  enforced: true,
  blocked: false,
  reminderEmail: null,
} as const;
const state = (over: object) => ({ ...base, ...over }) as Parameters<typeof licenseNotice>[0];
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe("licenseNotice", () => {
  test("a working licence says nothing", () => {
    expect(licenseNotice(state({}), NOW)).toBeNull();
  });
  test("a refused licence comes before everything else", () => {
    expect(licenseNotice(state({ status: "past_due", blocked: true }), NOW)).toBe("blocked");
  });
  test("a paid trial that stops shows in its last three days only", () => {
    expect(licenseNotice(state({ status: "trial", cancelAtPeriodEnd: true, trialEndsAt: inDays(2) }), NOW)).toBe("trial");
    expect(licenseNotice(state({ status: "trial", cancelAtPeriodEnd: true, trialEndsAt: inDays(4) }), NOW)).toBeNull();
    expect(licenseNotice(state({ status: "trial", cancelAtPeriodEnd: true, trialEndsAt: inDays(-1) }), NOW)).toBeNull();
  });
  test("a trial that goes on by itself says nothing", () => {
    expect(licenseNotice(state({ status: "trial", trialEndsAt: inDays(2) }), NOW)).toBeNull();
  });
  test("a failed payment shows, also on a build that doesn't enforce", () => {
    expect(licenseNotice(state({ status: "past_due", enforced: false }), NOW)).toBe("past_due");
  });
  test("the free trial and an unverified key only where licences are enforced", () => {
    expect(licenseNotice(state({ status: "grace", graceEndsAt: inDays(3) }), NOW)).toBe("grace");
    expect(licenseNotice(state({ status: "grace", graceEndsAt: inDays(5) }), NOW)).toBeNull();
    expect(licenseNotice(state({ status: "grace", graceEndsAt: inDays(1), enforced: false }), NOW)).toBeNull();
    expect(licenseNotice(state({ status: "unverified", unverifiedUntil: inDays(9) }), NOW)).toBe("unverified");
  });
});
