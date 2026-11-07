import { describe, expect, test } from "bun:test";
import { LARGE_PASTE_BYTES, largePaste } from "./large-paste";

const big = "x".repeat(LARGE_PASTE_BYTES);

describe("largePaste", () => {
  test("typing and small pastes stay in the field", () => {
    expect(largePaste("hello", "hello!")).toBeNull();
    expect(largePaste("", "y".repeat(LARGE_PASTE_BYTES - 1))).toBeNull();
    expect(largePaste("long text", "short")).toBeNull();
  });

  test("a paste at the desktop's size comes out with the text around it", () => {
    expect(largePaste("", big)).toEqual({ pasted: big, rest: "" });
    expect(largePaste("before  after", `before ${big} after`)).toEqual({ pasted: big, rest: "before  after" });
  });

  test("the size counts bytes, not characters", () => {
    const umlauts = "ü".repeat(LARGE_PASTE_BYTES / 2);
    expect(largePaste("", umlauts)?.pasted).toBe(umlauts);
  });

  test("a paste that would pass the message limit goes too", () => {
    const written = "w".repeat(199_000);
    const pasted = "z".repeat(1500);
    expect(largePaste(written, written + pasted)).toEqual({ pasted, rest: written });
  });

  test("one more letter at the limit is no paste", () => {
    const written = "w".repeat(200_000);
    expect(largePaste(written, `${written}a`)).toBeNull();
  });
});
