import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentPermissions, TotpAlgorithm } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, insert, openDb } from "../src/db";
import { resetSettingsCache } from "../src/services/settings";
import { HttpError } from "../src/util";
import { createCredential, getCredential } from "../src/vault/credentials";
import { base32Decode, base32Encode, decodeMigrationPayload, normalizeBase32Secret, parseOtpUri } from "../src/vault/otpauth";
import {
  codeForAgent,
  createTotp,
  currentCodes,
  deleteTotp,
  generateTotp,
  getTotp,
  importTotpUris,
  listTotp,
  totpForAgent,
  updateTotp,
} from "../src/vault/totp";
import * as vault from "../src/vault/vault";

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function httpStatus(fn: () => unknown): number | null {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return null;
}

function makeAgent(workspaceId: string | null, permissions: Partial<AgentPermissions> = {}): Agent {
  const ts = new Date().toISOString();
  return {
    id: "agt_test",
    workspaceId,
    projectId: null,
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

/** Code for "now", tolerating a period boundary between the two samples. */
function codesAroundNow(secret: string, opts: { algorithm?: TotpAlgorithm; digits?: number; period?: number } = {}): string[] {
  const t = Date.now() / 1000;
  return [generateTotp(secret, { ...opts, time: t - 1 }), generateTotp(secret, { ...opts, time: t }), generateTotp(secret, { ...opts, time: t + 1 })];
}

/* Tiny protobuf encoder used to build Google Authenticator migration payloads. */
function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}
const key = (field: number, wire: number) => varint((field << 3) | wire);
const varintField = (field: number, value: number | bigint) => [...key(field, 0), ...varint(value)];
function bytesField(field: number, data: Uint8Array | string): number[] {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return [...key(field, 2), ...varint(bytes.length), ...bytes];
}
function otpParameters(p: { secret: Uint8Array; name: string; issuer: string; algorithm: number; digits: number; type: number; counter?: number }) {
  return Uint8Array.from([
    ...bytesField(1, p.secret),
    ...bytesField(2, p.name),
    ...bytesField(3, p.issuer),
    ...varintField(4, p.algorithm),
    ...varintField(5, p.digits),
    ...varintField(6, p.type),
    ...(p.counter !== undefined ? varintField(7, p.counter) : []),
    ...varintField(99, 7), // unknown field: must be skipped
  ]);
}
function migrationUri(params: Uint8Array[], opts: { urlEncode?: boolean } = {}): string {
  const payload = Uint8Array.from([
    ...params.flatMap((p) => bytesField(1, p)),
    ...varintField(2, 1),
    ...varintField(3, 1),
    ...varintField(4, 0),
    ...varintField(5, 424242),
  ]);
  const b64 = Buffer.from(payload).toString("base64");
  return `otpauth-migration://offline?data=${opts.urlEncode === false ? b64 : encodeURIComponent(b64)}`;
}

const RFC_SHA1_KEY = Buffer.from("12345678901234567890", "ascii");
const RFC_SHA256_KEY = Buffer.from("12345678901234567890123456789012", "ascii");
const RFC_SHA512_KEY = Buffer.from("1234567890".repeat(6) + "1234", "ascii");

/* ------------------------------------------------------------------ */
/* Pure functions                                                       */
/* ------------------------------------------------------------------ */

describe("RFC 6238 test vectors (Appendix B)", () => {
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [time, sha1, sha256, sha512] of vectors) {
    test(`T=${time}`, () => {
      expect(generateTotp(base32Encode(RFC_SHA1_KEY), { algorithm: "SHA1", digits: 8, time })).toBe(sha1);
      expect(generateTotp(base32Encode(RFC_SHA256_KEY), { algorithm: "SHA256", digits: 8, time })).toBe(sha256);
      expect(generateTotp(base32Encode(RFC_SHA512_KEY), { algorithm: "SHA512", digits: 8, time })).toBe(sha512);
    });
  }

  test("RFC 4226 HOTP vectors (period 1 → counter = time)", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    const secret = base32Encode(RFC_SHA1_KEY);
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expected.forEach((code, counter) => expect(generateTotp(secret, { period: 1, time: counter })).toBe(code));
  });

  test("defaults: SHA1, 6 digits, 30s period", () => {
    const secret = base32Encode(RFC_SHA1_KEY);
    expect(generateTotp(secret, { time: 59 })).toBe("287082");
    expect(generateTotp(secret, { time: 59 })).toBe(generateTotp(secret, { time: 59, digits: 8 }).slice(2));
    expect(generateTotp(secret, { time: 1111111109, digits: 7 })).toBe("7081804");
  });

  test("invalid parameters are rejected", () => {
    const secret = base32Encode(RFC_SHA1_KEY);
    expect(httpStatus(() => generateTotp(secret, { digits: 5 }))).toBe(400);
    expect(httpStatus(() => generateTotp(secret, { digits: 9 }))).toBe(400);
    expect(httpStatus(() => generateTotp(secret, { period: 0 }))).toBe(400);
    expect(httpStatus(() => generateTotp(secret, { algorithm: "MD5" as TotpAlgorithm }))).toBe(400);
    expect(httpStatus(() => generateTotp(""))).toBe(400);
    expect(httpStatus(() => generateTotp("not base32!"))).toBe(400);
  });
});

