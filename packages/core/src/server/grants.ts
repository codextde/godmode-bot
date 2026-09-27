/**
 * Reveal grants: short-lived proof that the user just re-entered the vault passphrase. Revealing a stored secret, or
 * widening who can read secrets (agents with "reveal" access, remembering the vault key on this device), requires
 * one in the `x-godmode-grant` header, so the API token or a session cookie alone is not enough to read passwords.
 */
import type { Context } from "hono";
import { getMeta } from "../db";
import { HttpError, randomToken } from "../util";
import { decrypt, deriveKey, sha256, type KdfParams } from "../vault/crypto";

export const GRANT_HEADER = "x-godmode-grant";
export const GRANT_TTL_MS = 10 * 60_000;

/** sha256(grant) → expiry (epoch ms). In memory only: a restart invalidates every grant. */
const grants = new Map<string, number>();

/** Check the vault passphrase against the wrapped data key without touching the vault's lock state. */
export function verifyVaultPassphrase(passphrase: string): boolean {
  const kdf = getMeta("vault.kdf");
  const wrapped = getMeta("vault.wrapped_dek");
  if (!kdf || !wrapped) return false;
  try {
    const dek = Buffer.from(decrypt(deriveKey(passphrase, JSON.parse(kdf) as KdfParams), wrapped, "vault.dek"), "base64");
    dek.fill(0);
    return true;
  } catch {
    return false;
  }
}

export function issueGrant(): { grant: string; expiresAt: string } {
  const t = Date.now();
  for (const [key, expires] of grants) if (expires <= t) grants.delete(key);
  const grant = randomToken(32);
  const expires = t + GRANT_TTL_MS;
  grants.set(sha256(grant), expires);
  return { grant, expiresAt: new Date(expires).toISOString() };
}

export function isValidGrant(grant: string | null | undefined): boolean {
  if (!grant) return false;
  const key = sha256(grant);
  const expires = grants.get(key);
  if (expires === undefined) return false;
  if (expires <= Date.now()) {
    grants.delete(key);
    return false;
  }
  return true;
}

/** Throw 403 `grant_required` unless the request carries a valid reveal grant. */
export function requireGrant(c: Context): void {
  if (!isValidGrant(c.req.header(GRANT_HEADER))) {
    throw new HttpError(403, "Confirm with your vault passphrase to continue", "grant_required");
  }
}

/** Drop every grant (tests). */
export function clearGrants(): void {
  grants.clear();
}
