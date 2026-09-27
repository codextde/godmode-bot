/**
 * TOTP (Google Authenticator compatible) 2FA entries.
 * Secrets are stored as canonical base32, encrypted with vault.seal(secret, `totp.secret:<id>`).
 */
import { createHmac } from "node:crypto";
import type { Agent, TotpAlgorithm, TotpCode, TotpEntry, TotpImportInput, TotpImportResult, TotpInput } from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, badRequest, domainMatches, forbidden, hostnameOf, locked, newId, notFound, now, parseJson } from "../util";
import * as vault from "./vault";
import {
  agentScopeCondition,
  assertWorkspace,
  dropIncompatibleLinks,
  inAgentScope,
  linkCredentialTotp,
  matchesSearch,
  scopeCondition,
  unlinkTotp,
} from "./credentials";
import { base32Decode, normalizeBase32Secret, parseOtpUri, type ParsedOtpAccount, type ParsedOtpItem } from "./otpauth";

const log = logger("totp");

interface TotpRow {
  id: string;
  workspace_id: string | null;
  issuer: string;
  account_name: string;
  secret_enc: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  credential_id: string | null;
  icon: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const secretContext = (id: string) => `totp.secret:${id}`;

const isLockedError = (err: unknown) => err instanceof HttpError && err.status === 423;

/* ------------------------------------------------------------------ */
/* RFC 6238                                                             */
/* ------------------------------------------------------------------ */

const HMAC_ALGORITHMS: Record<TotpAlgorithm, string> = { SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" };

function checkParams(algorithm: TotpAlgorithm, digits: number, period: number): void {
  if (!Object.hasOwn(HMAC_ALGORITHMS, algorithm)) throw badRequest(`Unsupported TOTP algorithm "${String(algorithm).slice(0, 20)}"`);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw badRequest("TOTP digits must be 6, 7 or 8");
  if (!Number.isInteger(period) || period < 1 || period > 3600) throw badRequest("TOTP period must be between 1 and 3600 seconds");
}

/** RFC 4226 HOTP with dynamic truncation. */
function hotp(key: Uint8Array, counter: number, algorithm: TotpAlgorithm, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(HMAC_ALGORITHMS[algorithm], key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 TOTP code for a base32 secret. `time` is Unix time in seconds (default: now). */
export function generateTotp(
  secretBase32: string,
  opts: { algorithm?: TotpAlgorithm; digits?: number; period?: number; time?: number } = {},
): string {
  const algorithm = opts.algorithm ?? "SHA1";
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  checkParams(algorithm, digits, period);
  const key = base32Decode(secretBase32);
  if (key.length === 0) throw badRequest("TOTP secret is empty");
  const time = opts.time ?? Date.now() / 1000;
  if (!Number.isFinite(time) || time < 0) throw badRequest("Invalid time");
  return hotp(key, Math.floor(time / period), algorithm, digits);
}

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

function toModel(r: TotpRow): TotpEntry {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    issuer: r.issuer,
    accountName: r.account_name,
    algorithm: r.algorithm,
    digits: r.digits,
    period: r.period,
    credentialId: r.credential_id,
    icon: r.icon,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRow(id: string): TotpRow {
  const row = get<TotpRow>("SELECT * FROM totp WHERE id = ?", id);
  if (!row) throw notFound("TOTP entry");
  return row;
}

function agentMayUse(agent: Agent, r: TotpRow): boolean {
  if (!inAgentScope(agent, r.workspace_id)) return false;
  const allowed = agent.permissions?.totpIds ?? null;
  return allowed === null || allowed.includes(r.id);
}

function requireLabel(issuer: string, accountName: string): void {
  if (!issuer && !accountName) throw badRequest("Issuer or account name is required");
}

function insertTotp(workspaceId: string | null, account: ParsedOtpAccount): string {
  const id = newId("totp");
  const ts = now();
  insert("totp", {
    id,
    workspace_id: workspaceId,
    issuer: account.issuer,
    account_name: account.accountName,
    secret_enc: vault.seal(account.secret, secretContext(id)),
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
    credential_id: null,
    icon: null,
    last_used_at: null,
    created_at: ts,
    updated_at: ts,
  });
  return id;
}

function codeFor(r: TotpRow, time: number): TotpCode {
  const secret = vault.open(r.secret_enc, secretContext(r.id));
  const code = generateTotp(secret, { algorithm: r.algorithm, digits: r.digits, period: r.period, time });
  return { id: r.id, code, remaining: r.period - (Math.floor(time) % r.period), period: r.period };
}

export function listTotp(opts: { workspaceId?: string | null | "all"; search?: string } = {}): TotpEntry[] {
  const scope = scopeCondition(opts.workspaceId);
  return all<TotpRow>(`SELECT * FROM totp WHERE ${scope.sql} ORDER BY issuer COLLATE NOCASE, account_name COLLATE NOCASE`, ...scope.params)
    .filter((r) => matchesSearch(opts.search, [r.issuer, r.account_name]))
    .map(toModel);
}

export function getTotp(id: string): TotpEntry {
  return toModel(getRow(id));
}

export function createTotp(input: TotpInput): TotpEntry {
  const issuer = (input.issuer ?? "").trim();
  const accountName = (input.accountName ?? "").trim();
  requireLabel(issuer, accountName);
  const account: ParsedOtpAccount = {
    issuer,
    accountName,
    secret: normalizeBase32Secret(input.secret ?? ""),
    algorithm: input.algorithm ?? "SHA1",
    digits: input.digits ?? 6,
    period: input.period ?? 30,
  };
  checkParams(account.algorithm, account.digits, account.period);
  const workspaceId = input.workspaceId ?? null;
  assertWorkspace(workspaceId);
  const id = tx(() => {
    const created = insertTotp(workspaceId, account);
    if (input.credentialId) linkCredentialTotp(input.credentialId, created);
    return created;
  });
  bus.changed("totp");
  if (input.credentialId) bus.changed("credentials");
  return getTotp(id);
}

export function updateTotp(id: string, input: Partial<TotpInput>): TotpEntry {
  const row = getRow(id);
  const patch: Record<string, string | number | null | undefined> = { updated_at: now() };
  const issuer = input.issuer !== undefined ? input.issuer.trim() : row.issuer;
  const accountName = input.accountName !== undefined ? input.accountName.trim() : row.account_name;
  requireLabel(issuer, accountName);
  if (input.issuer !== undefined) patch.issuer = issuer;
  if (input.accountName !== undefined) patch.account_name = accountName;

  const algorithm = input.algorithm ?? row.algorithm;
  const digits = input.digits ?? row.digits;
  const period = input.period ?? row.period;
  checkParams(algorithm, digits, period);
  patch.algorithm = algorithm;
  patch.digits = digits;
  patch.period = period;
  if (input.secret !== undefined) patch.secret_enc = vault.seal(normalizeBase32Secret(input.secret), secretContext(id));

  const workspaceChanged = input.workspaceId !== undefined && (input.workspaceId ?? null) !== row.workspace_id;
  if (workspaceChanged) {
    assertWorkspace(input.workspaceId);
    patch.workspace_id = input.workspaceId ?? null;
  }

  let credentialsChanged = false;
  tx(() => {
    update("totp", id, patch);
    if (workspaceChanged) credentialsChanged = dropIncompatibleLinks({ totpId: id }) || credentialsChanged;
    if (input.credentialId === null) {
      credentialsChanged = unlinkTotp(id) || credentialsChanged;
    } else if (input.credentialId !== undefined) {
      const current = get<{ credential_id: string | null }>("SELECT credential_id FROM totp WHERE id = ?", id)?.credential_id ?? null;
      if (input.credentialId !== current) {
        linkCredentialTotp(input.credentialId, id);
        credentialsChanged = true;
      }
    }
  });
  bus.changed("totp");
  if (credentialsChanged) bus.changed("credentials");
  return getTotp(id);
}

export function deleteTotp(id: string): void {
  getRow(id);
  const credentialsChanged = tx(() => {
    const changed = unlinkTotp(id);
    run("DELETE FROM totp WHERE id = ?", id);
    return changed;
  });
  bus.changed("totp");
  if (credentialsChanged) bus.changed("credentials");
}

/** Current codes for the given ids (or all). Unknown ids are ignored. Does not mark entries as used. */
export function currentCodes(ids?: string[]): TotpCode[] {
  if (ids && ids.length === 0) return [];
  if (!vault.isUnlocked()) throw locked();
  const wanted = ids ? new Set(ids) : null;
  const time = Date.now() / 1000;
  const out: TotpCode[] = [];
  for (const row of all<TotpRow>("SELECT * FROM totp ORDER BY issuer COLLATE NOCASE, account_name COLLATE NOCASE")) {
    if (wanted && !wanted.has(row.id)) continue;
    try {
      out.push(codeFor(row, time));
    } catch (err) {
      if (isLockedError(err)) throw err;
      log.warn(`could not compute code for TOTP entry ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

const dedupeKey = (issuer: string, accountName: string, secret: string) =>
  `${issuer.trim().toLowerCase()}\u0000${accountName.trim().toLowerCase()}\u0000${secret}`;

const exactScope = (workspaceId: string | null) =>
  workspaceId === null ? { sql: "workspace_id IS NULL", params: [] as string[] } : { sql: "workspace_id = ?", params: [workspaceId] };

/** Dedupe keys of the entries that already exist in exactly this scope. */
function existingKeys(workspaceId: string | null): Set<string> {
  const scope = exactScope(workspaceId);
  const keys = new Set<string>();
  for (const r of all<TotpRow>(`SELECT * FROM totp WHERE ${scope.sql}`, ...scope.params)) {
    try {
      keys.add(dedupeKey(r.issuer, r.account_name, vault.open(r.secret_enc, secretContext(r.id))));
    } catch (err) {
      if (isLockedError(err)) throw err;
      log.warn(`could not decrypt TOTP entry ${r.id} while checking for duplicates`);
    }
  }
  return keys;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does a TOTP issuer (e.g. "GitHub", "github.com", "Google") refer to this credential's site? */
function issuerMatchesCredential(issuer: string, cred: { name: string; url: string; domains: string }): boolean {
  const iss = issuer.trim().toLowerCase();
  const key = compact(iss);
  if (key.length < 2) return false;
  const hosts = [...parseJson<string[]>(cred.domains, []), cred.url ? hostnameOf(cred.url) : ""].filter(Boolean);
  const issuerHost = hostnameOf(iss);
  if (issuerHost.includes(".") && hosts.some((h) => domainMatches(issuerHost, h))) return true;
  for (const host of hosts) {
    const labels = host.split(".").slice(0, -1).map(compact);
    if (labels.some((l) => l === key || (key.length >= 5 && l.includes(key)))) return true;
  }
  const name = cred.name.toLowerCase();
  if (compact(name) === key) return true;
  return key.length >= 3 && new RegExp(`(^|[^a-z0-9])${escapeRegExp(iss)}($|[^a-z0-9])`).test(name);
}

/**
 * Pick the credential (same scope) an imported entry belongs to: its site matches the issuer and either its
 * username equals the account name, or it is the only matching credential. Ambiguity is judged over all
 * matching credentials, but a credential that already has a 2FA entry is never re-linked.
 */
function credentialForImport(workspaceId: string | null, account: ParsedOtpAccount): string | null {
  if (!account.issuer) return null;
  const scope = exactScope(workspaceId);
  const candidates = all<{ id: string; name: string; url: string; domains: string; username: string; totp_id: string | null }>(
    `SELECT id, name, url, domains, username, totp_id FROM credentials WHERE ${scope.sql} ORDER BY created_at`,
    ...scope.params,
  ).filter((c) => issuerMatchesCredential(account.issuer, c));
  const accountName = account.accountName.trim().toLowerCase();
  const byUsername = accountName ? candidates.filter((c) => c.username.trim().toLowerCase() === accountName) : [];
  const pick = byUsername.length === 1 ? byUsername[0] : byUsername.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
  return pick && pick.totp_id === null ? pick.id : null;
}

/** Parse otpauth:// and otpauth-migration:// (Google Authenticator export) URIs and store them. */
export function importTotpUris(input: TotpImportInput): TotpImportResult {
  const workspaceId = input.workspaceId ?? null;
  assertWorkspace(workspaceId);
  if (!vault.isUnlocked()) throw locked();
  const uris = input.uris
    .flatMap((u) => u.split(/\r?\n/))
    .map((u) => u.trim())
    .filter(Boolean);
  const skipped: TotpImportResult["skipped"] = [];
  const importedIds: string[] = [];
  let linked = false;

  tx(() => {
    const seen = existingKeys(workspaceId);
    for (const uri of uris) {
      let items: ParsedOtpItem[];
      try {
        items = parseOtpUri(uri);
      } catch (err) {
        skipped.push({ uri, reason: err instanceof HttpError ? err.message : "Could not parse URI" });
        continue;
      }
      for (const item of items) {
        if (!item.ok) {
          skipped.push({ uri, label: item.label, reason: item.reason });
          continue;
        }
        const account: ParsedOtpAccount = {
          ...item.account,
          issuer: item.account.issuer.slice(0, 200),
          accountName: item.account.accountName.slice(0, 512) || (item.account.issuer ? "" : "Unnamed account"),
        };
        const key = dedupeKey(account.issuer, account.accountName, account.secret);
        if (seen.has(key)) {
          skipped.push({ uri, label: item.label, reason: "already exists" });
          continue;
        }
        const id = insertTotp(workspaceId, account);
        seen.add(key);
        importedIds.push(id);
        const credentialId = credentialForImport(workspaceId, account);
        if (credentialId) {
          linkCredentialTotp(credentialId, id);
          linked = true;
        }
      }
    }
  });

  if (importedIds.length > 0) bus.changed("totp");
  if (linked) bus.changed("credentials");
  return { imported: importedIds.map(getTotp), skipped };
}

/* ------------------------------------------------------------------ */
/* Agent access                                                         */
/* ------------------------------------------------------------------ */

/** TOTP entries an agent may use (global + its workspace, filtered by permissions.totpIds). */
export function totpForAgent(agent: Agent): TotpEntry[] {
  const scope = agentScopeCondition(agent);
  return all<TotpRow>(`SELECT * FROM totp WHERE ${scope.sql} ORDER BY issuer COLLATE NOCASE, account_name COLLATE NOCASE`, ...scope.params)
    .filter((r) => agentMayUse(agent, r))
    .map(toModel);
}

/** Current code for an entry the agent may use (throws 403 otherwise). Updates lastUsedAt. Caller audits. */
export function codeForAgent(agent: Agent, totpId: string): TotpCode {
  const row = getRow(totpId);
  if (!agentMayUse(agent, row)) throw forbidden("This 2FA entry is not available to this agent");
  if (!vault.isUnlocked()) throw locked();
  const code = codeFor(row, Date.now() / 1000);
  run("UPDATE totp SET last_used_at = ? WHERE id = ?", now(), totpId);
  bus.changed("totp");
  return code;
}