describe("base32", () => {
  test("RFC 4648 vectors", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY======"],
      ["fo", "MZXQ===="],
      ["foo", "MZXW6==="],
      ["foob", "MZXW6YQ="],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI======"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain), { padding: true })).toBe(encoded);
      expect(base32Encode(Buffer.from(plain))).toBe(encoded.replace(/=+$/, ""));
      expect(base32Decode(encoded).toString()).toBe(plain);
      expect(base32Decode(encoded.replace(/=+$/, "")).toString()).toBe(plain);
    }
  });

  test("round trip of random bytes", () => {
    for (let len = 1; len <= 40; len++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    }
  });

  test("tolerates lowercase, whitespace, dashes and missing padding", () => {
    expect(base32Decode("mzxw 6ytb oi").toString()).toBe("foobar");
    expect(base32Decode("MZXW-6YTB-OI").toString()).toBe("foobar");
    expect(base32Decode(" mzxw6ytboi======\n").toString()).toBe("foobar");
    expect(normalizeBase32Secret("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  test("rejects invalid characters", () => {
    for (const bad of ["MZXW1", "MZXW8", "MZ=XW", "abc!", "ÄÖÜ"]) expect(httpStatus(() => base32Decode(bad))).toBe(400);
    expect(httpStatus(() => normalizeBase32Secret("   "))).toBe(400);
  });
});

