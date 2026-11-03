/**
 * Touch ID for the vault (macOS). The vault key is sealed to a Secure Enclave key that only works after a fingerprint,
 * so nothing on this computer opens it without the finger: not the API token, not an agent, not the Mac password. The
 * seal is useless on another Mac, stays out of backups, and the Godmode password always keeps working.
 */
import { createECDH, hkdfSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TouchIdStatus, VaultStatus } from "@godmode/shared";
import { embeddedHelperBytes, HelperError, HELPER_NAME, resolveHelperBinary, spawnHelper, type NativeHelper } from "../computer/helper";
import { config } from "../config";
import { deleteMeta, getMeta, setMeta } from "../db";
import { hostApp } from "../services/permissions";
import { getSettings } from "../services/settings";
import { HttpError } from "../util";
import { decrypt, encrypt } from "./crypto";
import { exportKeyForBackup, isUnlocked, isVaultKey, lockCount, status, useRememberedKey } from "./vault";

const META_KEY = "vault.touch_id";
const CONTEXT = "vault.touch_id";
const HKDF_INFO = "godmode vault touch id";
/** A little longer than the helper keeps the prompt open. */
const PROMPT_TIMEOUT_MS = 65_000;

interface Sealed {
  /** The Secure Enclave key, wrapped so only this Mac's enclave can use it. */
  key: string;
  /** The other half of the key agreement; its private half is gone once the vault key is sealed. */
  peer: string;
  box: string;
}

/**
 * macOS names the program asking in the prompt, with its icon. A bare helper would read "godmode-computer-3fa9…", so
 * the helper runs from a small app bundle carrying the name and icon of the Godmode this is. Agents run as the same
 * user and could swap a file here, and a fake helper would hand over the vault key: its bytes are compared with the
 * ones inside the signed core before every start.
 */
async function promptBundle(helper: string): Promise<string> {
  const bytes = (await embeddedHelperBytes()) ?? readFileSync(helper);
  const host = hostApp();
  const ours = host.bundleId ? host.path : null;
  const name = (ours && host.name) || "Godmode";
  const contents = join(config().dataDir, "bin", "touch-id", `${name}.app`, "Contents");
  const binary = join(contents, "MacOS", HELPER_NAME);
  mkdirSync(join(contents, "MacOS"), { recursive: true, mode: 0o700 });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const entries = { CFBundleName: escaped, CFBundleDisplayName: escaped, CFBundleIdentifier: `${host.bundleId ?? "godmode"}.touchid`, CFBundleExecutable: HELPER_NAME, CFBundlePackageType: "APPL", CFBundleIconFile: "icon" };
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(entries)
      .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
      .join("")}<key>LSUIElement</key><true/></dict></plist>\n`,
  );
  const icon = ours && join(ours, "Contents", "Resources", "icon.icns");
  if (icon && existsSync(icon)) copyFileSync(icon, join(contents, "Resources", "icon.icns"));
  const same = existsSync(binary) && Buffer.compare(readFileSync(binary), bytes) === 0;
  if (!same) {
    const tmp = `${binary}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, binary);
  }
  return binary;
}

async function withHelper<T>(work: (helper: NativeHelper) => Promise<T>): Promise<T> {
  const helper = await resolveHelperBinary();
  if (!helper) throw new HelperError("Touch ID isn't available", "touch_id_unavailable");
  const path = await promptBundle(helper);
  const running = await spawnHelper(path, [], HELPER_NAME, path, 10_000);
  try {
    return await work(running);
  } finally {
    await running.close();
  }
}

/** What it takes to reach the enclave: swapped in tests. */
export const touchIdDeps = {
  supported: () => process.platform === "darwin" && config().role !== "runner",
  available: () => withHelper(async (h) => (await h.call<{ available: boolean }>("touchIdStatus")).available),
  createKey: () => withHelper((h) => h.call<{ key: string; publicKey: string }>("touchIdCreate")),
  derive: (key: string, peer: string, reason: string) => withHelper(async (h) => (await h.call<{ secret: string }>("touchIdDerive", { key, peer, reason }, PROMPT_TIMEOUT_MS)).secret),
};

function failure(code: string, message: string): HttpError {
  return new HttpError(409, message, code);
}

const invalid = () => failure("touch_id_invalid", "Touch ID can't open the vault anymore. Unlock with your Godmode password and turn it on again.");

function wrappingKey(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), HKDF_INFO, 32));
}

