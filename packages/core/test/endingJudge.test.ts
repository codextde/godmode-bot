import { describe, expect, test } from "bun:test";
import { closesOutright, endingJudgePrompt, parseVerdict } from "../src/runner/endingJudge";

const report = `The test has spent EUR 80.26 of 150, with no new downloads since yesterday, and I paused nothing.

| Ad | Spend | Downloads |
|---|---|---|
| A3 | EUR 51.45 | 2 |

At EUR 100 the rule stops the whole campaign. That should come on the 11-08 check.

Nothing needed from you.`;

describe("a turn that closes outright", () => {
  test("a finished report that ends with nothing needed isn't judged at all", () => {
    expect(closesOutright(report)).toBe(true);
    expect(closesOutright("Alles geprüft.\n\nNichts zu tun für dich.")).toBe(true);
    expect(closesOutright("Checked all three stores.\n\nNo action needed.")).toBe(true);
    expect(closesOutright("Checked all three stores.\n\nNothing else is needed from you today.")).toBe(true);
  });

  test("announcing or offering more work still goes to the judge", () => {
    expect(closesOutright("Spend is EUR 80. Next I'll query the downloads per ad.\n\nNothing needed from you.")).toBe(false);
    expect(closesOutright("Spend is EUR 80. Want me to pause A2 too?\n\nNothing needed from you.")).toBe(false);
    expect(closesOutright("Done with 2 of 5 files.\n\nI'll now migrate the other three.\n\nNothing needed from you.")).toBe(false);
    expect(closesOutright("Let me run the full suite next.\n\nNothing required from you.")).toBe(false);
  });

  test("only a last paragraph that is nothing but the close counts", () => {
    expect(closesOutright("Fixed the parser.\n\nThe remaining CI failure has nothing to do with this change. I'll look into the flaky e2e test now.")).toBe(false);
    expect(closesOutright("Parser behoben.\n\nDer Fehler hat nichts mit meiner Änderung zu tun. Ich schaue mir jetzt die Tests an.")).toBe(false);
    expect(closesOutright("Nothing left to do on the parser. Remaining: update the UI and run the tests.")).toBe(false);
    expect(closesOutright("Nothing needed from you for the ads.\n\nThe store check is still running, I'll report once it's through.")).toBe(false);
    expect(closesOutright("Today's check is done and nothing is left to do; the next check runs tomorrow at 10:00.")).toBe(false);
  });
});

describe("the judge's prompt", () => {
  test("a recurring check that leaves the rest for its next run is finished", () => {
    const prompt = endingJudgePrompt("Daily check of the ads.", report);
    expect(prompt).toContain("next scheduled run");
    expect(prompt).toContain(report.split("\n")[0]!);
  });

  test("verdicts", () => {
    expect(parseVerdict("UNFINISHED")).toBe(true);
    expect(parseVerdict("finished.")).toBe(false);
    expect(parseVerdict("maybe")).toBeNull();
  });
});
