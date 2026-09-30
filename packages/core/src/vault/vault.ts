import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { VaultStatus } from "@godmode/shared";
import { config } from "../config";
import { getMeta, setMeta, deleteMeta, get, run, all, tx } from "../db";
import { bus } from "../events/bus";
import { getSettings } from "../services/settings";
import { logger, setSecretMasker } from "../log";
import { badRequest, locked, now } from "../util";
import { decrypt, deriveKey, encrypt, newKdfParams, randomKey, sha256, type KdfParams } from "./crypto";

const log = logger("vault");

const KEYCHAIN_SERVICE = "godmode-bot";

let dek: Buffer | null = null;
let lastActivity = Date.now();
let autoLockTimer: ReturnType<typeof setInterval> | null = null;
let autoLockMinutes = 0;

/** Values we know are secrets — used to redact them from transcripts and logs. */
const knownSecrets = new Set<string>();

function keychainName(): string {
  return `vault-dek-${sha256(config().dataDir).slice(0, 16)}`;
}

function keyFilePath(): string {
  return join(config().dataDir, ".vault-key");
}

export function isInitialized(): boolean {
  return getMeta("vault.wrapped_dek") !== null;
}

export function isUnlocked(): boolean {
  return dek !== null;
}

export function status(): VaultStatus {
  return {
    initialized: isInitialized(),
    unlocked: isUnlocked(),
    rememberDevice: getMeta("vault.remember_device") === "1",
    autoLockMinutes,
  };
}

function emitStatus() {
  bus.emit({ type: "vault.status", status: status() });
}

export function touch() {
  lastActivity = Date.now();
}

export function setAutoLock(minutes: number) {
  autoLockMinutes = Math.max(0, minutes | 0);
  if (autoLockTimer) clearInterval(autoLockTimer);
  autoLockTimer = null;
  if (autoLockMinutes > 0) {
    autoLockTimer = setInterval(() => {
      if (dek && Date.now() - lastActivity > autoLockMinutes * 60_000) {
        log.info("auto-locking vault after inactivity");
        lock();
      }
    }, 30_000);
  }
}

/** Create a new vault with a passphrase. */
export async function setup(passphrase: string, rememberDevice: boolean): Promise<VaultStatus> {
  if (isInitialized()) throw badRequest("Vault already initialized");
  validatePassphrase(passphrase);
  const kdf = newKdfParams();
  const kek = deriveKey(passphrase, kdf);
  const newDek = randomKey();
  setMeta("vault.kdf", JSON.stringify(kdf));
  setMeta("vault.wrapped_dek", encrypt(kek, newDek.toString("base64"), "vault.dek"));
  setMeta("vault.created_at", now());
  setMeta("vault.canary", encrypt(newDek, "ok", "vault.canary"));
  dek = newDek;
  touch();
  await setRememberDevice(rememberDevice);
  emitStatus();
  return status();
}

function validatePassphrase(p: string) {
  if (typeof p !== "string" || p.length < 8) throw badRequest("Passphrase must be at least 8 characters");
}

export async function unlock(passphrase: string): Promise<VaultStatus> {
  if (!isInitialized()) throw badRequest("Vault not initialized");
  const kdf = JSON.parse(getMeta("vault.kdf")!) as KdfParams;
  const kek = deriveKey(passphrase, kdf);
  try {
    dek = Buffer.from(decrypt(kek, getMeta("vault.wrapped_dek")!, "vault.dek"), "base64");
  } catch {
    throw badRequest("Wrong passphrase");
  }
  touch();
  loadKnownSecrets();
  emitStatus();
  return status();
}

export function lock() {
  if (dek) dek.fill(0);
  dek = null;
  knownSecrets.clear();
  emitStatus();
}

export async function changePassphrase(current: string, next: string) {
  validatePassphrase(next);
  const kdf = JSON.parse(getMeta("vault.kdf")!) as KdfParams;
  let unwrapped: Buffer;
  try {
    unwrapped = Buffer.from(decrypt(deriveKey(current, kdf), getMeta("vault.wrapped_dek")!, "vault.dek"), "base64");
  } catch {
    throw badRequest("Current passphrase is wrong");
  }
  const newKdf = newKdfParams();
  const wrapped = encrypt(deriveKey(next, newKdf), unwrapped.toString("base64"), "vault.dek");
  // Both values must change together — a crash in between would make the vault unrecoverable.
  tx(() => {
    setMeta("vault.kdf", JSON.stringify(newKdf));
    setMeta("vault.wrapped_dek", wrapped);
  });
  // Never implicitly unlock a locked vault; only refresh the in-memory key if it was already unlocked.
  if (!dek) unwrapped.fill(0);
}

