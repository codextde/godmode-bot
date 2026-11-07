import { beforeEach, describe, expect, test } from "bun:test";
import type { ConversationWithMessages, MoveChatInput } from "@godmode/shared";
import { phone } from "./test-natives.test";

const { api, ApiError } = await import("./api");
const { chatExtrasApi } = await import("./chat-extras");
const { startChatMove, useChatMoves } = await import("./chat-moves");

const input: MoveChatInput = { to: "dev_target" };
const start = () => startChatMove({ conversationId: "cnv_1", input, dest: "Studio", agentName: "Godmode", working: false });
const chatOn = (runnerId: string | null) => ({ id: "cnv_1", runnerId, messages: [] }) as unknown as ConversationWithMessages;
const timedOut = async (): Promise<never> => {
  throw new ApiError(0, "No answer", "timeout");
};

async function settled() {
  while (useChatMoves.getState().moves.cnv_1) await Bun.sleep(1);
  await Bun.sleep(1);
}

const titles = () => phone.alerts.map((a) => a.title);
const MOVED = "Moved to Studio";
const FAILED = "Couldn't move the chat";

describe("moving a chat", () => {
  let asked = 0;
  const answers = (chat: () => Promise<ConversationWithMessages>) => {
    api.conversations.get = () => {
      asked++;
      return chat();
    };
  };

  beforeEach(() => {
    phone.reset();
    asked = 0;
    chatExtrasApi.move = async () => chatOn("dev_target");
    answers(async () => chatOn(null));
  });

  test("the screen stays on until the answer is there", async () => {
    start();
    await settled();
    expect(titles()).toEqual([MOVED]);
    expect(phone.awake).toEqual(["on chat-move-cnv_1", "off chat-move-cnv_1"]);
    expect(asked).toBe(0);
  });

  test("a lost answer with the chat already there counts as moved", async () => {
    chatExtrasApi.move = timedOut;
    answers(async () => chatOn("dev_target"));
    start();
    await settled();
    expect(titles()).toEqual([MOVED]);
  });

  test("a lost answer with the chat still here fails, and so does one that can't be checked", async () => {
    chatExtrasApi.move = timedOut;
    start();
    await settled();
    answers(() => Promise.reject(new Error("offline")));
    start();
    await settled();
    expect(titles()).toEqual([FAILED, FAILED]);
  });

  test("a refused move doesn't ask again", async () => {
    chatExtrasApi.move = () => Promise.reject(new ApiError(409, "Busy", "conflict"));
    start();
    await settled();
    expect(titles()).toEqual([FAILED]);
    expect(asked).toBe(0);
  });
});
