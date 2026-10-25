import { afterEach, describe, expect, test } from "bun:test";
import type { Credential, TotpEntry } from "@godmode/shared";
import { rankTotpGuesses, suggestTotpLinks, totpMatchScore } from "../src/vault/totpGuess";
import { resetTotpTrials, triedTotp, watchTotpGuess } from "../src/vault/totpTrial";

const cred = (id: string, name: string, url: string, username = "", extra: Partial<Credential> = {}): Credential =>
  ({ id, workspaceId: null, name, url, domains: [], username, hasPassword: true, totpId: null, tags: [], notes: null, lastUsedAt: null, createdAt: "", updatedAt: "", ...extra }) as Credential;
const totp = (id: string, issuer: string, accountName = "", extra: Partial<TotpEntry> = {}): TotpEntry =>
  ({ id, workspaceId: null, issuer, accountName, algorithm: "SHA1", digits: 6, period: 30, credentialId: null, icon: null, lastUsedAt: null, createdAt: "", updatedAt: "", ...extra }) as TotpEntry;

describe("totpMatchScore", () => {
  test("same brand and account scores highest", () => {
    const c = cred("c1", "GitHub", "https://github.com/login", "daniel@codext.de");
    expect(totpMatchScore(c, totp("t", "GitHub", "daniel@codext.de"))).toBe(1);
    expect(totpMatchScore(c, totp("t", "github.com", "daniel@codext.de"))).toBe(1);
  });

  test("fuzzy brand names, prefixes and aliases still match", () => {
    expect(totpMatchScore(cred("c", "Paypal Business", "https://www.paypal.com"), totp("t", "PayPal"))).toBeGreaterThan(0.8);
    expect(totpMatchScore(cred("c", "AWS Console", "https://console.aws.amazon.com"), totp("t", "Amazon Web Services"))).toBeGreaterThan(0.6);
    expect(totpMatchScore(cred("c", "Twitter", "https://x.com"), totp("t", "X"))).toBeGreaterThan(0.6);
    expect(totpMatchScore(cred("c", "Hetzner", "https://accounts.hetzner.com"), totp("t", "Hetzner Online"))).toBeGreaterThan(0.6);
    expect(totpMatchScore(cred("c", "Stripe", "https://dashboard.stripe.com"), totp("t", "", "Stripe:daniel@codext.de"))).toBeGreaterThan(0.6);
  });

  test("a short brand inside a longer one is only a weak guess", () => {
    const score = totpMatchScore(cred("c", "Metabase", "https://metabase.example.com", "dan@x.de"), totp("t", "Meta", "dan@x.de"));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.8);
    expect(totpMatchScore(cred("c", "Google Work", "https://accounts.google.com"), totp("t", "Workday"))).toBe(0);
  });

  test("a shared email alone is not a match", () => {
    expect(totpMatchScore(cred("c", "GitHub", "https://github.com", "daniel@codext.de"), totp("t", "Shopify", "daniel@codext.de"))).toBe(0);
    expect(totpMatchScore(cred("c", "Google", "https://accounts.google.com"), totp("t", "GitLab"))).toBe(0);
  });

  test("the right account beats another account of the same site", () => {
    const c = cred("c", "Google", "https://accounts.google.com", "daniel@solakon.de");
    expect(totpMatchScore(c, totp("a", "Google", "daniel@solakon.de"))).toBeGreaterThan(totpMatchScore(c, totp("b", "Google", "other@gmail.com")));
  });
});

describe("rankTotpGuesses", () => {
  test("skips linked, tried and out-of-scope entries", () => {
    const c = cred("c", "GitHub", "https://github.com", "dan", { workspaceId: "ws1" });
    const entries = [
      totp("linked", "GitHub", "dan", { credentialId: "other" }),
      totp("tried", "GitHub", "dan"),
      totp("ws2", "GitHub", "dan", { workspaceId: "ws2" }),
      totp("ok", "GitHub", ""),
      totp("nope", "Slack", "dan"),
    ];
    expect(rankTotpGuesses(c, entries, new Set(["tried"])).map((g) => g.entry.id)).toEqual(["ok"]);
  });
});

describe("suggestTotpLinks", () => {
  test("pairs one to one and marks clear winners as sure", () => {
    const creds = [
      cred("gh", "GitHub", "https://github.com", "dan"),
      cred("g1", "Google", "https://accounts.google.com", "a@x.de"),
      cred("g2", "Google Work", "https://accounts.google.com", "b@x.de"),
      cred("done", "Slack", "https://slack.com", "dan", { totpId: "slack" }),
    ];
    const entries = [totp("tgh", "GitHub", "dan"), totp("tg1", "Google", "a@x.de"), totp("tg2", "Google", "b@x.de"), totp("slack", "Slack", "dan", { credentialId: "done" })];
    const out = suggestTotpLinks(creds, entries);
    const by = new Map(out.map((s) => [s.credentialId, s]));
    expect(by.get("gh")).toMatchObject({ totpId: "tgh", sure: true });
    expect(by.get("g1")?.totpId).toBe("tg1");
    expect(by.get("g2")?.totpId).toBe("tg2");
    expect(by.has("done")).toBe(false);
    expect(new Set(out.map((s) => s.totpId)).size).toBe(out.length);
  });

  test("two equally good codes for one login are not sure", () => {
    const out = suggestTotpLinks([cred("gh", "GitHub", "https://github.com")], [totp("a", "GitHub"), totp("b", "GitHub")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sure).toBe(false);
  });
});

describe("watchTotpGuess", () => {
  afterEach(resetTotpTrials);
  const page = (otpField: boolean, error = false, url = "https://github.com/") => ({ url, otpField, error });
  const run = (pages: ReturnType<typeof page>[], onSite = (u: string) => u.startsWith("https://github.com")) => {
    let i = 0;
    let accepted = 0;
    const outcome = watchTotpGuess("chat", "cred", "t1", {
      probe: async () => pages[Math.min(i++, pages.length - 1)]!,
      onSite,
      onAccepted: () => accepted++,
      intervalMs: 5,
      timeoutMs: 400,
    });
    return { outcome, accepted: () => accepted };
  };

  test("accepted once the code field is gone twice in a row", async () => {
    const r = run([page(true), page(false), page(false)]);
    expect(await r.outcome).toBe("accepted");
    expect(r.accepted()).toBe(1);
    expect(triedTotp("chat", "cred").has("t1")).toBe(false);
  });

  test("rejected when the page shows an error next to the field", async () => {
    const r = run([page(true), page(true, true)]);
    expect(await r.outcome).toBe("rejected");
    expect(r.accepted()).toBe(0);
    expect(triedTotp("chat", "cred").has("t1")).toBe(true);
  });

  test("leaving the login's site is not a success", async () => {
    const r = run([page(false, false, "https://evil.example/")]);
    expect(await r.outcome).toBe("rejected");
    expect(r.accepted()).toBe(0);
  });

  test("a new guess supersedes the previous watch", async () => {
    const first = run([page(true)]);
    const second = watchTotpGuess("chat", "cred", "t2", { probe: async () => page(true, true), onSite: () => true, onAccepted: () => {}, intervalMs: 5, timeoutMs: 200 });
    expect(await first.outcome).toBe("superseded");
    expect(await second).toBe("rejected");
    expect([...triedTotp("chat", "cred")].sort()).toEqual(["t1", "t2"]);
  });

  test("times out while the field stays without an error", async () => {
    const r = run([page(true)]);
    expect(await r.outcome).toBe("timeout");
  });
});