function seal(key: string, publicKey: string, dek: Buffer): Sealed {
  const ours = createECDH("prime256v1");
  ours.generateKeys();
  const box = encrypt(wrappingKey(ours.computeSecret(Buffer.from(publicKey, "base64"))), dek.toString("base64"), CONTEXT);
  return { key, peer: ours.getPublicKey().toString("base64"), box };
}

function saved(): Sealed | null {
  const raw = getMeta(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Sealed;
  } catch {
    deleteMeta(META_KEY);
    return null;
  }
}

const REASONS = {
  unlock: { de: "den Godmode-Tresor entsperren", en: "unlock the Godmode vault" },
  confirm: { de: "bestätigen, dass du es bist", en: "confirm it's you" },
};

function reason(purpose: keyof typeof REASONS): string {
  const { language } = getSettings().general;
  const german = language === "de" || (language === "system" && Intl.DateTimeFormat().resolvedOptions().locale.startsWith("de"));
  return REASONS[purpose][german ? "de" : "en"];
}

let prompting = false;

/** Asks for the finger, one prompt at a time, and returns the vault key (base64) the seal holds. */
async function openSeal(sealed: Sealed, purpose: keyof typeof REASONS): Promise<string> {
  if (prompting) throw failure("touch_id_busy", "Touch ID is already waiting for a finger");
  prompting = true;
  let secret: string;
  try {
    secret = await touchIdDeps.derive(sealed.key, sealed.peer, reason(purpose));
  } catch (err) {
    if (err instanceof HelperError && err.code === "touch_id_invalid") throw invalid();
    if (err instanceof HelperError && err.code.startsWith("touch_id_")) throw failure(err.code, err.message);
    // A helper that died or timed out says nothing about the seal: it stays.
    throw failure("touch_id_unavailable", "Touch ID isn't available right now");
  } finally {
    prompting = false;
  }
  try {
    return decrypt(wrappingKey(Buffer.from(secret, "base64")), sealed.box, CONTEXT);
  } catch {
    throw invalid();
  }
}

export async function touchIdStatus(): Promise<TouchIdStatus> {
  if (!touchIdDeps.supported()) return { available: false, enabled: false };
  const available = await touchIdDeps.available().catch(() => false);
  return { available, enabled: saved() !== null };
}

export async function enableTouchId(): Promise<void> {
  const dek = exportKeyForBackup();
  try {
    if (!touchIdDeps.supported()) throw failure("touch_id_unavailable", "Touch ID isn't available on this computer");
    const created = await touchIdDeps.createKey().catch(() => {
      throw failure("touch_id_unavailable", "Touch ID isn't available right now");
    });
    const sealed = seal(created.key, created.publicKey, dek);
    // Only a seal that really opened with this finger may stand in for the password.
    if ((await openSeal(sealed, "unlock")) !== dek.toString("base64")) throw invalid();
    setMeta(META_KEY, JSON.stringify(sealed));
  } finally {
    dek.fill(0);
  }
}

export function disableTouchId(): void {
  deleteMeta(META_KEY);
}

export async function unlockWithTouchId(): Promise<VaultStatus> {
  if (isUnlocked()) return status();
  const sealed = saved();
  if (!sealed) throw failure("touch_id_off", "Touch ID is off");
  const locks = lockCount();
  let value: string;
  try {
    value = await openSeal(sealed, "unlock");
  } catch (err) {
    // New fingerprints or a replaced vault: this seal never opens again, so stop offering it.
    if (err instanceof HttpError && err.code === "touch_id_invalid") deleteMeta(META_KEY);
    throw err;
  }
  // A prompt left open across a lock doesn't undo that lock.
  if (locks !== lockCount()) throw failure("touch_id_cancelled", "Touch ID was cancelled");
  if (!isUnlocked() && !useRememberedKey(value)) {
    deleteMeta(META_KEY);
    throw invalid();
  }
  return status();
}

/**
 * The finger in place of the password for a reveal grant. The opened key must be the vault's own, so a seal planted in
 * the database for another key confirms nothing. The lock state stays.
 */
export async function confirmWithTouchId(): Promise<void> {
  const sealed = saved();
  if (!sealed) throw failure("touch_id_off", "Touch ID is off");
  let value: string;
  try {
    value = await openSeal(sealed, "confirm");
  } catch (err) {
    if (err instanceof HttpError && err.code === "touch_id_invalid") deleteMeta(META_KEY);
    throw err;
  }
  if (!isVaultKey(value)) {
    deleteMeta(META_KEY);
    throw invalid();
  }
}
