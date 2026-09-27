import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, TotpCode, TotpEntry, TotpImportResult, VaultStatus } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb } from "../src/db";
import { createApp } from "../src/server/app";
import { getAccessToken, hasDashboardPassword } from "../src/server/auth";
import { listAudit } from "../src/services/audit";
import { getSettings, resetSettingsCache } from "../src/services/settings";
import { generateTotp } from "../src/vault/totp";
import * as vault from "../src/vault/vault";

const SLOW = 60_000;
let dir: string;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "godmode-vault-routes-test-"));
  loadConfig({ dataDir: dir, token: "test-token" });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  vault.lock();
  token = getAccessToken();
  const ts = new Date().toISOString();
  insert("workspaces", { id: "ws_a", name: "A", slug: "a", created_at: ts, updated_at: ts });
  app = createApp();
});

afterAll(() => {
  vault.lock();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; data: T; text: string }> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data: data as T, text };
}

describe("vault routes", () => {
  test("require authentication", async () => {
    expect((await call("GET", "/api/vault/status", undefined, false)).status).toBe(401);
    expect((await call("GET", "/api/credentials", undefined, false)).status).toBe(401);
  });

  test("status before setup", async () => {
    const { status, data } = await call<VaultStatus>("GET", "/api/vault/status");
    expect(status).toBe(200);
    expect(data).toMatchObject({ initialized: false, unlocked: false });
  });

  test("setup validates and stores user name + dashboard password", async () => {
    expect((await call("POST", "/api/vault/setup", { passphrase: "short", rememberDevice: false })).status).toBe(400);
    expect((await call("POST", "/api/vault/setup", { passphrase: "long enough passphrase" })).status).toBe(400);
    expect((await call("POST", "/api/vault/setup", { passphrase: "long enough passphrase", rememberDevice: false, dashboardPassword: "short" })).status).toBe(400);

    const { status, data } = await call<VaultStatus>("POST", "/api/vault/setup", {
      passphrase: "long enough passphrase",
      rememberDevice: false,
      userName: "Dana",
      dashboardPassword: "dashboard-pass-1",
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({ initialized: true, unlocked: true, rememberDevice: false });
    expect(getSettings().general.userName).toBe("Dana");
    expect(getSettings().server.hasDashboardPassword).toBe(true);
    expect(hasDashboardPassword()).toBe(true);
    expect(listAudit(10, "vault.setup")).toHaveLength(1);

    expect((await call("POST", "/api/vault/setup", { passphrase: "another passphrase", rememberDevice: false })).status).toBe(400);
  }, SLOW);

  test("lock / unlock (wrong + right passphrase)", async () => {
    const locked = await call<VaultStatus>("POST", "/api/vault/lock", {});
    expect(locked.status).toBe(200);
    expect(locked.data.unlocked).toBe(false);

    const wrong = await call<{ error: string }>("POST", "/api/vault/unlock", { passphrase: "not the passphrase" });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toBe("Wrong passphrase");
    expect(listAudit(10, "vault.unlock_failed")).toHaveLength(1);

    expect((await call("POST", "/api/vault/unlock", {})).status).toBe(400);

    const right = await call<VaultStatus>("POST", "/api/vault/unlock", { passphrase: "long enough passphrase" });
    expect(right.status).toBe(200);
    expect(right.data.unlocked).toBe(true);
    expect(listAudit(50, "vault.unlock").some((e) => e.action === "vault.unlock")).toBe(true);
  }, SLOW);

  test("change passphrase", async () => {
    expect((await call("POST", "/api/vault/passphrase", { current: "wrong wrong wrong", next: "brand new passphrase" })).status).toBe(400);
    expect((await call("POST", "/api/vault/passphrase", { current: "long enough passphrase", next: "short" })).status).toBe(400);
    const ok = await call("POST", "/api/vault/passphrase", { current: "long enough passphrase", next: "brand new passphrase" });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ ok: true });
    await call("POST", "/api/vault/lock", {});
    expect((await call("POST", "/api/vault/unlock", { passphrase: "long enough passphrase" })).status).toBe(400);
    expect((await call("POST", "/api/vault/unlock", { passphrase: "brand new passphrase" })).status).toBe(200);
  }, SLOW);

  test("remember device (off)", async () => {
    const res = await call<VaultStatus>("POST", "/api/vault/remember", { remember: false });
    expect(res.status).toBe(200);
    expect(res.data.rememberDevice).toBe(false);
    expect((await call("POST", "/api/vault/remember", { remember: "yes" })).status).toBe(400);
  });
});

