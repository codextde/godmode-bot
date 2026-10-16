import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { linkTotpToMissingLogin, reportMissingLogin, totpChoicesForMissingLogin } from "../src/services/missingLogins";
import { HttpError } from "../src/util";
import { createCredential, getCredential } from "../src/vault/credentials";
import { createTotp, getTotp } from "../src/vault/totp";
import * as vault from "../src/vault/vault";

let dataDir: string;

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-missing-totp-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  await vault.setup("missing totp test passphrase", false);
});

afterAll(() => {
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

const SECRET = "JBSWY3DPEHPK3PXP";
const report = (url: string, service = "Zendesk") =>
  reportMissingLogin({ agentId: "agt_a", runId: "run_1", workspaceId: null, kind: "missing_totp", service, url, reason: "2FA asked" });

function httpError(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

describe("linking a saved 2FA code to a missing-2FA report", () => {
  test("same account on another login: the code stays there and that login gets the site", () => {
    const zendesk = createCredential({ name: "Zendesk", url: "https://acme.zendesk.com/auth/v2/login/signin", username: "dan@acme.de", password: "x" });
    const support = createCredential({ name: "Acme", url: "https://support.acme.de/auth/v3/signin", username: "dan@acme.de", password: "x" });
    const totp = createTotp({ issuer: "acme - Zendesk", accountName: "dan@acme.de", secret: SECRET, credentialId: zendesk.id });
    createTotp({ issuer: "GitHub", accountName: "someone", secret: SECRET });

    const item = report("https://support.acme.de/auth/v3/signin");
    const choices = totpChoicesForMissingLogin(item.id);
    expect(choices.host).toBe("support.acme.de");
    expect(choices.logins.map((l) => l.id)).toEqual([support.id]);
    expect(choices.suggestedTotpIds[0]).toBe(totp.id);

    const res = linkTotpToMissingLogin(item.id, { totpId: totp.id });
    expect(res.outcome).toBe("domain_added");
    expect(res.credentialId).toBe(zendesk.id);
    expect(res.item).toMatchObject({ status: "resolved", credentialId: zendesk.id });
    expect(getTotp(totp.id).credentialId).toBe(zendesk.id);
    expect(getCredential(zendesk.id).domains).toContain("support.acme.de");
    expect(getCredential(support.id).totpId).toBeNull();
  });

  test("a free code is linked to the site's login with the same account", () => {
    const login = createCredential({ name: "Shop", url: "https://shop.example.com/login", username: "ops@example.com", password: "x" });
    createCredential({ name: "Shop", url: "https://shop.example.com/login", username: "other@example.com", password: "x" });
    const totp = createTotp({ issuer: "Shop", accountName: "ops@example.com", secret: SECRET });
    const item = report("https://shop.example.com/login", "Shop");

    const res = linkTotpToMissingLogin(item.id, { totpId: totp.id });
    expect(res).toMatchObject({ outcome: "linked", credentialId: login.id });
    expect(getCredential(login.id).totpId).toBe(totp.id);
  });

  test("a code linked to another account's login moves to the chosen login", () => {
    const old = createCredential({ name: "Old", url: "https://old.example.org", username: "a@example.org", password: "x" });
    const site = createCredential({ name: "Portal", url: "https://portal.example.net", username: "b@example.net", password: "x" });
    const totp = createTotp({ issuer: "Portal", accountName: "b@example.net", secret: SECRET, credentialId: old.id });
    const item = report("https://portal.example.net", "Portal");

    const res = linkTotpToMissingLogin(item.id, { totpId: totp.id, credentialId: site.id });
    expect(res.outcome).toBe("moved");
    expect(getCredential(site.id).totpId).toBe(totp.id);
    expect(getCredential(old.id).totpId).toBeNull();
  });

  test("refuses a login of another site and a site without a login", () => {
    const other = createCredential({ name: "Elsewhere", url: "https://elsewhere.io", username: "x", password: "x" });
    createCredential({ name: "Two", url: "https://two.example.dev", username: "one@x.dev", password: "x" });
    const totp = createTotp({ issuer: "Two", accountName: "two@x.dev", secret: SECRET });

    const item = report("https://two.example.dev", "Two");
    expect(httpError(() => linkTotpToMissingLogin(item.id, { totpId: totp.id, credentialId: other.id })).status).toBe(400);

    const none = report("https://nologin.example.dev", "Nologin");
    expect(httpError(() => linkTotpToMissingLogin(none.id, { totpId: totp.id })).message).toContain("No login is saved");
  });
});
