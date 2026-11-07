import { describe, expect, test } from "bun:test";
import "./test-natives.test";

const { blockedReasonText, cloudText, licenseStateText, licenseText, sellsSomething } = await import("./license-text");

const NEUTRAL = /^Godmode on your computer needs a license\.$/;
const state = (status: string, message: string | null) => ({ status, message }) as Parameters<typeof licenseStateText>[0];

describe("sellsSomething", () => {
  test("catches every way the core and the cloud word a purchase", () => {
    for (const text of [
      "Your free trial ended on Nov 7. Subscribe or add your licence key to keep your agents working.",
      "Godmode needs a licence to start new work. Subscribe or add your licence key.",
      "The payment for this licence isn't complete yet. Finish the checkout, then try the key again.",
      "This licence key isn't valid. Check it for typos, or subscribe to get one.",
      "Your trial has ended. Subscribe to keep your agents working.",
      "Your subscription has ended. Subscribe again to keep your agents working.",
      "Your last payment didn't go through, so new work is paused. Update your payment method to keep your agents working.",
      "Your Godmode licence has ended. Renew it or add another key to keep your agents working.",
      "Free until Nov 7. Then pick a plan to keep your agents working.",
      "The last payment didn't go through. Update your payment method to keep Godmode working.",
      "Your plan doesn't include opening computers in the browser. Choose a plan that does under Billing.",
      "Your plan includes 1 computer, and it is linked. Remove one or choose a bigger plan to link this computer.",
      "This account has used its 1 GB of relay traffic for this month. It resets on Dec 1; a bigger plan includes more.",
    ]) {
      expect(sellsSomething(text)).toBe(true);
    }
  });
  test("leaves plain status alone", () => {
    for (const text of [
      "Your key couldn't be checked yet. Godmode accepts it until Nov 9 and tries again every few hours.",
      "Godmode couldn't check your licence key for 7 days. Connect to the internet, then refresh the licence.",
      "This licence has ended. Everything keeps working until Nov 9.",
    ]) {
      expect(sellsSomething(text)).toBe(false);
    }
  });
});

describe("licence texts on a phone", () => {
  test("the refusal becomes the neutral line", () => {
    expect(licenseText("Automation “Report” couldn't start. Godmode needs a licence to start new work. Subscribe or add your licence key.")).toMatch(NEUTRAL);
    expect(licenseText("Agent Ada is disabled")).toBe("Agent Ada is disabled");
  });
  test("each state keeps a line that fits it, with no way to buy", () => {
    expect(licenseStateText(state("expired", "Your trial has ended. Subscribe to keep your agents working."))).toMatch(NEUTRAL);
    expect(licenseStateText(state("invalid", "This licence key isn't valid. Check it for typos, or subscribe to get one."))).toMatch(NEUTRAL);
    expect(licenseStateText(state("past_due", "The last payment didn't go through. Update your payment method to keep Godmode working."))).toBe("Check the license in Godmode on your computer.");
    expect(licenseStateText(state("grace", "Free until Nov 7. Then pick a plan to keep your agents working."))).toBeNull();
    expect(licenseStateText(state("unverified", "Your key couldn't be checked yet."))).toBe("Your key couldn't be checked yet.");
    expect(licenseStateText(state("active", null))).toBeNull();
  });
  test("a block reason changes only when Godmode wrote it", () => {
    const reason = "Godmode needs a licence to start new work. Subscribe or add your licence key.";
    expect(blockedReasonText({ blockedKind: "setup", blockedReason: reason })).toMatch(NEUTRAL);
    expect(blockedReasonText({ blockedKind: "needs_input", blockedReason: "The customer wants to subscribe" })).toBe("The customer wants to subscribe");
    expect(blockedReasonText({ blockedKind: "setup", blockedReason: null })).toBeNull();
  });
  test("the cloud's limits lose their advice", () => {
    expect(cloudText("Your plan includes 1 computer. Remove one or choose a bigger plan to link this computer.")).toBe("Godmode Cloud isn't available for this computer right now.");
    expect(cloudText("The computer did not answer. Try again.")).toBe("The computer did not answer. Try again.");
  });
});