describe("app secret routes", () => {
  type SecretInfo = { key: string; set: boolean; updatedAt: string | null };

  test("list well-known keys, set, never return values, delete", async () => {
    const initial = await call<SecretInfo[]>("GET", "/api/vault/secrets");
    expect(initial.status).toBe(200);
    expect(initial.data.map((s) => s.key)).toEqual([
      "anthropic_api_key",
      "openai_api_key",
      "elevenlabs_api_key",
      "composio_api_key",
      "browser_use_api_key",
    ]);
    expect(initial.data.every((s) => !s.set && s.updatedAt === null)).toBe(true);

    expect((await call("PUT", "/api/vault/secrets/openai_api_key", { value: "  sk-live-abcdef123456 \n" })).data).toEqual({ ok: true });
    expect((await call("PUT", "/api/vault/secrets/zz_custom_token", { value: "custom-secret-value" })).status).toBe(200);
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-live-abcdef123456");

    const listed = await call<SecretInfo[]>("GET", "/api/vault/secrets");
    expect(listed.text).not.toContain("sk-live");
    expect(listed.text).not.toContain("custom-secret-value");
    expect(listed.data.find((s) => s.key === "openai_api_key")).toMatchObject({ set: true, updatedAt: expect.any(String) });
    expect(listed.data.at(-1)).toMatchObject({ key: "zz_custom_token", set: true });

    expect((await call("PUT", "/api/vault/secrets/Bad-Key", { value: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/vault/secrets/a", { value: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/vault/secrets/openai_api_key", {})).status).toBe(400);

    expect((await call("PUT", "/api/vault/secrets/zz_custom_token", { value: "   " })).status).toBe(200);
    expect(vault.hasAppSecret("zz_custom_token")).toBe(false);
    expect((await call("DELETE", "/api/vault/secrets/openai_api_key")).data).toEqual({ ok: true });
    expect(vault.hasAppSecret("openai_api_key")).toBe(false);
    expect(listAudit(50, "secret.").length).toBeGreaterThanOrEqual(4);
  });
});

describe("credential routes", () => {
  let id: string;

  test("create validates body", async () => {
    const res = await call<{ error: string; code: string }>("POST", "/api/credentials", { url: "https://x.com" });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe("bad_request");
    expect((await call("POST", "/api/credentials", { name: "X", tags: "nope" })).status).toBe(400);
  });

  test("create, get, list with scope + search", async () => {
    const created = await call<Credential>("POST", "/api/credentials", {
      name: "GitHub",
      url: "https://github.com/login",
      username: "octo",
      password: "gh-secret-pw",
      notes: "backup codes: 1234",
      tags: ["dev"],
    });
    expect(created.status).toBe(200);
    expect(created.data).toMatchObject({ name: "GitHub", domains: ["github.com"], hasPassword: true, workspaceId: null });
    expect(created.text).not.toContain("gh-secret-pw");
    id = created.data.id;

    const inWs = await call<Credential>("POST", "/api/credentials", { name: "Jira", url: "https://acme.atlassian.net", workspaceId: "ws_a" });
    expect(inWs.status).toBe(200);
    expect((await call("POST", "/api/credentials", { name: "Nope", workspaceId: "ws_missing" })).status).toBe(404);

    const got = await call<Credential>("GET", `/api/credentials/${id}`);
    expect(got.status).toBe(200);
    expect(got.text).not.toContain("gh-secret-pw");
    expect(got.text).not.toContain("backup codes");

    expect((await call<Credential[]>("GET", "/api/credentials")).data.map((c) => c.name)).toEqual(["GitHub", "Jira"]);
    expect((await call<Credential[]>("GET", "/api/credentials?workspaceId=all")).data).toHaveLength(2);
    expect((await call<Credential[]>("GET", "/api/credentials?workspaceId=global")).data.map((c) => c.name)).toEqual(["GitHub"]);
    expect((await call<Credential[]>("GET", "/api/credentials?workspaceId=ws_a")).data.map((c) => c.name)).toEqual(["Jira"]);
    expect((await call<Credential[]>("GET", "/api/credentials?search=octo")).data.map((c) => c.name)).toEqual(["GitHub"]);
    expect((await call("GET", "/api/credentials/cred_missing")).status).toBe(404);
  });

  test("reveal is audited", async () => {
    const res = await call<{ password: string | null; notes: string | null }>("POST", `/api/credentials/${id}/reveal`, {});
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ password: "gh-secret-pw", notes: "backup codes: 1234" });
    const entries = listAudit(10, "credential.reveal");
    expect(entries[0]).toMatchObject({ actor: "user", action: "credential.reveal", target: id });
    expect(JSON.stringify(entries)).not.toContain("gh-secret-pw");
  });

  test("patch keeps, changes and clears secrets", async () => {
    const renamed = await call<Credential>("PATCH", `/api/credentials/${id}`, { name: "GitHub (personal)" });
    expect(renamed.data).toMatchObject({ name: "GitHub (personal)", hasPassword: true });
    await call("PATCH", `/api/credentials/${id}`, { password: "new-pw" });
    expect((await call<{ password: string }>("POST", `/api/credentials/${id}/reveal`, {})).data.password).toBe("new-pw");
    const cleared = await call<Credential>("PATCH", `/api/credentials/${id}`, { password: null, notes: null });
    expect(cleared.data.hasPassword).toBe(false);
    expect((await call("POST", `/api/credentials/${id}/reveal`, {})).data).toEqual({ password: null, notes: null });
    expect((await call("PATCH", `/api/credentials/${id}`, { name: "" })).status).toBe(400);
    expect((await call("PATCH", "/api/credentials/cred_missing", { name: "x" })).status).toBe(404);
  });

  test("locked vault → 423 on reveal and secret writes", async () => {
    await call("POST", "/api/vault/lock", {});
    try {
      expect((await call("GET", "/api/credentials")).status).toBe(200);
      const reveal = await call<{ code: string }>("POST", `/api/credentials/${id}/reveal`, {});
      expect(reveal.status).toBe(423);
      expect(reveal.data.code).toBe("vault_locked");
      expect((await call("PATCH", `/api/credentials/${id}`, { password: "x" })).status).toBe(423);
      expect((await call("PUT", "/api/vault/secrets/openai_api_key", { value: "sk-x" })).status).toBe(423);
      expect((await call("GET", "/api/totp/codes")).status).toBe(423);
    } finally {
      expect((await call("POST", "/api/vault/unlock", { passphrase: "brand new passphrase" })).status).toBe(200);
    }
  }, SLOW);

  test("delete", async () => {
    expect((await call("DELETE", `/api/credentials/${id}`)).data).toEqual({ ok: true });
    expect((await call("GET", `/api/credentials/${id}`)).status).toBe(404);
    expect((await call("DELETE", `/api/credentials/${id}`)).status).toBe(404);
  });
});

