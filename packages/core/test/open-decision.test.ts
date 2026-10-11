import { describe, expect, test } from "bun:test";
import { detectOpenDecision } from "../src/runner/openDecision";

describe("a decision left open in an answer", () => {
  test("a section that says it is for the human", () => {
    const answer = [
      "The preview is live at https://shop.example.",
      "",
      "- **Mail:** nothing is sent.",
      "- **Domain:** not registered.",
      "",
      "## Decision for you",
      "",
      "Should the own store take real orders before a domain exists? If yes, it needs a payment account with a card and a way to send mail.",
      "",
      "## Files",
      "",
      "Everything is in `shop/README.md`.",
    ].join("\n");
    expect(detectOpenDecision(answer)).toEqual({
      title: "Should the own store take real orders before a domain exists?",
      body: "If yes, it needs a payment account with a card and a way to send mail.",
    });
  });

  test("headings in other words, by name and in German", () => {
    for (const heading of [
      "### Open questions",
      "**What I need from you:**",
      "## Needs your decision",
      "Questions for Dana:",
      "## Entscheidung für dich",
      "**Offene Fragen**",
      "### Was ich von dir brauche",
    ]) {
      const found = detectOpenDecision(`All done.\n\n${heading}\n\n- Which logo goes on the box, A or B?\n- The budget for it`, "Dana Miller");
      expect(found?.title).toBe("Which logo goes on the box, A or B?");
      expect(found?.body).toContain("The budget for it");
    }
  });

  test("a label with the question on the same line", () => {
    expect(detectOpenDecision("Report is ready.\n\n**Decision for you:** keep the old price or go to 49 EUR?\n\n**Files:** report.pdf")).toEqual({
      title: "keep the old price or go to 49 EUR?",
      body: "",
    });
  });

  test("a section that says there is nothing to decide", () => {
    expect(detectOpenDecision("Done.\n\n## Decisions for you\n\nNone.\n\n## Next\n\nShould I deploy it?")).toBeNull();
    expect(detectOpenDecision("Fertig.\n\n**Offene Fragen:** keine")).toBeNull();
  });

  test("a closing question to the human", () => {
    expect(detectOpenDecision("I drafted the newsletter.\n\nShould I send it to the whole list on Monday?")).toEqual({
      title: "Should I send it to the whole list on Monday?",
      body: "",
    });
    expect(detectOpenDecision("Die Seite ist fertig gebaut. Soll ich sie live schalten?")?.title).toBe("Soll ich sie live schalten?");
    expect(detectOpenDecision("Both variants are built.\n\nPlease confirm which one goes live and I'll ship it.")?.title).toBe("Please confirm which one goes live and I'll ship it.");
    const found = detectOpenDecision("Two ways to do this:\n\nA keeps the data, B is faster. Which one do you want?");
    expect(found).toEqual({ title: "Which one do you want?", body: "A keeps the data, B is faster. Which one do you want?" });
  });

  test("offers, pleasantries and finished work are not decisions", () => {
    for (const answer of [
      "Deployed and verified. Everything is green.",
      "Fixed the bug.\n\nWant me to also add a test for it?",
      "Here is the summary.\n\nAnything else I can help with?",
      "Erledigt.\n\nSoll ich auch noch die Doku anpassen?",
      "Why did it fail? The token had expired.\n\nI renewed it and the job passes again.",
      "Done.\n\n```\necho 'Should I run this?'\n```",
      "",
    ]) {
      expect(detectOpenDecision(answer)).toBeNull();
    }
  });

  test("long questions are cut, Markdown marks dropped", () => {
    const found = detectOpenDecision(`## Your call\n\n- **Should** I move \`main\` to the [new host](https://x.example) ${"and keep the old one running ".repeat(12)}?`);
    expect(found!.title.startsWith("Should I move main to the new host and keep")).toBe(true);
    expect(found!.title.length).toBeLessThanOrEqual(200);
  });
});