/** Store (or forget) the DEK in the OS keychain so the vault unlocks automatically on this device. */
export async function setRememberDevice(remember: boolean) {
  if (remember) {
    if (!dek) throw locked();
    const value = dek.toString("base64");
    let stored = false;
    try {
      await Bun.secrets.set({ service: KEYCHAIN_SERVICE, name: keychainName(), value });
      stored = true;
      setMeta("vault.remember_method", "keychain");
    } catch (err) {
      log.warn("OS keychain unavailable, falling back to protected key file", err);
    }
    if (!stored) {
      writeFileSync(keyFilePath(), value, { mode: 0o600 });
      try {
        if (process.platform !== "win32") chmodSync(keyFilePath(), 0o600);
      } catch {
        /* ignore */
      }
      setMeta("vault.remember_method", "file");
    }
    setMeta("vault.remember_device", "1");
  } else {
    try {
      await Bun.secrets.delete({ service: KEYCHAIN_SERVICE, name: keychainName() });
    } catch {
      /* ignore */
    }
    if (existsSync(keyFilePath())) unlinkSync(keyFilePath());
    setMeta("vault.remember_device", "0");
    deleteMeta("vault.remember_method");
  }
  emitStatus();
}

/** Try to unlock from the OS keychain at startup. */
export async function tryAutoUnlock(): Promise<boolean> {
  if (!isInitialized() || getMeta("vault.remember_device") !== "1") return false;
  let value: string | null = null;
  try {
    if (getMeta("vault.remember_method") === "file") {
      if (existsSync(keyFilePath())) value = readFileSync(keyFilePath(), "utf8").trim();
    } else {
      value = await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name: keychainName() });
    }
  } catch (err) {
    log.warn("auto-unlock failed", err);
  }
  if (!value) return false;
  const candidate = Buffer.from(value, "base64");
  // Verify the key by decrypting a canary.
  const canary = getMeta("vault.canary");
  if (canary) {
    try {
      decrypt(candidate, canary, "vault.canary");
    } catch {
      log.warn("remembered vault key is invalid");
      return false;
    }
  }
  dek = candidate;
  touch();
  loadKnownSecrets();
  emitStatus();
  log.info("vault auto-unlocked from device keychain");
  return true;
}

function requireKey(): Buffer {
  if (!dek) throw locked();
  touch();
  if (!getMeta("vault.canary")) setMeta("vault.canary", encrypt(dek, "ok", "vault.canary"));
  return dek;
}

/** Encrypt a secret field. `context` binds ciphertext to its location (AAD), e.g. "credentials.password:<id>". */
export function seal(plaintext: string, context: string): string {
  const key = requireKey();
  rememberSecret(plaintext);
  return encrypt(key, plaintext, context);
}

export function open(ciphertext: string, context: string): string {
  const key = requireKey();
  return decrypt(key, ciphertext, context);
}

export function sealOptional(plaintext: string | null | undefined, context: string): string | null {
  if (plaintext == null || plaintext === "") return null;
  return seal(plaintext, context);
}

export function openOptional(ciphertext: string | null | undefined, context: string): string | null {
  if (!ciphertext) return null;
  return open(ciphertext, context);
}

/** Raw DEK access for backup export/import (re-encryption). */
export function exportKeyForBackup(): Buffer {
  return Buffer.from(requireKey());
}

/** Replace the vault with a restored one (backup import). */
export function importVaultMeta(meta: { kdf: string; wrappedDek: string; canary: string | null }) {
  setMeta("vault.kdf", meta.kdf);
  setMeta("vault.wrapped_dek", meta.wrappedDek);
  if (meta.canary) setMeta("vault.canary", meta.canary);
  else deleteMeta("vault.canary");
  lock();
}

export function vaultMetaForBackup() {
  return {
    kdf: getMeta("vault.kdf"),
    wrappedDek: getMeta("vault.wrapped_dek"),
    canary: getMeta("vault.canary"),
  };
}

/* ------------------------------------------------------------------ */
/* App secrets (API keys etc.)                                          */
/* ------------------------------------------------------------------ */

export function setAppSecret(key: string, value: string | null) {
  if (value == null || value === "") {
    run("DELETE FROM secrets WHERE key = ?", key);
    return;
  }
  const enc = seal(value, `secrets:${key}`);
  run(
    "INSERT INTO secrets (key, value_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at",
    key,
    enc,
    now(),
  );
}

export function getAppSecret(key: string): string | null {
  const row = get<{ value_enc: string }>("SELECT value_enc FROM secrets WHERE key = ?", key);
  if (!row) return null;
  return open(row.value_enc, `secrets:${key}`);
}