describe("otpauth:// parsing", () => {
  test("full URI with issuer param", () => {
    const [item] = parseOtpUri(
      "otpauth://totp/ACME%20Co:john.doe@email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60",
    );
    expect(item).toEqual({
      ok: true,
      label: "ACME Co:john.doe@email.com",
      account: {
        issuer: "ACME Co",
        accountName: "john.doe@email.com",
        secret: "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ",
        algorithm: "SHA256",
        digits: 8,
        period: 60,
      },
    });
  });

  test("issuer param wins over the label prefix; label prefix used when no param", () => {
    const [a] = parseOtpUri("otpauth://totp/Old%20Name:alice?secret=jbswy3dpehpk3pxp&issuer=New%20Name");
    expect(a).toMatchObject({ ok: true, account: { issuer: "New Name", accountName: "alice", secret: "JBSWY3DPEHPK3PXP" } });
    const [b] = parseOtpUri("otpauth://totp/GitHub:%20bob?secret=JBSWY3DPEHPK3PXP");
    expect(b).toMatchObject({ ok: true, account: { issuer: "GitHub", accountName: "bob", algorithm: "SHA1", digits: 6, period: 30 } });
    const [c] = parseOtpUri("otpauth://totp/carol@example.com?secret=JBSWY3DPEHPK3PXP");
    expect(c).toMatchObject({ ok: true, label: "carol@example.com", account: { issuer: "", accountName: "carol@example.com" } });
    const [d] = parseOtpUri("OTPAUTH://TOTP/Example:dave?secret=JBSWY3DPEHPK3PXP&algorithm=sha512&issuer=Example");
    expect(d).toMatchObject({ ok: true, account: { algorithm: "SHA512", issuer: "Example", accountName: "dave" } });
  });

  test("HOTP is skipped with a reason", () => {
    expect(parseOtpUri("otpauth://hotp/Example:eve?secret=JBSWY3DPEHPK3PXP&counter=3&issuer=Example")).toEqual([
      { ok: false, label: "Example:eve", reason: "HOTP counters are not supported" },
    ]);
  });

  test("malformed URIs are rejected", () => {
    expect(httpStatus(() => parseOtpUri("https://example.com"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth://totp/Example:x"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth://totp/Example:x?secret=JBSWY3DP1"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth://totp/Example:x?secret=JBSWY3DP&digits=5"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth://totp/Example:x?secret=JBSWY3DP&algorithm=MD5"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth://totp/Example:x?secret=JBSWY3DP&period=abc"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth://steam/Example:x?secret=JBSWY3DP"))).toBe(400);
  });
});

describe("otpauth-migration:// (Google Authenticator export)", () => {
  const githubSecret = crypto.getRandomValues(new Uint8Array(20));
  const exampleSecret = crypto.getRandomValues(new Uint8Array(32));
  const accounts = [
    otpParameters({ secret: githubSecret, name: "GitHub:alice", issuer: "GitHub", algorithm: 1, digits: 1, type: 2 }),
    otpParameters({ secret: exampleSecret, name: "bob@example.com", issuer: "Example", algorithm: 2, digits: 2, type: 2 }),
  ];

  test("decodes a two-account payload", () => {
    const items = parseOtpUri(migrationUri(accounts));
    expect(items).toEqual([
      {
        ok: true,
        label: "GitHub:alice",
        account: { issuer: "GitHub", accountName: "alice", secret: base32Encode(githubSecret), algorithm: "SHA1", digits: 6, period: 30 },
      },
      {
        ok: true,
        label: "Example:bob@example.com",
        account: { issuer: "Example", accountName: "bob@example.com", secret: base32Encode(exampleSecret), algorithm: "SHA256", digits: 8, period: 30 },
      },
    ]);
    // Codes computed from the imported secret equal codes from the raw key bytes.
    const item = items[1]!;
    if (!item.ok) throw new Error("expected ok");
    expect(generateTotp(item.account.secret, { algorithm: "SHA256", digits: 8, time: 1234567890 })).toBe(
      generateTotp(base32Encode(exampleSecret), { algorithm: "SHA256", digits: 8, time: 1234567890 }),
    );
  });

  test("payload header fields are decoded", () => {
    const b64 = decodeURIComponent(migrationUri(accounts).split("data=")[1]!);
    const payload = decodeMigrationPayload(Buffer.from(b64, "base64"));
    expect(payload.otpParameters).toHaveLength(2);
    expect(payload).toMatchObject({ version: 1, batchSize: 1, batchIndex: 0, batchId: 424242 });
  });

  test("tolerates a data parameter that was not URL-encoded", () => {
    // Force "+" and "/" into the base64 by using a secret of 0xFB/0xFF bytes.
    const uri = migrationUri([otpParameters({ secret: new Uint8Array(20).fill(0xfb), name: "x", issuer: "Y", algorithm: 0, digits: 0, type: 0 })], {
      urlEncode: false,
    });
    const [item] = parseOtpUri(uri);
    expect(item).toMatchObject({ ok: true, account: { issuer: "Y", accountName: "x", secret: base32Encode(new Uint8Array(20).fill(0xfb)) } });
  });

  test("unsupported entries are skipped individually", () => {
    const items = parseOtpUri(
      migrationUri([
        otpParameters({ secret: githubSecret, name: "Counter:hotp-user", issuer: "Counter", algorithm: 1, digits: 1, type: 1, counter: 5 }),
        otpParameters({ secret: githubSecret, name: "Old:md5-user", issuer: "Old", algorithm: 4, digits: 1, type: 2 }),
        otpParameters({ secret: githubSecret, name: "Fine:ok-user", issuer: "", algorithm: 3, digits: 0, type: 0 }),
      ]),
    );
    expect(items).toEqual([
      { ok: false, label: "Counter:hotp-user", reason: "HOTP counters are not supported" },
      { ok: false, label: "Old:md5-user", reason: "MD5 algorithm is not supported" },
      {
        ok: true,
        label: "Fine:ok-user",
        account: { issuer: "Fine", accountName: "ok-user", secret: base32Encode(githubSecret), algorithm: "SHA512", digits: 6, period: 30 },
      },
    ]);
  });

  test("garbage is rejected", () => {
    expect(httpStatus(() => parseOtpUri("otpauth-migration://offline"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth-migration://offline?data=%%%"))).toBe(400);
    expect(httpStatus(() => parseOtpUri("otpauth-migration://offline?data=AAAA"))).toBe(400);
    expect(httpStatus(() => parseOtpUri(`otpauth-migration://offline?data=${encodeURIComponent(Buffer.from([0x0a, 0x50, 0x01]).toString("base64"))}`))).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Service (database)                                                   */
/* ------------------------------------------------------------------ */

describe("TOTP service", () => {
  let dir: string;
  const ts = new Date().toISOString();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "godmode-totp-test-"));
    loadConfig({ dataDir: dir, token: "test-token" });
    openDb(join(dir, "test.db"));
    resetSettingsCache();
    vault.lock();
    await vault.setup("totp test passphrase", false);
    insert("workspaces", { id: "ws_a", name: "A", slug: "a", created_at: ts, updated_at: ts });
    insert("workspaces", { id: "ws_b", name: "B", slug: "b", created_at: ts, updated_at: ts });
  }, 60_000);

  afterAll(() => {
    vault.lock();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("create stores an encrypted, normalized secret", () => {
    const entry = createTotp({ issuer: " GitHub ", accountName: "alice", secret: "jbsw y3dp ehpk 3pxp" });
    expect(entry).toMatchObject({ issuer: "GitHub", accountName: "alice", algorithm: "SHA1", digits: 6, period: 30, workspaceId: null, credentialId: null });
    expect(JSON.stringify(entry)).not.toContain("JBSWY3DPEHPK3PXP");
    const row = get<{ secret_enc: string }>("SELECT secret_enc FROM totp WHERE id = ?", entry.id)!;
    expect(row.secret_enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(vault.open(row.secret_enc, `totp.secret:${entry.id}`)).toBe("JBSWY3DPEHPK3PXP");
    deleteTotp(entry.id);
  });

  test("validation", () => {
    expect(httpStatus(() => createTotp({ issuer: "", accountName: "", secret: "JBSWY3DPEHPK3PXP" }))).toBe(400);
    expect(httpStatus(() => createTotp({ issuer: "X", secret: "not-base32!" }))).toBe(400);
    expect(httpStatus(() => createTotp({ issuer: "X", secret: "JBSWY3DPEHPK3PXP", digits: 10 }))).toBe(400);
    expect(httpStatus(() => createTotp({ issuer: "X", secret: "JBSWY3DPEHPK3PXP", workspaceId: "ws_missing" }))).toBe(404);
    expect(httpStatus(() => createTotp({ issuer: "X", secret: "JBSWY3DPEHPK3PXP", credentialId: "cred_missing" }))).toBe(404);
    expect(listTotp()).toHaveLength(0);
  });

  test("list, search, scope filters, update, codes, delete", () => {
    const g = createTotp({ issuer: "Google", accountName: "me@gmail.com", secret: "JBSWY3DPEHPK3PXP" });
    const a = createTotp({ issuer: "Stripe", accountName: "ops@acme.com", secret: "GEZDGNBVGY3TQOJQ", workspaceId: "ws_a", algorithm: "SHA256", digits: 8, period: 60 });
    expect(listTotp().map((e) => e.issuer)).toEqual(["Google", "Stripe"]);
    expect(listTotp({ workspaceId: "all" })).toHaveLength(2);
    expect(listTotp({ workspaceId: null }).map((e) => e.id)).toEqual([g.id]);
    expect(listTotp({ workspaceId: "ws_a" }).map((e) => e.id)).toEqual([a.id]);
    expect(listTotp({ workspaceId: "ws_b" })).toHaveLength(0);
    expect(listTotp({ search: "ACME" }).map((e) => e.id)).toEqual([a.id]);
    expect(listTotp({ search: "google gmail" }).map((e) => e.id)).toEqual([g.id]);

    const codes = currentCodes();
    expect(codes.map((c) => c.id).sort()).toEqual([g.id, a.id].sort());
    const codeA = codes.find((c) => c.id === a.id)!;
    expect(codeA.period).toBe(60);
    expect(codeA.code).toMatch(/^\d{8}$/);
    expect(codeA.remaining).toBeGreaterThanOrEqual(1);
    expect(codeA.remaining).toBeLessThanOrEqual(60);
    expect(codesAroundNow("GEZDGNBVGY3TQOJQ", { algorithm: "SHA256", digits: 8, period: 60 })).toContain(codeA.code);
    expect(currentCodes([g.id, "totp_unknown"]).map((c) => c.id)).toEqual([g.id]);
    expect(currentCodes([])).toEqual([]);
    expect(getTotp(g.id).lastUsedAt).toBeNull(); // viewing codes does not mark as used

    const updated = updateTotp(g.id, { issuer: "Google Workspace", secret: "GEZDGNBVGY3TQOJQ", digits: 7 });
    expect(updated).toMatchObject({ issuer: "Google Workspace", accountName: "me@gmail.com", digits: 7 });
    expect(codesAroundNow("GEZDGNBVGY3TQOJQ", { digits: 7 })).toContain(currentCodes([g.id])[0]!.code);
    expect(httpStatus(() => updateTotp(g.id, { period: 0 }))).toBe(400);
    expect(httpStatus(() => updateTotp("totp_missing", { issuer: "x" }))).toBe(404);

    deleteTotp(g.id);
    deleteTotp(a.id);
    expect(listTotp()).toHaveLength(0);
    expect(httpStatus(() => deleteTotp(g.id))).toBe(404);
  });

  test("credential link is bidirectional and re-linking unlinks the old side", () => {
    const cred1 = createCredential({ name: "GitHub", url: "https://github.com/login", username: "alice" });
    const cred2 = createCredential({ name: "GitHub (work)", url: "https://github.com/login", username: "alice-work" });
    const t = createTotp({ issuer: "GitHub", accountName: "alice", secret: "JBSWY3DPEHPK3PXP", credentialId: cred1.id });
    expect(t.credentialId).toBe(cred1.id);
    expect(getCredential(cred1.id).totpId).toBe(t.id);

    updateTotp(t.id, { credentialId: cred2.id });
    expect(getTotp(t.id).credentialId).toBe(cred2.id);
    expect(getCredential(cred2.id).totpId).toBe(t.id);
    expect(getCredential(cred1.id).totpId).toBeNull();

    updateTotp(t.id, { credentialId: null });
    expect(getCredential(cred2.id).totpId).toBeNull();

    updateTotp(t.id, { credentialId: cred1.id });
    deleteTotp(t.id);
    expect(getCredential(cred1.id).totpId).toBeNull();

    // A workspace-scoped TOTP cannot back a global login.
    const wsTotp = createTotp({ issuer: "GitHub", accountName: "alice", secret: "JBSWY3DPEHPK3PXP", workspaceId: "ws_a" });
    expect(httpStatus(() => updateTotp(wsTotp.id, { credentialId: cred1.id }))).toBe(400);
    // Moving a linked global TOTP into a workspace drops the now-incompatible link.
    const globalTotp = createTotp({ issuer: "GitHub", accountName: "alice", secret: "GEZDGNBVGY3TQOJQ", credentialId: cred1.id });
    updateTotp(globalTotp.id, { workspaceId: "ws_a" });
    expect(getTotp(globalTotp.id).credentialId).toBeNull();
    expect(getCredential(cred1.id).totpId).toBeNull();
  });

  test("import: otpauth + migration, dedupe, skip reasons, auto-link", () => {
    const acme = createCredential({ name: "ACME Portal", url: "https://portal.acme.io", username: "john@acme.io", workspaceId: "ws_b" });
    const gitlab1 = createCredential({ name: "GitLab", domains: ["gitlab.com"], username: "one", workspaceId: "ws_b" });
    const gitlab2 = createCredential({ name: "GitLab 2", domains: ["gitlab.com"], username: "two", workspaceId: "ws_b" });
    const secret20 = crypto.getRandomValues(new Uint8Array(20));

    const result = importTotpUris({
      workspaceId: "ws_b",
      uris: [
        "otpauth://totp/ACME:john@acme.io?secret=JBSWY3DPEHPK3PXP&issuer=ACME",
        // two URIs pasted in one string, one of them a duplicate of the first
        "otpauth://totp/GitLab:two?secret=GEZDGNBVGY3TQOJQ&issuer=GitLab\notpauth://totp/ACME:john@acme.io?secret=JBSWY3DPEHPK3PXP&issuer=ACME",
        "otpauth://hotp/Old:x?secret=JBSWY3DPEHPK3PXP&counter=1",
        "https://not-an-otp.example",
        migrationUri([
          otpParameters({ secret: secret20, name: "GitLab:three", issuer: "GitLab", algorithm: 2, digits: 2, type: 2 }),
          otpParameters({ secret: secret20, name: "Nobody:none", issuer: "Nobody", algorithm: 1, digits: 1, type: 1 }),
        ]),
      ],
    });

    expect(result.imported.map((e) => `${e.issuer}:${e.accountName}`)).toEqual(["ACME:john@acme.io", "GitLab:two", "GitLab:three"]);
    expect(result.imported.every((e) => e.workspaceId === "ws_b")).toBe(true);
    const [acmeTotp, gitlabTwo, gitlabThree] = result.imported;
    expect(gitlabThree).toMatchObject({ algorithm: "SHA256", digits: 8 });

    expect(result.skipped.map((s) => s.reason)).toEqual([
      "already exists",
      "HOTP counters are not supported",
      "Not an otpauth:// or otpauth-migration:// URI",
      "HOTP counters are not supported",
    ]);
    expect(result.skipped[0]).toMatchObject({ label: "ACME:john@acme.io", uri: "otpauth://totp/ACME:john@acme.io?secret=•••&issuer=ACME" });
    expect(result.skipped[3]).toMatchObject({ label: "Nobody:none", uri: "otpauth-migration://offline?data=•••" });
    // Secrets are never echoed back.
    expect(JSON.stringify(result.skipped)).not.toContain("JBSWY3DPEHPK3PXP");

    // Auto-link: ACME via domain label + username; GitLab "two" via username among two candidates;
    // GitLab "three" has no username match and more than one candidate left → not linked.
    expect(acmeTotp!.credentialId).toBe(acme.id);
    expect(getCredential(acme.id).totpId).toBe(acmeTotp!.id);
    expect(gitlabTwo!.credentialId).toBe(gitlab2.id);
    expect(gitlabThree!.credentialId).toBeNull();
    expect(getCredential(gitlab1.id).totpId).toBeNull();

    // Re-importing the same data is fully deduplicated; a different scope is not.
    const again = importTotpUris({ workspaceId: "ws_b", uris: ["otpauth://totp/ACME:john@acme.io?secret=JBSWY3DPEHPK3PXP&issuer=ACME"] });
    expect(again.imported).toHaveLength(0);
    expect(again.skipped[0]!.reason).toBe("already exists");
    const otherScope = importTotpUris({ workspaceId: "ws_a", uris: ["otpauth://totp/ACME:john@acme.io?secret=JBSWY3DPEHPK3PXP&issuer=ACME"] });
    expect(otherScope.imported).toHaveLength(1);
    expect(otherScope.imported[0]!.credentialId).toBeNull(); // credential lives in ws_b

    expect(httpStatus(() => importTotpUris({ workspaceId: "ws_missing", uris: [] }))).toBe(404);

    // A URI without any label still imports, under a placeholder name.
    const unnamed = importTotpUris({ workspaceId: "ws_b", uris: ["otpauth://totp?secret=MFRGGZDFMZTWQ2LK"] });
    expect(unnamed.imported[0]).toMatchObject({ issuer: "", accountName: "Unnamed account" });
    expect(importTotpUris({ workspaceId: "ws_b", uris: ["otpauth://totp/?secret=MFRGGZDFMZTWQ2LK"] }).skipped[0]!.reason).toBe("already exists");
  });

  test("agent access: scope, permissions, lastUsedAt", () => {
    const global = createTotp({ issuer: "AgentGlobal", accountName: "g", secret: "JBSWY3DPEHPK3PXP" });
    const inA = createTotp({ issuer: "AgentA", accountName: "a", secret: "GEZDGNBVGY3TQOJQ", workspaceId: "ws_a" });
    const inB = createTotp({ issuer: "AgentB", accountName: "b", secret: "GEZDGNBVGY3TQOJQ", workspaceId: "ws_b" });

    const globalAgent = makeAgent(null);
    const agentA = makeAgent("ws_a");
    const restricted = makeAgent("ws_a", { totpIds: [inA.id] });

    const visibleToGlobal = totpForAgent(globalAgent).map((e) => e.id);
    expect(visibleToGlobal).toContain(global.id);
    expect(visibleToGlobal).not.toContain(inA.id);
    expect(visibleToGlobal).not.toContain(inB.id);
    const visibleToA = totpForAgent(agentA).map((e) => e.id);
    expect(visibleToA).toContain(global.id);
    expect(visibleToA).toContain(inA.id);
    expect(visibleToA).not.toContain(inB.id);
    expect(totpForAgent(restricted).map((e) => e.id)).toEqual([inA.id]);
    expect(totpForAgent(makeAgent("ws_a", { totpIds: [] }))).toEqual([]);

    const code = codeForAgent(agentA, inA.id);
    expect(code.id).toBe(inA.id);
    expect(codesAroundNow("GEZDGNBVGY3TQOJQ")).toContain(code.code);
    expect(getTotp(inA.id).lastUsedAt).not.toBeNull();

    expect(httpStatus(() => codeForAgent(agentA, inB.id))).toBe(403);
    expect(httpStatus(() => codeForAgent(restricted, global.id))).toBe(403);
    expect(httpStatus(() => codeForAgent(agentA, "totp_missing"))).toBe(404);
  });

  test("agent access: credentialIds restricts TOTP when totpIds is null", () => {
    const allowedCred = createCredential({ name: "Allowed", url: "https://allowed.example", workspaceId: "ws_a" });
    const otherCred = createCredential({ name: "Other", url: "https://other.example", workspaceId: "ws_a" });
    const linkedAllowed = createTotp({ issuer: "Allowed", accountName: "x", secret: "JBSWY3DPEHPK3PXP", workspaceId: "ws_a", credentialId: allowedCred.id });
    const linkedGlobal = createTotp({ issuer: "AllowedGlobal", accountName: "y", secret: "GEZDGNBVGY3TQOJQ" });
    updateTotp(linkedGlobal.id, { credentialId: allowedCred.id }); // re-link: now the allowed credential's entry
    updateTotp(linkedAllowed.id, { credentialId: otherCred.id });
    const unlinked = createTotp({ issuer: "Unlinked", accountName: "z", secret: "GEZDGNBVGY3TQOJQ", workspaceId: "ws_a" });

    // totpIds null + credentialIds set → only entries linked to an allowed credential.
    const byCredential = makeAgent("ws_a", { credentialIds: [allowedCred.id], totpIds: null });
    expect(totpForAgent(byCredential).map((e) => e.id)).toEqual([linkedGlobal.id]);
    expect(codeForAgent(byCredential, linkedGlobal.id).id).toBe(linkedGlobal.id);
    expect(httpStatus(() => codeForAgent(byCredential, linkedAllowed.id))).toBe(403); // linked to a non-allowed credential
    expect(httpStatus(() => codeForAgent(byCredential, unlinked.id))).toBe(403);
    expect(totpForAgent(makeAgent("ws_a", { credentialIds: [], totpIds: null }))).toEqual([]);

    // totpIds set → exactly those, regardless of credentialIds.
    const explicit = makeAgent("ws_a", { credentialIds: [allowedCred.id], totpIds: [unlinked.id] });
    expect(totpForAgent(explicit).map((e) => e.id)).toEqual([unlinked.id]);
    expect(httpStatus(() => codeForAgent(explicit, linkedGlobal.id))).toBe(403);

    // Both null → everything in scope.
    const open = totpForAgent(makeAgent("ws_a")).map((e) => e.id);
    expect(open).toEqual(expect.arrayContaining([linkedAllowed.id, linkedGlobal.id, unlinked.id]));
  });

  test("locked vault → 423 for secrets, metadata still listable", async () => {
    vault.lock();
    try {
      expect(httpStatus(() => currentCodes())).toBe(423);
      expect(httpStatus(() => createTotp({ issuer: "X", secret: "JBSWY3DPEHPK3PXP" }))).toBe(423);
      expect(httpStatus(() => importTotpUris({ uris: ["otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP"] }))).toBe(423);
      const entry = listTotp()[0]!;
      expect(httpStatus(() => codeForAgent(makeAgent(entry.workspaceId), entry.id))).toBe(423);
      expect(listTotp().length).toBeGreaterThan(0);
    } finally {
      await vault.unlock("totp test passphrase");
    }
  }, 60_000);
});
