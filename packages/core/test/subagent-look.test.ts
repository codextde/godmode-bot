import { describe, expect, test } from "bun:test";
import { babyCharacter, normalizeCharacter, readableModelId, reportPreview, shortenPaths } from "@godmode/shared";

describe("babyCharacter", () => {
  test("keeps the parent's body and swaps its accessories for a sprout and blush", () => {
    const parent = normalizeCharacter({ body: "kitty", eyes: "sleepy", mouth: "grin", top: "crown", face: "shades", neck: "scarf" });
    expect(babyCharacter(parent)).toEqual({ body: "kitty", eyes: "wide", mouth: "grin", top: "sprout", face: "blush", neck: "none" });
  });

  test("a parent without a smile gets one", () => {
    expect(babyCharacter(normalizeCharacter({ mouth: "flat" })).mouth).toBe("smile");
    expect(babyCharacter(normalizeCharacter({ mouth: "none" })).mouth).toBe("smile");
  });
});

describe("shortenPaths", () => {
  test("keeps only the last part of home, absolute and relative paths", () => {
    expect(shortenPaths("Reading ~/.claude-work/projects/-Users-niclas-Documents-buchhaltung/memory/MEMORY.md")).toBe("Reading MEMORY.md");
    expect(shortenPaths("Listing /Users/niclas/Documents/buchhaltung/ust-va/")).toBe("Listing ust-va");
    expect(shortenPaths("Running python3 ./tools/build_elster_xml.py 2026-09")).toBe("Running python3 build_elster_xml.py 2026-09");
  });

  test("leaves URLs, single segments and plain text alone", () => {
    expect(shortenPaths("Reading https://github.com/codextde/godmode-bot/pull/299")).toBe("Reading https://github.com/codextde/godmode-bot/pull/299");
    expect(shortenPaths("Reading /tmp")).toBe("Reading /tmp");
    expect(shortenPaths("Running Extract key fields from September receipts")).toBe("Running Extract key fields from September receipts");
  });
});

describe("readableModelId", () => {
  test("names Claude model ids the way people say them and leaves the rest", () => {
    expect(readableModelId("claude-opus-5-5")).toBe("Opus 5.5");
    expect(readableModelId("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(readableModelId("glm-5.3")).toBe("glm-5.3");
    expect(readableModelId("Sonnet 5.5")).toBe("Sonnet 5.5");
  });
});

describe("reportPreview", () => {
  test("is the first line with words, without markdown marks but with snake_case intact", () => {
    expect(reportPreview("\n## **Vollständig.** Alle Belege da\n\n- more")).toBe("Vollständig. Alle Belege da");
    expect(reportPreview("- SPLIT_AB weicht von `build_ledger` ab")).toBe("SPLIT_AB weicht von build_ledger ab");
    expect(reportPreview("  \n ")).toBe("");
  });
});
