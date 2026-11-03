import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { HelperError } from "../src/computer/helperError";
import { isValidGrant, issueGrant, requireGrant, requirePasswordGrant } from "../src/server/grants";
import { loadConfig } from "../src/config";
import { closeDb, getMeta, openDb, setMeta } from "../src/db";
import { HttpError } from "../src/util";
import { resetSettingsCache } from "../src/services/settings";
import { encrypt } from "../src/vault/crypto";
import { confirmWithTouchId, disableTouchId, enableTouchId, touchIdDeps, touchIdStatus, unlockWithTouchId } from "../src/vault/touchId";
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

  test("a finger confirms it's you without changing the lock state", async () => {
    await enableTouchId();
    prompts = [];
    await confirmWithTouchId();
    expect(prompts).toEqual(["confirm it's you"]);
    expect(vault.isUnlocked()).toBe(true);

    vault.lock();
    await confirmWithTouchId();
    expect(vault.isUnlocked()).toBe(false);
  });

  test("confirming needs Touch ID on and a finger", async () => {
    expect(await code(confirmWithTouchId())).toBe("touch_id_off");
    await enableTouchId();
    answer = () => {
      throw new HelperError("Touch ID was cancelled", "touch_id_cancelled");
    };
    expect(await code(confirmWithTouchId())).toBe("touch_id_cancelled");
    expect((await touchIdStatus()).enabled).toBe(true);
  });

  test("a planted seal and canary of another key confirm nothing while unlocked", async () => {
    await enableTouchId();
    const real = JSON.parse(getMeta("vault.touch_id")!) as { peer: string };
    const canary = getMeta("vault.canary")!;
    const secret = enclave.computeSecret(Buffer.from(real.peer, "base64"));
    const wrapping = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "godmode vault touch id", 32));
    const other = randomBytes(32);
    setMeta("vault.touch_id", JSON.stringify({ ...real, box: encrypt(wrapping, other.toString("base64"), "vault.touch_id") }));
    setMeta("vault.canary", encrypt(other, "ok", "vault.canary"));
    expect(await code(confirmWithTouchId())).toBe("touch_id_invalid");
    setMeta("vault.canary", canary);
  });

  test("a finger's grant can't turn Touch ID on, the password's can", () => {
    const context = (grant: string) => ({ req: { header: () => grant } }) as unknown as Context;
    const finger = issueGrant("finger").grant;
    expect(isValidGrant(finger)).toBe(true);
    expect(() => requireGrant(context(finger))).not.toThrow();
    expect(() => requirePasswordGrant(context(finger))).toThrow();
    expect(() => requirePasswordGrant(context(issueGrant().grant))).not.toThrow();
    expect(() => requirePasswordGrant(context("nothing"))).toThrow();
  });

  test("a planted seal of another key confirms nothing", async () => {
    await enableTouchId();
    const real = JSON.parse(getMeta("vault.touch_id")!) as { peer: string };
    const secret = enclave.computeSecret(Buffer.from(real.peer, "base64"));
    const wrapping = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "godmode vault touch id", 32));
    const planted = encrypt(wrapping, randomBytes(32).toString("base64"), "vault.touch_id");
    setMeta("vault.touch_id", JSON.stringify({ ...real, box: planted }));
    expect(await code(confirmWithTouchId())).toBe("touch_id_invalid");
    expect(getMeta("vault.touch_id")).toBeNull();
  });

  test("a prompt left open across a lock doesn't undo that lock", async () => {
    await enableTouchId();
    vault.lock();
    answer = () => vault.lock();
    expect(await code(unlockWithTouchId())).toBe("touch_id_cancelled");
    expect(vault.isUnlocked()).toBe(false);
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

  test.skipIf(process.platform !== "darwin")("a swapped helper never runs: the bytes are checked before every start", async () => {
    const fake = join(dir, "helper.sh");
    const script = `#!/bin/sh\necho '{"ready":true}'\nwhile read -r line; do id=$(echo "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/'); echo "{\\"id\\":$id,\\"ok\\":true,\\"result\\":{\\"available\\":true}}"; done\n`;
    writeFileSync(fake, script, { mode: 0o755 });
    process.env.GODMODE_COMPUTER_HELPER = fake;
    try {
      expect(await realDeps.available()).toBe(true);
      const root = join(dir, "bin", "touch-id");
      const binary = join(root, readdirSync(root)[0]!, "Contents", "MacOS", "godmode-computer");
      expect(readFileSync(binary, "utf8")).toBe(script);

      writeFileSync(binary, "#!/bin/sh\necho planted > /dev/null\n");
      expect(await realDeps.available()).toBe(true);
      expect(readFileSync(binary, "utf8")).toBe(script);
    } finally {
      delete process.env.GODMODE_COMPUTER_HELPER;
    }
  });

  test("locked vault can't be sealed", async () => {
    vault.lock();
    expect(await code(enableTouchId())).toBe("vault_locked");
  });
});
