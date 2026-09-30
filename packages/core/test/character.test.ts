import { describe, expect, test } from "bun:test";
import {
  CHARACTER_BODIES,
  CHARACTER_EYES,
  CHARACTER_FACES,
  CHARACTER_MOUTHS,
  CHARACTER_NECKS,
  CHARACTER_TOPS,
  MASCOT_CHARACTER,
  characterGreeting,
  defaultCharacter,
  normalizeCharacter,
  parseCharacter,
  personalityPrompt,
  randomCharacter,
  renderCharacterSvg,
} from "@godmode/shared";

function isValid(c: Record<string, string>) {
  return (
    (CHARACTER_BODIES as readonly string[]).includes(c.body!) &&
    (CHARACTER_EYES as readonly string[]).includes(c.eyes!) &&
    (CHARACTER_MOUTHS as readonly string[]).includes(c.mouth!) &&
    (CHARACTER_TOPS as readonly string[]).includes(c.top!) &&
    (CHARACTER_FACES as readonly string[]).includes(c.face!) &&
    (CHARACTER_NECKS as readonly string[]).includes(c.neck!)
  );
}

describe("character look", () => {
  test("parseCharacter is deterministic per seed and falls back to the default look", () => {
    expect(parseCharacter(null, "agt_1")).toEqual(parseCharacter(null, "agt_1"));
    expect(parseCharacter(null, "agt_1")).toEqual(defaultCharacter("agt_1"));
    expect(parseCharacter("not json", "agt_1")).toEqual(defaultCharacter("agt_1"));
    expect(parseCharacter("", "agt_1")).toEqual(defaultCharacter("agt_1"));
    const looks = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(defaultCharacter(`agt_${i}`))));
    expect(looks.size).toBeGreaterThan(10);
    for (const look of looks) expect(isValid(JSON.parse(look))).toBe(true);

    const stored = { ...MASCOT_CHARACTER, body: "kitty" as const };
    expect(parseCharacter(JSON.stringify(stored), "agt_1")).toEqual(stored);
  });

  test("randomCharacter is seedable and always valid", () => {
    expect(randomCharacter("x")).toEqual(randomCharacter("x"));
    for (let i = 0; i < 50; i++) expect(isValid(randomCharacter() as unknown as Record<string, string>)).toBe(true);
  });

  test("normalizeCharacter keeps valid parts and replaces missing or unknown ones", () => {
    const base = defaultCharacter("seed");
    expect(normalizeCharacter({ body: "ghost", eyes: "laser", top: 7, extra: "x" }, base)).toEqual({ ...base, body: "ghost" });
    expect(normalizeCharacter(null, base)).toEqual(base);
    expect(normalizeCharacter("ghost", base)).toEqual(base);
    expect(normalizeCharacter({})).toEqual(MASCOT_CHARACTER);
  });
});

describe("renderCharacterSvg", () => {
  test("returns SVG markup with the mood and a safe title", () => {
    const svg = renderCharacterSvg(MASCOT_CHARACTER, { color: "emerald", mood: "thinking", uid: "a1", title: 'Bob <script>&"' });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('data-mood="thinking"');
    expect(svg).toContain("<title>Bob script</title>");
    expect(svg).toContain('aria-label="Bob script"');
    expect(svg).not.toContain("<script");
    expect(svg).toContain('id="a1-clip"');
  });

  test("defaults to an idle, decorative figure and renders every part", () => {
    expect(renderCharacterSvg(MASCOT_CHARACTER)).toContain('data-mood="idle"');
    expect(renderCharacterSvg(MASCOT_CHARACTER)).toContain('aria-hidden="true"');
    for (const body of CHARACTER_BODIES) {
      for (const top of CHARACTER_TOPS) {
        const svg = renderCharacterSvg({ ...MASCOT_CHARACTER, body, top, face: "glasses", neck: "scarf" }, { mood: "happy" });
        expect(svg).not.toContain("undefined");
        expect(svg).not.toContain("NaN");
      }
    }
  });
});

describe("personality", () => {
  test("personalityPrompt resolves presets, keeps custom text and treats blank as none", () => {
    expect(personalityPrompt("butler")).toContain("butler");
    expect(personalityPrompt("  Speak like a pirate.  ")).toBe("Speak like a pirate.");
    expect(personalityPrompt("")).toBe("");
    expect(personalityPrompt(null)).toBe("");
  });

  test("characterGreeting substitutes the name and the human's first name, or drops the name clause", () => {
    const line = characterGreeting({ name: "Pip", personality: "straight", human: "Ada Lovelace" });
    expect(line).toBe("Pip. What's the task?");
    expect(characterGreeting({ name: "Pip", personality: "buddy", human: "Ada Lovelace" })).toBe("Hey Ada! Pip here. What can I take off your plate?");
    expect(characterGreeting({ name: "Pip", personality: "buddy", human: "  " })).toBe("Hey! Pip here. What can I take off your plate?");
    expect(characterGreeting({ name: "Pip", personality: "custom text", human: null })).toBe("Hey! Pip here. What can I take off your plate?");
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const text = characterGreeting({ name: "Pip", personality: "buddy", seed });
      expect(text).not.toContain("{");
      expect(text).not.toMatch(/ [?!.,]|,[?!.]/);
    }
    const seeded = characterGreeting({ name: "Pip", personality: "calm", seed: "cnv_1" });
    expect(seeded).toBe(characterGreeting({ name: "Pip", personality: "calm", seed: "cnv_1" }));
    expect(seeded).not.toContain("{");
  });
});
