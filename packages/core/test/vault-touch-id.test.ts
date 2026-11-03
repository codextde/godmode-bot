import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperError } from "../src/computer/helperError";
import { loadConfig } from "../src/config";
import { closeDb, getMeta, openDb, setMeta } from "../src/db";
import { HttpError } from "../src/util";
import { resetSettingsCache } from "../src/services/settings";
import { disableTouchId, enableTouchId, touchIdDeps, touchIdStatus, unlockWithTouchId } from "../src/vault/touchId";
import * as vault from "../src/vault/vault";

const PASSPHRASE = "correct horse battery";
const realDeps = { ...touchIdDeps };
let dir: string;
let enclave: ReturnType<typeof createECDH>;
let prompts: string[];
let answer: () => void;

const code = async (run: Promise<unknown>) => run.then(() => "ok", (err: unknown) => (err instanceof HttpError ? err.code : String(err)));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "godmode-touch-id-test-"));
  process.env.GODMODE_KEYCHAIN = "0";
  loadConfig({ dataDir: dir, token: "test-token" });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  await vault.setup(PASSPHRASE, false);
});

beforeEach(() => {
  enclave = createECDH("prime256v1");
  enclave.generateKeys();
  prompts = [];
  answer = () => {};
  Object.assign(touchIdDeps, {
    supported: () => true,
    available: async () => true,
    createKey: async () => ({ key: "enclave-blob", publicKey: enclave.getPublicKey().toString("base64") }),
    derive: async (_key: string, peer: string, reason: string) => {
      prompts.push(reason);
      answer();
      return enclave.computeSecret(Buffer.from(peer, "base64")).toString("base64");
    },
  });
});

afterEach(async () => {
  disableTouchId();
  if (!vault.isUnlocked()) await vault.unlock(PASSPHRASE);
});

afterAll(() => {
  Object.assign(touchIdDeps, realDeps);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("vault touch id", () => {
  test("a finger opens the locked vault, and the seal never holds the plain key", async () => {
    const dek = vault.exportKeyForBackup().toString("base64");
    await enableTouchId();
    expect(prompts).toHaveLength(1);
    expect(await touchIdStatus()).toEqual({ available: true, enabled: true });
    expect(getMeta("vault.touch_id")).not.toContain(dek);

    vault.lock();
    expect((await unlockWithTouchId()).unlocked).toBe(true);
    expect(vault.exportKeyForBackup().toString("base64")).toBe(dek);
  });

  test("a cancelled prompt leaves the vault locked and Touch ID on", async () => {
    await enableTouchId();
    vault.lock();
    answer = () => {
      throw new HelperError("Touch ID was cancelled", "touch_id_cancelled");
    };
    expect(await code(unlockWithTouchId())).toBe("touch_id_cancelled");
    expect(vault.isUnlocked()).toBe(false);
    expect((await touchIdStatus()).enabled).toBe(true);
  });

  test("a cancelled prompt doesn't turn Touch ID on", async () => {
    answer = () => {
      throw new HelperError("Touch ID was cancelled", "touch_id_cancelled");
    };
    expect(await code(enableTouchId())).toBe("touch_id_cancelled");
    expect((await touchIdStatus()).enabled).toBe(false);
  });

  test("a helper that dies or times out leaves Touch ID on", async () => {
    await enableTouchId();
    vault.lock();
    answer = () => {
      throw new Error("timed out");
    };
    expect(await code(unlockWithTouchId())).toBe("touch_id_unavailable");
    expect((await touchIdStatus()).enabled).toBe(true);
    expect(vault.isUnlocked()).toBe(false);
  });

  test("changed fingerprints turn it off, the passphrase still works", async () => {
    await enableTouchId();
    vault.lock();
    answer = () => {
      throw new HelperError("The fingerprints on this Mac have changed", "touch_id_invalid");
    };
    expect(await code(unlockWithTouchId())).toBe("touch_id_invalid");
    expect((await touchIdStatus()).enabled).toBe(false);
    expect((await vault.unlock(PASSPHRASE)).unlocked).toBe(true);
  });

  test("another enclave's secret doesn't open the seal", async () => {
    await enableTouchId();
    vault.lock();
    enclave = createECDH("prime256v1");
    enclave.generateKeys();
    expect(await code(unlockWithTouchId())).toBe("touch_id_invalid");
    expect(vault.isUnlocked()).toBe(false);
  });

  test("a seal of another vault key doesn't unlock this vault", async () => {
    await enableTouchId();
    const meta = vault.vaultMetaForBackup();
    setMeta("vault.canary", "v1.AAAA.AAAA");
    vault.lock();
    expect(await code(unlockWithTouchId())).toBe("touch_id_invalid");
    expect(vault.isUnlocked()).toBe(false);
    expect(getMeta("vault.touch_id")).toBeNull();
    setMeta("vault.canary", meta.canary!);
  });

  test("one prompt at a time", async () => {
    await enableTouchId();
    vault.lock();
    const first = unlockWithTouchId();
    expect(await code(unlockWithTouchId())).toBe("touch_id_busy");
    await first;
  });

  test("off, or not on this computer: no prompt", async () => {
    vault.lock();
    expect(await code(unlockWithTouchId())).toBe("touch_id_off");
    expect(prompts).toHaveLength(0);
    touchIdDeps.supported = () => false;
    expect(await touchIdStatus()).toEqual({ available: false, enabled: false });
  });

  test("locked vault can't be sealed", async () => {
    vault.lock();
    expect(await code(enableTouchId())).toBe("vault_locked");
  });
});
