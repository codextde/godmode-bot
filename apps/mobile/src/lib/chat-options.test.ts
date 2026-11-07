import { describe, expect, test } from "bun:test";
import { chatOptionsBody, type NewChatOptions } from "./chat-options";

const none: NewChatOptions = { private: false, browserProfileId: null, instructions: "", workingDirectory: null, vmId: null, sshServerIds: [], androidDeviceIds: [], computerTarget: null };

describe("a new chat's options", () => {
  test("what's shared with it goes along", () => {
    expect(chatOptionsBody(none)).toEqual({});
    expect(chatOptionsBody({ ...none, computerTarget: { kind: "desktop" } })).toEqual({ computerTarget: { kind: "desktop" } });
  });

  test("on another computer it starts without this computer's screen", () => {
    expect(chatOptionsBody({ ...none, computerTarget: { kind: "desktop" }, runnerId: "rnr_1" })).toEqual({ runnerId: "rnr_1" });
  });
});
