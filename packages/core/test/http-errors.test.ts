import { describe, expect, test } from "bun:test";
import { isUnanswered } from "../src/server/app";
import { HttpError } from "../src/util";

describe("http errors", () => {
  test("a runner or primary that didn't answer in time is no server fault", () => {
    expect(isUnanswered(new HttpError(504, "The runner didn't answer in time.", "runner_timeout"))).toBe(true);
    expect(isUnanswered(new HttpError(500, "Internal error", "internal"))).toBe(false);
    expect(isUnanswered(new HttpError(502, "Bad gateway"))).toBe(false);
  });

  test("an outside service that didn't answer is its connection, not a server fault", () => {
    expect(isUnanswered(new HttpError(502, "ElevenLabs did not answer in time", "calls_unreachable"))).toBe(true);
    expect(isUnanswered(new HttpError(502, "Godmode Cloud can't be reached right now.", "cloud_unreachable"))).toBe(true);
    expect(isUnanswered(new HttpError(502, "ElevenLabs returned an unexpected answer", "calls_upstream"))).toBe(false);
  });
});
