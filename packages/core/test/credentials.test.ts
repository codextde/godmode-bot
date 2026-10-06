import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentPermissions } from "@godmode/shared";
import { bus } from "../src/events/bus";
import { loadConfig } from "../src/config";
import { closeDb, get, insert, openDb, run } from "../src/db";
import { resetSettingsCache } from "../src/services/settings";
import { HttpError } from "../src/util";
import {
  addCredentialDomain,
  createCredential,
  credentialsForAgent,
  deleteCredential,
  findCredentialsForAgent,
  getCredential,
  listCredentials,
  markCredentialUsed,
  revealForAgent,
  updateCredential,
} from "../src/vault/credentials";
import { createTotp, getTotp } from "../src/vault/totp";
import * as vault from "../src/vault/vault";

const PASSPHRASE = "credentials test passphrase";
let dir: string;
const ts = new Date().toISOString();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "godmode-cred-test-"));
  loadConfig({ dataDir: dir, token: "test-token" });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  vault.lock();
  await vault.setup(PASSPHRASE, false);
  insert("workspaces", { id: "ws_a", name: "A", slug: "a", created_at: ts, updated_at: ts });
  insert("workspaces", { id: "ws_b", name: "B", slug: "b", created_at: ts, updated_at: ts });
}, 60_000);

