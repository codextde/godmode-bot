import { describe, expect, test } from "bun:test";
import { phone } from "./test-natives.test";

const { useChatPrefs } = await import("./chat-prefs");

describe("chat preferences", () => {
  test("replies aren't read out unless this phone asked for it", async () => {
    expect(useChatPrefs.getState().readReplies).toBe(false);
    useChatPrefs.getState().setReadReplies(true);
    await Bun.sleep(1);
    expect(JSON.parse(phone.stored["godmode.chatPrefs"]!).readReplies).toBe(true);
    useChatPrefs.getState().setReadReplies(false);
  });
});
