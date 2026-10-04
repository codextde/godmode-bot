import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { resetSettingsCache } from "../src/services/settings";
import { HttpError } from "../src/util";
import {
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  hashPassword,
  openWithPassphrase,
  randomKey,
  sealWithPassphrase,
  verifyPassword,
} from "../src/vault/crypto";
import * as vault from "../src/vault/vault";

const SLOW = 60_000; // scrypt N=2^17 takes a few hundred ms per derivation

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "godmode-vault-test-"));
  loadConfig({ dataDir: dir, token: "test-token" });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  vault.lock();
});

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

async function httpStatusAsync(fn: () => Promise<unknown>): Promise<number | null> {
  try {
    await fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return null;
}

describe("crypto", () => {
  test("AES-GCM round trip with AAD", () => {
    const key = randomKey();
    const ct = encrypt(key, "hunter2 ✓", "credentials.password:cred_1");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(ct).not.toContain("hunter2");
    expect(decrypt(key, ct, "credentials.password:cred_1")).toBe("hunter2 ✓");
  });

  test("ciphertexts are randomized", () => {
    const key = randomKey();
    expect(encrypt(key, "same", "ctx")).not.toBe(encrypt(key, "same", "ctx"));
  });

  test("AAD mismatch is rejected", () => {
    const key = randomKey();
    const ct = encrypt(key, "secret", "credentials.password:cred_1");
    expect(() => decrypt(key, ct, "credentials.password:cred_2")).toThrow();
    expect(() => decrypt(key, ct, "")).toThrow();
  });

  test("wrong key and tampering are rejected", () => {
    const key = randomKey();
    const ct = encrypt(key, "secret", "ctx");
    expect(() => decrypt(randomKey(), ct, "ctx")).toThrow();
    const [v, iv, data] = ct.split(".");
    const bytes = Buffer.from(data!, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    expect(() => decrypt(key, `${v}.${iv}.${bytes.toString("base64url")}`, "ctx")).toThrow();
    expect(() => decrypt(key, "v2.abc.def", "ctx")).toThrow();
  });

  test("binary round trip", () => {
    const key = randomKey();
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    expect([...decryptBytes(key, encryptBytes(key, data, "bin"), "bin")]).toEqual([...data]);
  });

  test("passphrase container round trip", () => {
    const sealed = sealWithPassphrase("backup-pass", new TextEncoder().encode("payload"));
    expect(new TextDecoder().decode(openWithPassphrase("backup-pass", sealed))).toBe("payload");
    expect(() => openWithPassphrase("wrong-pass", sealed)).toThrow("Wrong backup passphrase");
  }, SLOW);

  test("password hashing", () => {
    const stored = hashPassword("dashboard-pass");
    expect(verifyPassword("dashboard-pass", stored)).toBe(true);
    expect(verifyPassword("nope", stored)).toBe(false);
    expect(verifyPassword("dashboard-pass", "garbage")).toBe(false);
  }, SLOW);
});

describe("vault lifecycle", () => {
  let sealed = "";

  test("starts uninitialized and locked", () => {
    expect(vault.status()).toEqual({ initialized: false, unlocked: false, rememberDevice: false, autoLockMinutes: 0 });
    expect(httpStatus(() => vault.seal("x", "ctx"))).toBe(423);
  });

  test("rejects short passphrases", async () => {
    expect(await httpStatusAsync(() => vault.setup("short", false))).toBe(400);
    expect(vault.isInitialized()).toBe(false);
  });

  test("setup unlocks the vault", async () => {
    const status = await vault.setup("correct horse battery", false);
    expect(status.initialized).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.rememberDevice).toBe(false);
    sealed = vault.seal("my-password", "credentials.password:cred_a");
    expect(vault.open(sealed, "credentials.password:cred_a")).toBe("my-password");
    expect(() => vault.open(sealed, "credentials.password:cred_b")).toThrow();
    expect(await httpStatusAsync(() => vault.setup("another passphrase", false))).toBe(400);
  }, SLOW);

  test("optional helpers", () => {
    expect(vault.sealOptional("", "ctx")).toBeNull();
    expect(vault.sealOptional(null, "ctx")).toBeNull();
    expect(vault.openOptional(null, "ctx")).toBeNull();
    expect(vault.openOptional(vault.sealOptional("v", "ctx"), "ctx")).toBe("v");
  });

  test("lock blocks secret access with 423", () => {
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(httpStatus(() => vault.open(sealed, "credentials.password:cred_a"))).toBe(423);
    expect(httpStatus(() => vault.seal("x", "ctx"))).toBe(423);
  });

  test("unlock with wrong passphrase fails, right one succeeds", async () => {
    expect(await httpStatusAsync(() => vault.unlock("wrong passphrase"))).toBe(400);
    expect(vault.isUnlocked()).toBe(false);
    const status = await vault.unlock("correct horse battery");
    expect(status.unlocked).toBe(true);
    expect(vault.open(sealed, "credentials.password:cred_a")).toBe("my-password");
  }, SLOW);

  test("changePassphrase re-wraps the same data key", async () => {
    expect(await httpStatusAsync(() => vault.changePassphrase("wrong passphrase", "new passphrase 42"))).toBe(400);
    expect(await httpStatusAsync(() => vault.changePassphrase("correct horse battery", "short"))).toBe(400);
    await vault.changePassphrase("correct horse battery", "new passphrase 42");
    vault.lock();
    expect(await httpStatusAsync(() => vault.unlock("correct horse battery"))).toBe(400);
    await vault.unlock("new passphrase 42");
    expect(vault.open(sealed, "credentials.password:cred_a")).toBe("my-password");
  }, SLOW);

  test("words every login page uses are never masked, and the epoch moves when what is masked changes", () => {
    const before = vault.redactionEpoch();
    vault.rememberSecret("password");
    vault.rememberSecret("Username");
    expect(vault.redactionEpoch()).toBe(before);
    expect(vault.redact("Could not find a password field for the username")).toBe("Could not find a password field for the username");
    vault.rememberSecret("hunter2-epoch-probe");
    expect(vault.redactionEpoch()).not.toBe(before);
    expect(vault.redact("typed hunter2-epoch-probe")).toBe("typed ••••••••");
  });

  test("app secrets are encrypted and redacted", () => {
    vault.setAppSecret("openai_api_key", "sk-test-1234567890");
    expect(vault.hasAppSecret("openai_api_key")).toBe(true);
    expect(vault.getAppSecret("openai_api_key")).toBe("sk-test-1234567890");
    expect(vault.redact("key=sk-test-1234567890!")).toBe("key=••••••••!");
    vault.setAppSecret("openai_api_key", null);
    expect(vault.hasAppSecret("openai_api_key")).toBe(false);
    expect(vault.getAppSecret("openai_api_key")).toBeNull();
  });
});