export function hasAppSecret(key: string): boolean {
  return get<{ key: string }>("SELECT key FROM secrets WHERE key = ?", key) !== null;
}

/* ------------------------------------------------------------------ */
/* Redaction                                                             */
/* ------------------------------------------------------------------ */

export function rememberSecret(value: string | null | undefined) {
  if (value && value.length >= 6) knownSecrets.add(value);
}

/** Remember every value of an env/header map, plus the token of "Bearer <token>"-style auth values. */
export function rememberSecretValues(values: Record<string, unknown>) {
  for (const value of Object.values(values)) {
    if (typeof value !== "string") continue;
    rememberSecret(value);
    rememberSecret(/^(?:bearer|basic|token|bot|key|apikey)\s+(\S+)$/i.exec(value.trim())?.[1]);
  }
}

function loadKnownSecrets() {
  if (!dek) return;
  try {
    for (const row of all<{ id: string; password_enc: string | null }>("SELECT id, password_enc FROM credentials")) {
      if (row.password_enc) {
        try {
          rememberSecret(decrypt(dek, row.password_enc, `credentials.password:${row.id}`));
        } catch {
          /* ignore */
        }
      }
    }
    for (const row of all<{ id: string; secret_enc: string }>("SELECT id, secret_enc FROM totp")) {
      try {
        rememberSecret(decrypt(dek, row.secret_enc, `totp.secret:${row.id}`));
      } catch {
        /* ignore */
      }
    }
    for (const row of all<{ key: string; value_enc: string }>("SELECT key, value_enc FROM secrets")) {
      try {
        rememberSecret(decrypt(dek, row.value_enc, `secrets:${row.key}`));
      } catch {
        /* ignore */
      }
    }
    // Custom MCP servers: env + headers are sealed as one JSON object each (see integrations/mcpServers.ts).
    for (const row of all<{ id: string; env_enc: string | null; headers_enc: string | null }>("SELECT id, env_enc, headers_enc FROM mcp_servers")) {
      for (const [enc, context] of [
        [row.env_enc, `mcp_servers.env:${row.id}`],
        [row.headers_enc, `mcp_servers.headers:${row.id}`],
      ] as const) {
        if (!enc) continue;
        try {
          const parsed: unknown = JSON.parse(decrypt(dek, enc, context));
          if (parsed && typeof parsed === "object") rememberSecretValues(parsed as Record<string, unknown>);
        } catch {
          /* ignore */
        }
      }
    }
    for (const row of all<{ id: string; key_enc: string | null }>("SELECT id, key_enc FROM api_tools")) {
      if (!row.key_enc) continue;
      try {
        rememberSecret(decrypt(dek, row.key_enc, `api_tools.key:${row.id}`));
      } catch {
        /* ignore */
      }
    }
    for (const row of all<{ id: string; password_enc: string | null; private_key_enc: string | null; passphrase_enc: string | null }>(
      "SELECT id, password_enc, private_key_enc, passphrase_enc FROM ssh_servers",
    )) {
      for (const [enc, field] of [
        [row.password_enc, "password"],
        [row.private_key_enc, "private_key"],
        [row.passphrase_enc, "passphrase"],
      ] as const) {
        if (!enc) continue;
        try {
          rememberSecret(decrypt(dek, enc, `ssh_servers.${field}:${row.id}`));
        } catch {
          /* ignore */
        }
      }
    }
    for (const row of all<{ id: string; secrets_enc: string | null }>("SELECT id, secrets_enc FROM messaging_connections")) {
      if (!row.secrets_enc) continue;
      try {
        const parsed: unknown = JSON.parse(decrypt(dek, row.secrets_enc, `messaging_connections.secrets:${row.id}`));
        if (parsed && typeof parsed === "object") rememberSecretValues(parsed as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    log.warn("could not load secrets for redaction", err);
  }
}

/** Replace every known secret value in `text` with a mask. */
/** The text contains a secret Godmode knows (a password, 2FA secret, API key) — regardless of the redaction setting. */
export function containsSecret(text: string): boolean {
  for (const secret of knownSecrets) if (secret.length >= 8 && text.includes(secret)) return true;
  return false;
}

export function redact(text: string): string {
  if (!text || knownSecrets.size === 0 || !getSettings().security.redactSecrets) return text;
  return maskKnownSecrets(text);
}

/** `redact` regardless of the setting: the diagnostic log is meant to be shared. */
function maskKnownSecrets(text: string): string {
  if (!text || knownSecrets.size === 0) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("••••••••");
  }
  return out;
}

setSecretMasker(maskKnownSecrets);
