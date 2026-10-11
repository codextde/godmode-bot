import { describe, expect, test } from "bun:test";
import { SecretSet } from "../src/vault/secretSet";

const MASK = "••••••••";

function setOf(...secrets: string[]): SecretSet {
  const set = new SecretSet();
  for (const s of secrets) set.add(s);
  return set;
}

/** What masking did before: one scan per secret. */
function onePerSecret(text: string, secrets: string[], mask: string): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (out.includes(secret)) out = out.split(secret).join(mask);
  return out;
}

describe("SecretSet", () => {
  test("masks every occurrence and leaves other text alone", () => {
    const set = setOf("hunter2-pw", "tok-Config-Value-9911");
    expect(set.replace("a hunter2-pw b tok-Config-Value-9911 c hunter2-pw", MASK)).toBe(`a ${MASK} b ${MASK} c ${MASK}`);
    expect(set.replace("hunter2-pwtok-Config-Value-9911", MASK)).toBe(`${MASK}${MASK}`);
    expect(set.replace("hunter2-p", MASK)).toBe("hunter2-p");
    expect(set.replace("", MASK)).toBe("");
  });

  test("returns the same string when nothing matches", () => {
    const text = "nothing secret in here, just a longer line of tool output";
    expect(setOf("hunter2-pw").replace(text, MASK)).toBe(text);
    expect(new SecretSet().replace(text, MASK)).toBe(text);
  });

  test("a secret inside or across another becomes one mask", () => {
    const set = setOf("Summer-2024", "Summer-2024-Berlin", "2024-Berlin-Mitte");
    expect(set.replace("a=Summer-2024-Berlin b=Summer-2024", "X")).toBe("a=X b=X");
    expect(set.replace("Summer-2024-Berlin-Mitte!", "X")).toBe("X!");
    expect(set.replace("x2024-Berlin-Mitte", "X")).toBe("xX");
  });

  test("secrets that share their start, short ones, and text outside ASCII", () => {
    const set = setOf("pass-one-111", "pass-one-111-long", "pass-two", "äöü-secret", "ab");
    expect(set.replace("pass-one-111-long pass-one-111 pass-two pass-three", "X")).toBe("X X X pass-three");
    expect(set.replace("grüße äöü-secret ab cab", "X")).toBe("grüße X X cX");
    expect(set.replace("ab", "X")).toBe("X");
  });

  test("clear forgets everything", () => {
    const set = setOf("hunter2-pw");
    set.clear();
    expect(set.size).toBe(0);
    expect(set.replace("hunter2-pw", MASK)).toBe("hunter2-pw");
    set.add("other-secret");
    expect(set.replace("hunter2-pw other-secret", MASK)).toBe(`hunter2-pw ${MASK}`);
  });

  test("agrees with masking one secret at a time on random text", () => {
    const alphabet = "abcdefgh-_.0123";
    const pick = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    for (let round = 0; round < 200; round++) {
      // Distinct starts and no overlaps between secrets: then both ways must give the same text.
      const secrets = Array.from({ length: 5 }, (_, i) => `${"QRSTU"[i]}${pick(5 + (round % 7))}`);
      const text = Array.from({ length: 40 }, () => (Math.random() < 0.3 ? secrets[Math.floor(Math.random() * 5)] : pick(3))).join(" ");
      expect(setOf(...secrets).replace(text, MASK)).toBe(onePerSecret(text, secrets, MASK));
    }
  });

  test("thousands of secrets over megabytes take one pass", () => {
    const secrets = Array.from({ length: 3000 }, (_, i) => `pw-${i}-${Math.random().toString(36).slice(2, 12)}`);
    const set = setOf(...secrets);
    const text = `${"lorem ipsum dolor sit amet ".repeat(400_000)}${secrets[1234]} end`;
    const started = performance.now();
    const out = set.replace(text, MASK);
    const ms = performance.now() - started;
    expect(out.endsWith(`${MASK} end`)).toBe(true);
    expect(out.length).toBe(text.length - secrets[1234]!.length + MASK.length);
    expect(ms).toBeLessThan(2000);
  });
});