describe("totp routes", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  let entry: TotpEntry;

  test("create, list, codes, patch, delete", async () => {
    expect((await call("POST", "/api/totp", { issuer: "X" })).status).toBe(400);
    expect((await call("POST", "/api/totp", { issuer: "X", secret: "bad!" })).status).toBe(400);
    expect((await call("POST", "/api/totp", { issuer: "X", secret: SECRET, digits: 9 })).status).toBe(400);
    expect((await call("POST", "/api/totp", { issuer: "X", secret: SECRET, algorithm: "MD5" })).status).toBe(400);

    const created = await call<TotpEntry>("POST", "/api/totp", { issuer: "Example", accountName: "me@example.com", secret: SECRET.toLowerCase() });
    expect(created.status).toBe(200);
    expect(created.text).not.toContain(SECRET);
    entry = created.data;
    expect(entry).toMatchObject({ issuer: "Example", accountName: "me@example.com", algorithm: "SHA1", digits: 6, period: 30 });

    expect((await call<TotpEntry[]>("GET", "/api/totp")).data.map((e) => e.id)).toEqual([entry.id]);
    expect((await call<TotpEntry[]>("GET", "/api/totp?workspaceId=ws_a")).data).toEqual([]);
    expect((await call<TotpEntry[]>("GET", "/api/totp?workspaceId=global&search=example")).data).toHaveLength(1);

    const t = Date.now() / 1000;
    const codes = await call<TotpCode[]>("GET", `/api/totp/codes?ids=${entry.id},totp_unknown`);
    expect(codes.status).toBe(200);
    expect(codes.data).toHaveLength(1);
    expect([generateTotp(SECRET, { time: t }), generateTotp(SECRET, { time: t + 2 })]).toContain(codes.data[0]!.code);
    expect((await call<TotpCode[]>("GET", "/api/totp/codes")).data).toHaveLength(1);

    const patched = await call<TotpEntry>("PATCH", `/api/totp/${entry.id}`, { issuer: "Example Inc", digits: 8 });
    expect(patched.data).toMatchObject({ issuer: "Example Inc", digits: 8, accountName: "me@example.com" });
    expect((await call("PATCH", `/api/totp/${entry.id}`, { period: 0 })).status).toBe(400);
    expect((await call("PATCH", "/api/totp/totp_missing", { issuer: "x" })).status).toBe(404);

    expect((await call("DELETE", `/api/totp/${entry.id}`)).data).toEqual({ ok: true });
    expect((await call("DELETE", `/api/totp/${entry.id}`)).status).toBe(404);
  });

  test("link to a credential via either side", async () => {
    const cred = (await call<Credential>("POST", "/api/credentials", { name: "Linked", url: "https://linked.example" })).data;
    const t = (await call<TotpEntry>("POST", "/api/totp", { issuer: "Linked", secret: SECRET, credentialId: cred.id })).data;
    expect(t.credentialId).toBe(cred.id);
    expect((await call<Credential>("GET", `/api/credentials/${cred.id}`)).data.totpId).toBe(t.id);
    expect((await call<Credential>("PATCH", `/api/credentials/${cred.id}`, { totpId: null })).data.totpId).toBeNull();
    expect((await call<TotpEntry[]>("GET", "/api/totp")).data.find((e) => e.id === t.id)!.credentialId).toBeNull();
    await call("DELETE", `/api/totp/${t.id}`);
    await call("DELETE", `/api/credentials/${cred.id}`);
  });

  test("import", async () => {
    expect((await call("POST", "/api/totp/import", { uris: [] })).status).toBe(400);
    const res = await call<TotpImportResult>("POST", "/api/totp/import", {
      workspaceId: "ws_a",
      uris: [
        "otpauth://totp/Acme:ann?secret=JBSWY3DPEHPK3PXP&issuer=Acme",
        "otpauth://totp/Acme:ann?secret=JBSWY3DPEHPK3PXP&issuer=Acme",
        "otpauth://hotp/Acme:ann?secret=JBSWY3DPEHPK3PXP&counter=0",
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.imported.map((e) => [e.issuer, e.accountName, e.workspaceId])).toEqual([["Acme", "ann", "ws_a"]]);
    expect(res.data.skipped.map((s) => s.reason)).toEqual(["already exists", "HOTP counters are not supported"]);
    expect(listAudit(10, "totp.import")[0]!.details).toMatchObject({ imported: 1, skipped: 2, workspaceId: "ws_a" });
  });
});
