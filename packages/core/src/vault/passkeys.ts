/**
 * Passkeys of the Godmode browser (browser/passkeys.ts). The private key is sealed with
 * vault.seal(value, `passkeys.private_key:<id>`); site, user and dates stay in clear so lists work while the vault is locked.
 * A passkey is keyed by its site (rp id) and WebAuthn credential id: a site that registers the same credential again updates it.
 * It belongs to the browser profile it was created in, like the profile's cookies: an agent's own profile and the human's
 * never sign in with each other's accounts. Its workspace (the profile's) only sorts the vault's list.
 */
import type { Passkey } from "@godmode/shared";
import { all, bool, get, insert, run, update } from "../db";
import { bus } from "../events/bus";
import { audit } from "../services/audit";
import { locked, newId, notFound, now } from "../util";
import { matchesSearch, scopeCondition, type ScopeFilter } from "./credentials";
import * as vault from "./vault";

interface PasskeyRow {
  id: string;
  workspace_id: string | null;
  rp_id: string;
  credential_id: string;
  user_handle: string | null;
  user_name: string;
  user_display_name: string;
  private_key_enc: string;
  sign_count: number;
  backup_eligible: number;
  backup_state: number;
  profile_id: string | null;
  created_by_agent_id: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A passkey as Chrome's WebAuthn domain takes and reports it (CDP WebAuthn.Credential). */
export interface WebAuthnCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  backupEligibility?: boolean;
  backupState?: boolean;
  userName?: string;
  userDisplayName?: string;
}

export type Credential = WebAuthnCredential & { rpId: string };

const keyContext = (id: string) => `passkeys.private_key:${id}`;

function toModel(r: PasskeyRow): Passkey {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    rpId: r.rp_id,
    userName: r.user_name,
    userDisplayName: r.user_display_name,
    profileId: r.profile_id,
    createdByAgentId: r.created_by_agent_id,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listPasskeys(opts: { workspaceId?: ScopeFilter; search?: string } = {}): Passkey[] {
  const scope = scopeCondition(opts.workspaceId);
  return all<PasskeyRow>(`SELECT * FROM passkeys WHERE ${scope.sql} ORDER BY rp_id COLLATE NOCASE, user_name COLLATE NOCASE`, ...scope.params)
    .filter((r) => matchesSearch(opts.search, [r.rp_id, r.user_name, r.user_display_name]))
    .map(toModel);
}

export function getPasskey(id: string): Passkey {
  const row = get<PasskeyRow>("SELECT * FROM passkeys WHERE id = ?", id);
  if (!row) throw notFound("Passkey");
  return toModel(row);
}

export function deletePasskey(id: string): void {
  if (run("DELETE FROM passkeys WHERE id = ?", id).changes === 0) throw notFound("Passkey");
  bus.changed("passkeys");
}

/** The profile's passkeys whose site is the host or one of its parents (a passkey for github.com works on gist.github.com). */
export function passkeysForHost(host: string, profileId: string): Passkey[] {
  const h = host.toLowerCase();
  return all<PasskeyRow>("SELECT * FROM passkeys WHERE profile_id = ? ORDER BY last_used_at DESC", profileId)
    .filter((r) => h === r.rp_id || h.endsWith(`.${r.rp_id}`))
    .map(toModel);
}

/**
 * What the profile's browser loads into its virtual authenticators, most recently used first (with several accounts
 * on one site, the authenticator answers with the first). Null while the vault is locked; a row that can't be opened
 * (sealed by another vault) is skipped.
 */
export function passkeysForBrowser(profileId: string): Credential[] | null {
  if (!vault.isUnlocked()) return null;
  const rows = all<PasskeyRow>("SELECT * FROM passkeys WHERE profile_id = ? ORDER BY last_used_at DESC, created_at DESC", profileId);
  const out: Credential[] = [];
  for (const r of rows) {
    let privateKey: string;
    try {
      privateKey = vault.open(r.private_key_enc, keyContext(r.id));
    } catch {
      continue;
    }
    out.push({
      credentialId: r.credential_id,
      isResidentCredential: true,
      rpId: r.rp_id,
      privateKey,
      ...(r.user_handle ? { userHandle: r.user_handle } : {}),
      signCount: r.sign_count,
      backupEligibility: bool(r.backup_eligible),
      backupState: bool(r.backup_state),
      userName: r.user_name,
      userDisplayName: r.user_display_name,
    });
  }
  return out;
}

function rowOf(rpId: string, credentialId: string): PasskeyRow | null {
  return get<PasskeyRow>("SELECT * FROM passkeys WHERE rp_id = ? AND credential_id = ?", rpId, credentialId);
}

/** A site registered a passkey in the browser: keep it (or update the one it replaced). Returns its id. */
export function savePasskey(
  credential: Credential,
  meta: { workspaceId: string | null; profileId: string | null; agentId: string | null },
): string {
  if (!vault.isUnlocked()) throw locked();
  const ts = now();
  const existing = rowOf(credential.rpId, credential.credentialId);
  const fields = {
    user_handle: credential.userHandle ?? null,
    user_name: credential.userName ?? "",
    user_display_name: credential.userDisplayName ?? "",
    sign_count: credential.signCount ?? 0,
    backup_eligible: credential.backupEligibility === false ? 0 : 1,
    backup_state: credential.backupState === false ? 0 : 1,
    updated_at: ts,
  };
  if (existing) {
    update("passkeys", existing.id, { ...fields, private_key_enc: vault.seal(credential.privateKey, keyContext(existing.id)) });
    bus.changed("passkeys");
    return existing.id;
  }
  const id = newId("pk");
  insert("passkeys", {
    id,
    workspace_id: meta.workspaceId,
    rp_id: credential.rpId,
    credential_id: credential.credentialId,
    private_key_enc: vault.seal(credential.privateKey, keyContext(id)),
    profile_id: meta.profileId,
    created_by_agent_id: meta.agentId,
    last_used_at: ts,
    created_at: ts,
    ...fields,
  });
  bus.changed("passkeys");
  return id;
}

/** A site signed in with the passkey: remember the authenticator's counter so every browser continues from it. */
export function recordPasskeyUse(rpId: string, credentialId: string, signCount: number): boolean {
  const ts = now();
  const changed = run("UPDATE passkeys SET sign_count = MAX(sign_count, ?), last_used_at = ?, updated_at = ? WHERE rp_id = ? AND credential_id = ?", signCount, ts, ts, rpId, credentialId).changes > 0;
  if (changed) bus.changed("passkeys");
  return changed;
}

/** A site said it no longer knows the passkey (WebAuthn signalUnknownCredential): drop it like a passkey manager would. */
export function forgetPasskey(rpId: string, credentialId: string): boolean {
  const row = rowOf(rpId, credentialId);
  if (!row) return false;
  run("DELETE FROM passkeys WHERE id = ?", row.id);
  audit("browser", "passkey.forget", row.id, { rpId, userName: row.user_name, reason: "the site no longer knows it" });
  bus.changed("passkeys");
  return true;
}

/** A site updated the account's name on the passkey (WebAuthn signalCurrentUserDetails). */
export function renamePasskeyUser(rpId: string, credentialId: string, userName: string, userDisplayName: string): boolean {
  const changed = run("UPDATE passkeys SET user_name = ?, user_display_name = ?, updated_at = ? WHERE rp_id = ? AND credential_id = ?", userName, userDisplayName, now(), rpId, credentialId).changes > 0;
  if (changed) bus.changed("passkeys");
  return changed;
}
