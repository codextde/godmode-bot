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
      "### Open decisions",
      "**What I need from you:**",
      "## Needs your decision",
      "Questions for Dana:",
      "## Entscheidung für dich",
      "**Offene Entscheidungen**",
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
    expect(detectOpenDecision("Fertig.\n\n**Offene Entscheidungen:** keine")).toBeNull();
    expect(
      detectOpenDecision(
        "| Ticket | Status |\n|---|---|\n| Demo shop | complete |\n\n**Waiting for you:** nothing new from this run. You will probably want to settle the pricing before the next calls, but nobody asked you directly, so I didn't create a task for it.\n\nI recorded all 10 tickets in `workspace/state.json`.",
      ),
    ).toBeNull();
    expect(detectOpenDecision("Shift done.\n\n4. **Needed from you:** none. I took back H-74, which was created from my \"nothing\" line.")).toBeNull();
    expect(detectOpenDecision("No replies.\n\n**Needed from Dana or Sam:** nothing new. Still open from Sam: two addresses and his answers on two leads.", "Dana")).toBeNull();
    expect(detectOpenDecision("Done.\n\n**Waiting for you:** nothing new from this run. The pricing is still open on the board.\n\nAnything else?")).toBeNull();
    expect(detectOpenDecision("Done.\n\n**Waiting for you:** Nothing for now. I'll check the inbox again tomorrow.\n\nWant me to also draft the emails?")).toBeNull();
  });

  test("a section that starts with none but still asks", () => {
    expect(detectOpenDecision("Checked the inbox.\n\n**Waiting for you:** None of the leads replied. Should I send the follow-ups now or on Monday?")?.title).toBe(
      "Should I send the follow-ups now or on Monday?",
    );
    expect(detectOpenDecision("**Decision for you:** None of the three quotes fits the budget. Pick A (cheaper) or B (faster) and I'll book it.")).not.toBeNull();
    expect(detectOpenDecision("**Decisions for you:** Nothing is booked yet. Choose hotel A or hotel B for the 12th.")).not.toBeNull();
    expect(detectOpenDecision("**Entscheidung für dich:** Keine Antwort von Sam bisher. Entscheide, ob wir nachfassen.")).not.toBeNull();
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
    // A date or an abbreviation doesn't end the sentence, and a choice is no offer.
    expect(detectOpenDecision("Soll ich den Termin am 12. Oktober bestätigen?")?.title).toBe("Soll ich den Termin am 12. Oktober bestätigen?");
    expect(detectOpenDecision("Soll ich ihn jetzt live schalten oder noch warten?")?.title).toBe("Soll ich ihn jetzt live schalten oder noch warten?");
    expect(detectOpenDecision("It is built. Want me to deploy it now or wait for Monday?")?.title).toBe("Want me to deploy it now or wait for Monday?");
  });

  test("offers, pleasantries and finished work are not decisions", () => {
    for (const answer of [
      "Deployed and verified. Everything is green.",
      "Fixed the bug.\n\nWant me to also add a test for it?",
      "Here is the summary.\n\nAnything else I can help with?",
      "Erledigt.\n\nSoll ich auch noch die Doku anpassen?",
      "Why did it fail? The token had expired.\n\nI renewed it and the job passes again.",
      "What does this mean for you? Nothing changes, the old links keep working.",
      "Was habe ich geändert? Nur die Überschrift.",
      "The PR is ready.\n\nWant me to open it?",
      "Would you like me to add tests for it?",
      "Soll ich dir die PDF hier anhängen?",
      "Here is the plan. What do you think?",
      "Draft for the customer:\n\nHi Sam, thanks for your order. Could you send us your order number?",
      "Post for tomorrow:\n\nWe shipped dark mode. Which feature should we build next?",
      "## Open questions\n\n- Is the market still growing?",
      "**Input required:** a JSON body with the order id.",
      "## Questions from the customer\n\nThey asked when it ships.",
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
