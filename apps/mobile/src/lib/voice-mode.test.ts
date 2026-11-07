import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { VoiceSettings } from "@godmode/shared";
import { phone } from "./test-natives.test";

const { useSession } = await import("./session");
const { speak } = await import("./voice-mode");

const onPhone = { ttsProvider: "browser" } as VoiceSettings;
const onComputer = { ttsProvider: "openai" } as VoiceSettings;
const realFetch = globalThis.fetch;
let signals: (AbortSignal | null | undefined)[] = [];

async function playing() {
  while (!phone.played) await Bun.sleep(1);
}

describe("speaking", () => {
  beforeEach(() => {
    phone.reset();
    signals = [];
    useSession.setState({ connection: { token: "key", urls: ["http://computer:1"], activeUrl: "http://computer:1", instance: { id: "gm_1" }, activeInstanceId: "gm_1", peers: [] } as never });
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      return new Response(new ArrayBuffer(4));
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("follows the ring switch unless a conversation asked otherwise", async () => {
    await speak("hello", onPhone).done;
    await speak("hello", onPhone, true).done;
    expect(phone.silentMode).toEqual([false, true]);
  });

  test("the computer's voice gets a deadline", async () => {
    const said = speak("hello", onComputer);
    await playing();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    phone.onStatus({ didJustFinish: true });
    await said.done;
    expect(phone.silentMode).toEqual([false]);
    expect(phone.spoken).toEqual([]);
  });

  test("audio that can't play gives way to the phone's voice instead of hanging", async () => {
    const said = speak("hello", onComputer, true);
    await playing();
    phone.onStatus({ didJustFinish: false, error: "Cannot decode" });
    await said.done;
    expect(phone.spoken).toEqual(["hello"]);
    expect(phone.silentMode).toEqual([true, true]);
  });

  test("a computer that refuses the voice (a limited phone) gives way too", async () => {
    globalThis.fetch = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await speak("hello", onComputer).done;
    expect(phone.spoken).toEqual(["hello"]);
  });
});
