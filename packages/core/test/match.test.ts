import { describe, expect, test } from "bun:test";
import { nameGuessMatchesHost, siteLabel } from "../src/vault/match";

describe("siteLabel", () => {
  test("takes the label left of the public suffix", () => {
    expect(siteLabel("bitpanda.com")).toBe("bitpanda");
    expect(siteLabel("https://account.bitpanda.com/login")).toBe("bitpanda");
    expect(siteLabel("bitpanda.co.uk")).toBe("bitpanda");
    expect(siteLabel("www.bitpanda.io")).toBe("bitpanda");
    // A subdomain of an attacker's domain keeps the attacker's brand, not the impersonated one.
    expect(siteLabel("bitpanda.attacker.com")).toBe("attacker");
    expect(siteLabel("localhost")).toBe("localhost");
    expect(siteLabel("")).toBe("");
  });
});

describe("nameGuessMatchesHost", () => {
  const cred = (name: string, url = "", domains: string[] = []) => ({ name, url, domains });

  test("loose: surfaces a login whose name is the site's brand", () => {
    expect(nameGuessMatchesHost(cred("Bitpanda"), "bitpanda.com")).toBe(true);
    expect(nameGuessMatchesHost(cred("Bitpanda Broker"), "bitpanda.io")).toBe(true);
    expect(nameGuessMatchesHost(cred("Coinbase"), "bitpanda.com")).toBe(false);
    // Too short a brand label never guesses.
    expect(nameGuessMatchesHost(cred("Ab"), "ab.com")).toBe(false);
  });

  test("strict: exact brand equality only — no lookalikes", () => {
    expect(nameGuessMatchesHost(cred("Bitpanda", "https://bitpanda.com"), "bitpanda.io", { strict: true })).toBe(true);
    // A different TLD of a domain the login already lists counts as an exact brand match.
    expect(nameGuessMatchesHost(cred("My Exchange", "", ["bitpanda.com"]), "bitpanda.io", { strict: true })).toBe(true);
    // A lookalike host that merely contains the brand is refused.
    expect(nameGuessMatchesHost(cred("Bitpanda"), "bitpanda-login.com", { strict: true })).toBe(false);
    // The brand hidden under an attacker's domain is refused.
    expect(nameGuessMatchesHost(cred("Bitpanda"), "bitpanda.attacker.com", { strict: true })).toBe(false);
  });
});