afterAll(() => {
  vault.lock();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function httpStatus(fn: () => unknown): number | null {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return null;
}

function makeAgent(workspaceId: string | null, permissions: Partial<AgentPermissions> = {}): Agent {
  return {
    id: "agt_test",
    workspaceId,
    name: "Test agent",
    slug: "test-agent",
    avatar: "🤖",
    color: "violet",
    character: { body: "blob", eyes: "dots", mouth: "smile", top: "none", face: "none", neck: "none" },
    personality: "",
    description: "",
    instructions: "",
    role: "",
    reportsTo: null,
    failedRunId: null,
    model: "",
    effort: null,
    ultracode: null,
    isDefault: false,
    enabled: true,
    status: "idle",
    permissions: {
      canManageAgents: false,
      allowDelegation: false,
      delegateTo: [],
      secretAccess: "fill",
      credentialIds: null,
      totpIds: null,
      maxBudgetUsd: null,
      ...permissions,
    },
    browser: { profileId: null, enabled: true, headless: null },
    computer: { enabled: false, target: null },
    mcpServerIds: [],
    inheritMcp: true,
    subagents: [],
    workingDirectory: null,
    vmId: null,
    sshServerIds: [],
    heartbeat: { enabled: false, intervalMinutes: 60, hours: null, weekdays: false, checklist: "", since: null },
    repoPath: "/tmp/agent",
    lastRunAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("credential CRUD", () => {
  test("create normalizes and encrypts", () => {
    const events: string[] = [];
    const off = bus.on((e) => {
      if (e.type === "entity.changed") events.push(e.entity);
    });
    const c = createCredential({
      name: "  GitHub ",
      url: "www.github.com/login",
      username: " alice ",
      password: "  s3cret pass  ",
      notes: "recovery codes in drawer",
      tags: ["dev", " Dev ", "", "code"],
    });
    off();
    expect(events).toContain("credentials");
    expect(c).toMatchObject({
      name: "GitHub",
      url: "https://www.github.com/login",
      domains: ["github.com"],
      username: "alice",
      hasPassword: true,
      workspaceId: null,
      totpId: null,
      tags: ["dev", "code"],
      lastUsedAt: null,
    });
    expect(c.password).toBeUndefined();
    expect(c.notes).toBeUndefined();

    const row = get<{ password_enc: string; notes_enc: string }>("SELECT password_enc, notes_enc FROM credentials WHERE id = ?", c.id)!;
    expect(row.password_enc).not.toContain("s3cret");
    expect(row.notes_enc).not.toContain("drawer");
    // Ciphertexts are bound to their column + row.
    expect(() => vault.open(row.password_enc, `credentials.notes:${c.id}`)).toThrow();

    const revealed = getCredential(c.id, { reveal: true });
    expect(revealed.password).toBe("  s3cret pass  "); // passwords are never trimmed
    expect(revealed.notes).toBe("recovery codes in drawer");
    deleteCredential(c.id);
  });

  test("explicit domains are normalized and deduplicated", () => {
    const c = createCredential({ name: "Google", url: "https://accounts.google.com", domains: ["*.google.com", "https://www.Google.com/x", "youtube.com", " "] });
    expect(c.domains).toEqual(["google.com", "youtube.com"]);
    expect(createCredential({ name: "Local", url: "localhost:3000/login" }).url).toBe("https://localhost:3000/login");
    for (const url of ["javascript://alert(1)", "javascript:alert(1)", "file:///etc/passwd", "ftp://files.example.com", "http://exa mple.com"]) {
      expect(httpStatus(() => createCredential({ name: "Bad", url }))).toBe(400);
    }
    const noUrl = createCredential({ name: "Bare" });
    expect(noUrl).toMatchObject({ url: "", domains: [], hasPassword: false, username: "" });
    deleteCredential(c.id);
    deleteCredential(noUrl.id);
    deleteCredential(listCredentials({ search: "Local" })[0]!.id);
  });

  test("validation", () => {
    expect(httpStatus(() => createCredential({ name: "   " }))).toBe(400);
    expect(httpStatus(() => createCredential({ name: "X", workspaceId: "ws_missing" }))).toBe(404);
    expect(httpStatus(() => createCredential({ name: "X", totpId: "totp_missing" }))).toBe(404);
    expect(httpStatus(() => getCredential("cred_missing"))).toBe(404);
    expect(httpStatus(() => updateCredential("cred_missing", { name: "x" }))).toBe(404);
    expect(httpStatus(() => deleteCredential("cred_missing"))).toBe(404);
    expect(listCredentials()).toHaveLength(0);
  });

  test("update: keep/clear secrets, url follows derived domains, scope", () => {
    const c = createCredential({ name: "Shop", url: "https://shop.example.com", username: "bob", password: "pw-1", notes: "n" });
    let u = updateCredential(c.id, { username: "bobby" });
    expect(u.username).toBe("bobby");
    expect(getCredential(c.id, { reveal: true }).password).toBe("pw-1");

    u = updateCredential(c.id, { url: "https://store.example.org/login" });
    expect(u.domains).toEqual(["store.example.org"]);
    u = updateCredential(c.id, { domains: ["example.org", "example.net"] });
    u = updateCredential(c.id, { url: "https://other.example.com" });
    expect(u.domains).toEqual(["example.org", "example.net"]); // explicit domains are kept

    u = updateCredential(c.id, { password: "pw-2" });
    expect(getCredential(c.id, { reveal: true }).password).toBe("pw-2");
    u = updateCredential(c.id, { password: "", notes: "" });
    expect(u.hasPassword).toBe(false);
    const revealed = getCredential(c.id, { reveal: true });
    expect(revealed.password).toBeUndefined();
    expect(revealed.notes).toBeUndefined();

    u = updateCredential(c.id, { workspaceId: "ws_a" });
    expect(u.workspaceId).toBe("ws_a");
    expect(httpStatus(() => updateCredential(c.id, { workspaceId: "ws_missing" }))).toBe(404);
    expect(httpStatus(() => updateCredential(c.id, { name: "" }))).toBe(400);
    deleteCredential(c.id);
  });

  test("list filters by scope and search", () => {
    const g = createCredential({ name: "Global Mail", url: "https://mail.example.com", username: "me@example.com", tags: ["email"] });
    const a = createCredential({ name: "AWS", url: "https://signin.aws.amazon.com", username: "root", workspaceId: "ws_a", tags: ["infra"] });
    const b = createCredential({ name: "Bank", url: "https://bank.example", username: "acct-42", workspaceId: "ws_b" });

    expect(listCredentials().map((c) => c.name)).toEqual(["AWS", "Bank", "Global Mail"]);
    expect(listCredentials({ workspaceId: "all" })).toHaveLength(3);
    expect(listCredentials({ workspaceId: null }).map((c) => c.id)).toEqual([g.id]);
    expect(listCredentials({ workspaceId: "ws_a" }).map((c) => c.id)).toEqual([a.id]);
    expect(listCredentials({ search: "INFRA" }).map((c) => c.id)).toEqual([a.id]);
    expect(listCredentials({ search: "amazon.com" }).map((c) => c.id)).toEqual([a.id]);
    expect(listCredentials({ search: "acct" }).map((c) => c.id)).toEqual([b.id]);
    expect(listCredentials({ search: "mail example" }).map((c) => c.id)).toEqual([g.id]);
    expect(listCredentials({ search: "nothing-matches" })).toEqual([]);
    expect(listCredentials().every((c) => c.password === undefined && c.notes === undefined)).toBe(true);

    for (const c of [g, a, b]) deleteCredential(c.id);
  });
});

describe("TOTP link from the credential side", () => {
  test("link, re-link, unlink, delete", () => {
    const c = createCredential({ name: "GitHub", url: "https://github.com" });
    const t1 = createTotp({ issuer: "GitHub", accountName: "a", secret: "JBSWY3DPEHPK3PXP" });
    const t2 = createTotp({ issuer: "GitHub", accountName: "b", secret: "GEZDGNBVGY3TQOJQ" });

    expect(updateCredential(c.id, { totpId: t1.id }).totpId).toBe(t1.id);
    expect(getTotp(t1.id).credentialId).toBe(c.id);

    expect(updateCredential(c.id, { totpId: t2.id }).totpId).toBe(t2.id);
    expect(getTotp(t1.id).credentialId).toBeNull();
    expect(getTotp(t2.id).credentialId).toBe(c.id);

    // Another credential taking t2 unlinks it from c.
    const other = createCredential({ name: "GitHub 2", url: "https://github.com", totpId: t2.id });
    expect(other.totpId).toBe(t2.id);
    expect(getCredential(c.id).totpId).toBeNull();

    expect(updateCredential(other.id, { totpId: null }).totpId).toBeNull();
    expect(getTotp(t2.id).credentialId).toBeNull();

    updateCredential(c.id, { totpId: t1.id });
    deleteCredential(c.id);
    expect(getTotp(t1.id).credentialId).toBeNull();

    // Workspace TOTPs can only back logins of the same workspace; moving a login away drops the link.
    const wsTotp = createTotp({ issuer: "Jira", accountName: "x", secret: "JBSWY3DPEHPK3PXP", workspaceId: "ws_a" });
    const wsCred = createCredential({ name: "Jira", url: "https://jira.example.com", workspaceId: "ws_a", totpId: wsTotp.id });
    expect(httpStatus(() => updateCredential(other.id, { totpId: wsTotp.id }))).toBe(400);
    const moved = updateCredential(wsCred.id, { workspaceId: "ws_b" });
    expect(moved.totpId).toBeNull();
    expect(getTotp(wsTotp.id).credentialId).toBeNull();
    // Re-sending an incompatible link together with the move fails instead of silently dropping it.
    updateCredential(wsCred.id, { workspaceId: "ws_a", totpId: wsTotp.id });
    expect(httpStatus(() => updateCredential(wsCred.id, { workspaceId: "ws_b", totpId: wsTotp.id }))).toBe(400);
    expect(getCredential(wsCred.id)).toMatchObject({ workspaceId: "ws_a", totpId: wsTotp.id });

    // A global TOTP may back a workspace login.
    const globalTotp = createTotp({ issuer: "Jira", accountName: "y", secret: "GEZDGNBVGY3TQOJQ" });
    expect(updateCredential(wsCred.id, { totpId: globalTotp.id }).totpId).toBe(globalTotp.id);
    expect(getTotp(wsTotp.id).credentialId).toBeNull();

    deleteCredential(other.id);
    deleteCredential(wsCred.id);
  });

  test("a link left dangling by a workspace cascade is not reported", () => {
    insert("workspaces", { id: "ws_gone", name: "Gone", slug: "gone", created_at: ts, updated_at: ts });
    const t = createTotp({ issuer: "Cascade", accountName: "c", secret: "JBSWY3DPEHPK3PXP" });
    const c = createCredential({ name: "Cascade", url: "https://cascade.example", workspaceId: "ws_gone", totpId: t.id });
    expect(getTotp(t.id).credentialId).toBe(c.id);
    run("DELETE FROM workspaces WHERE id = ?", "ws_gone"); // cascades to the credential only
    expect(get("SELECT id FROM credentials WHERE id = ?", c.id)).toBeNull();
    expect(getTotp(t.id).credentialId).toBeNull();
    // The entry can be linked again normally.
    const replacement = createCredential({ name: "Cascade 2", url: "https://cascade.example", totpId: t.id });
    expect(getTotp(t.id).credentialId).toBe(replacement.id);
    deleteCredential(replacement.id);
  });
});

describe("agent access", () => {
  let globalLogin: string;
  let wsALogin: string;
  let wsBLogin: string;
  let subdomainLogin: string;

  beforeAll(() => {
    globalLogin = createCredential({ name: "GitHub personal", url: "https://github.com/login", username: "me", password: "gh-pass" }).id;
    wsALogin = createCredential({ name: "GitHub work", domains: ["github.com"], username: "me-work", password: "gh-work-pass", workspaceId: "ws_a" }).id;
    wsBLogin = createCredential({ name: "GitHub other", domains: ["github.com"], username: "me-b", password: "gh-b-pass", workspaceId: "ws_b" }).id;
    subdomainLogin = createCredential({ name: "Gist", url: "https://gist.github.com", username: "gist", workspaceId: "ws_a" }).id;
  });

  test("scoping: global agent sees only global logins", () => {
    const ids = credentialsForAgent(makeAgent(null)).map((c) => c.id);
    expect(ids).toContain(globalLogin);
    expect(ids).not.toContain(wsALogin);
    expect(ids).not.toContain(wsBLogin);
    expect(credentialsForAgent(makeAgent(null)).every((c) => c.password === undefined)).toBe(true);
  });

  test("scoping: workspace agent sees global + own workspace", () => {
    const ids = credentialsForAgent(makeAgent("ws_a")).map((c) => c.id);
    expect(ids).toContain(globalLogin);
    expect(ids).toContain(wsALogin);
    expect(ids).toContain(subdomainLogin);
    expect(ids).not.toContain(wsBLogin);
  });

  test("permissions.credentialIds restricts further", () => {
    expect(credentialsForAgent(makeAgent("ws_a", { credentialIds: [wsALogin, wsBLogin] })).map((c) => c.id)).toEqual([wsALogin]);
    expect(credentialsForAgent(makeAgent("ws_a", { credentialIds: [] }))).toEqual([]);
  });

  test("find by url/domain: subdomains match, best match first", () => {
    const agent = makeAgent("ws_a");
    expect(findCredentialsForAgent(agent, "https://github.com/settings").map((c) => c.id)).toEqual([wsALogin, globalLogin, subdomainLogin]);
    expect(findCredentialsForAgent(agent, "gist.github.com").map((c) => c.id)).toEqual([subdomainLogin, wsALogin, globalLogin]);
    // A sibling subdomain (gist.github.com) is not a match for api.github.com.
    expect(findCredentialsForAgent(agent, "https://api.github.com").map((c) => c.id)).toEqual([wsALogin, globalLogin]);
    expect(findCredentialsForAgent(agent, "gitlab.com")).toEqual([]);
    expect(findCredentialsForAgent(agent, "")).toEqual([]);
    expect(findCredentialsForAgent(makeAgent("ws_a", { credentialIds: [globalLogin] }), "github.com").map((c) => c.id)).toEqual([globalLogin]);
  });

  test("find by name when nothing matches by domain (guess), ranked below domain matches", () => {
    const agent = makeAgent("ws_a");
    const bitpanda = createCredential({ name: "Bitpanda", domains: ["bitpanda.com"], username: "me", workspaceId: "ws_a" }).id;
    try {
      // An exact domain match is still the only result when one exists.
      expect(findCredentialsForAgent(agent, "bitpanda.com").map((c) => c.id)).toEqual([bitpanda]);
      // Different TLD: no domain matches, but the login's name guesses the site.
      expect(findCredentialsForAgent(agent, "https://bitpanda.io/login").map((c) => c.id)).toEqual([bitpanda]);
      // An unrelated site matches neither by domain nor by name.
      expect(findCredentialsForAgent(agent, "coinbase.com")).toEqual([]);
      // A real domain match never brings in an unrelated name.
      expect(findCredentialsForAgent(agent, "github.com").map((c) => c.id)).not.toContain(bitpanda);
    } finally {
      deleteCredential(bitpanda);
    }
  });

  test("addCredentialDomain remembers a new host once", () => {
    const c = createCredential({ name: "Kraken", url: "https://kraken.com/login" }).id;
    try {
      expect(addCredentialDomain(c, "https://kraken.io/")).toBe(true);
      expect(getCredential(c).domains).toEqual(["kraken.com", "kraken.io"]);
      expect(addCredentialDomain(c, "kraken.io")).toBe(false); // already covered
      expect(addCredentialDomain(c, "kraken.com")).toBe(false);
    } finally {
      deleteCredential(c);
    }
  });

  test("revealForAgent returns secrets only in scope", () => {
    const agent = makeAgent("ws_a");
    expect(revealForAgent(agent, wsALogin)).toEqual({ username: "me-work", password: "gh-work-pass", url: "", totpId: null });
    expect(revealForAgent(agent, globalLogin)).toMatchObject({ username: "me", password: "gh-pass", url: "https://github.com/login" });
    expect(revealForAgent(agent, subdomainLogin).password).toBeNull();
    expect(httpStatus(() => revealForAgent(agent, wsBLogin))).toBe(403);
    expect(httpStatus(() => revealForAgent(makeAgent(null), wsALogin))).toBe(403);
    expect(httpStatus(() => revealForAgent(makeAgent("ws_a", { credentialIds: [globalLogin] }), wsALogin))).toBe(403);
    expect(httpStatus(() => revealForAgent(agent, "cred_missing"))).toBe(404);
  });

  test("markCredentialUsed sets lastUsedAt", () => {
    expect(getCredential(globalLogin).lastUsedAt).toBeNull();
    markCredentialUsed(globalLogin);
    expect(getCredential(globalLogin).lastUsedAt).not.toBeNull();
    markCredentialUsed("cred_missing"); // no-op
  });

  test("locked vault: metadata works, secrets → 423", async () => {
    vault.lock();
    try {
      expect(listCredentials().length).toBeGreaterThan(0);
      expect(credentialsForAgent(makeAgent("ws_a")).length).toBeGreaterThan(0);
      expect(httpStatus(() => getCredential(globalLogin, { reveal: true }))).toBe(423);
      expect(httpStatus(() => revealForAgent(makeAgent("ws_a"), wsALogin))).toBe(423);
      expect(httpStatus(() => createCredential({ name: "X", password: "p" }))).toBe(423);
      expect(httpStatus(() => updateCredential(globalLogin, { password: "p" }))).toBe(423);
      expect(listCredentials({ search: "X" }).some((c) => c.name === "X")).toBe(false); // failed create left nothing behind
    } finally {
      await vault.unlock(PASSPHRASE);
    }
    expect(getCredential(globalLogin, { reveal: true }).password).toBe("gh-pass");
  }, 60_000);
});
