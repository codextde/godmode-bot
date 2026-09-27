/**
 * Credentials (website logins) stored in the vault.
 * Passwords/notes are encrypted with vault.seal(value, `credentials.password:<id>` / `credentials.notes:<id>`).
 * Metadata (name, url, domains, username, tags) is stored in clear so lists work while the vault is locked.
 *
 * A credential and a TOTP entry can be linked 1:1; the link is stored on both sides
 * (`credentials.totp_id` and `totp.credential_id`) and kept consistent by the helpers below.
 */
import type { Agent, Credential, CredentialInput } from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { badRequest, domainMatches, forbidden, hostnameOf, locked, newId, notFound, now, parseJson } from "../util";
import * as vault from "./vault";

interface CredentialRow {
  id: string;
  workspace_id: string | null;
  name: string;
  url: string;
  domains: string;
  username: string;
  password_enc: string | null;
  notes_enc: string | null;
  totp_id: string | null;
  /** totp_id, or null when it points at a TOTP entry that no longer exists (see ROW_SELECT) */
  linked_totp_id: string | null;
  tags: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Columns to read. The link is resolved against the totp table so a reference left dangling by an
 * out-of-band delete (e.g. a workspace cascade) never surfaces as a link.
 */
const ROW_SELECT = "*, (SELECT t.id FROM totp t WHERE t.id = credentials.totp_id) AS linked_totp_id";

const passwordContext = (id: string) => `credentials.password:${id}`;
const notesContext = (id: string) => `credentials.notes:${id}`;

/* ------------------------------------------------------------------ */
/* Scope helpers (shared with totp.ts)                                  */
/* ------------------------------------------------------------------ */

export type ScopeFilter = string | null | "all" | undefined;

/** SQL condition for a list scope: undefined/"all" = everything, null = global only, id = that workspace only. */
export function scopeCondition(workspaceId: ScopeFilter): { sql: string; params: string[] } {
  if (workspaceId === undefined || workspaceId === "all") return { sql: "1 = 1", params: [] };
  if (workspaceId === null) return { sql: "workspace_id IS NULL", params: [] };
  return { sql: "workspace_id = ?", params: [workspaceId] };
}

/** SQL condition for what an agent can see: global rows + rows of its own workspace. */
export function agentScopeCondition(agent: Agent): { sql: string; params: string[] } {
  if (!agent.workspaceId) return { sql: "workspace_id IS NULL", params: [] };
  return { sql: "(workspace_id IS NULL OR workspace_id = ?)", params: [agent.workspaceId] };
}

export function inAgentScope(agent: Agent, workspaceId: string | null): boolean {
  return workspaceId === null || workspaceId === agent.workspaceId;
}

/** Throws 404 when a (non-null) workspace id does not exist. */
export function assertWorkspace(workspaceId: string | null | undefined): void {
  if (workspaceId && !get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) throw notFound("Workspace");
}

/** Case-insensitive search: every whitespace-separated term must occur in at least one field. */
export function matchesSearch(search: string | undefined, fields: string[]): boolean {
  const terms = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields.join("\n").toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/* ------------------------------------------------------------------ */
/* Credential <-> TOTP link (shared with totp.ts)                       */
/* ------------------------------------------------------------------ */

/** A TOTP entry may back a credential only if it is visible wherever the credential is. */
function linkCompatible(credentialWorkspace: string | null, totpWorkspace: string | null): boolean {
  return totpWorkspace === null || totpWorkspace === credentialWorkspace;
}

/** Link a credential and a TOTP entry 1:1, clearing any previous link on either side. */
export function linkCredentialTotp(credentialId: string, totpId: string): void {
  const cred = get<{ workspace_id: string | null }>("SELECT workspace_id FROM credentials WHERE id = ?", credentialId);
  if (!cred) throw notFound("Credential");
  const totp = get<{ workspace_id: string | null }>("SELECT workspace_id FROM totp WHERE id = ?", totpId);
  if (!totp) throw notFound("TOTP entry");
  if (!linkCompatible(cred.workspace_id, totp.workspace_id)) {
    throw badRequest("The 2FA entry must be global or belong to the same workspace as the login");
  }
  const ts = now();
  tx(() => {
    run("UPDATE totp SET credential_id = NULL, updated_at = ? WHERE credential_id = ? AND id != ?", ts, credentialId, totpId);
    run("UPDATE credentials SET totp_id = NULL, updated_at = ? WHERE totp_id = ? AND id != ?", ts, totpId, credentialId);
    run("UPDATE credentials SET totp_id = ?, updated_at = ? WHERE id = ?", totpId, ts, credentialId);
    run("UPDATE totp SET credential_id = ?, updated_at = ? WHERE id = ?", credentialId, ts, totpId);
  });
}

/** Remove every link involving this credential. Returns true if a TOTP entry was changed. */
export function unlinkCredential(credentialId: string): boolean {
  const ts = now();
  const changed = run("UPDATE totp SET credential_id = NULL, updated_at = ? WHERE credential_id = ?", ts, credentialId).changes > 0;
  run("UPDATE credentials SET totp_id = NULL WHERE id = ?", credentialId);
  return changed;
}

/** Remove every link involving this TOTP entry. Returns true if a credential was changed. */
export function unlinkTotp(totpId: string): boolean {
  const ts = now();
  const changed = run("UPDATE credentials SET totp_id = NULL, updated_at = ? WHERE totp_id = ?", ts, totpId).changes > 0;
  run("UPDATE totp SET credential_id = NULL WHERE id = ?", totpId);
  return changed;
}

/** After a scope change of either side, drop links that are no longer compatible. Returns true if a link was dropped. */
export function dropIncompatibleLinks(opts: { credentialId?: string; totpId?: string }): boolean {
  const pairs = opts.credentialId
    ? all<{ cid: string; cws: string | null; tws: string | null }>(
        "SELECT c.id AS cid, c.workspace_id AS cws, t.workspace_id AS tws FROM credentials c JOIN totp t ON t.id = c.totp_id WHERE c.id = ?",
        opts.credentialId,
      )
    : all<{ cid: string; cws: string | null; tws: string | null }>(
        "SELECT c.id AS cid, c.workspace_id AS cws, t.workspace_id AS tws FROM credentials c JOIN totp t ON t.id = c.totp_id WHERE t.id = ?",
        opts.totpId ?? "",
      );
  let dropped = false;
  for (const p of pairs) {
    if (!linkCompatible(p.cws, p.tws)) {
      unlinkCredential(p.cid);
      dropped = true;
    }
  }
  return dropped;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                        */
/* ------------------------------------------------------------------ */

/** Login URLs are opened by the UI and the browser agent, so only http(s) is accepted. */
function normalizeUrl(url: string | undefined): string {
  const u = (url ?? "").trim();
  if (!u) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw badRequest("Login URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("Login URL must be an http:// or https:// address");
  return withScheme;
}

function normalizeDomains(domains: string[] | undefined, url: string): string[] {
  const out = new Set<string>();
  for (const d of domains ?? []) {
    const host = hostnameOf(d.trim().replace(/^\*\./, ""));
    if (host) out.add(host);
  }
  if (out.size === 0 && url) {
    const host = hostnameOf(url);
    if (host) out.add(host);
  }
  return [...out];
}

function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

function requireName(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!n) throw badRequest("Name is required");
  return n;
}

/* ------------------------------------------------------------------ */
/* Queries                                                              */
/* ------------------------------------------------------------------ */

function toModel(r: CredentialRow, reveal = false): Credential {
  const c: Credential = {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    url: r.url,
    domains: parseJson<string[]>(r.domains, []),
    username: r.username,
    hasPassword: !!r.password_enc,
    totpId: r.linked_totp_id,
    tags: parseJson<string[]>(r.tags, []),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (reveal) {
    const password = vault.openOptional(r.password_enc, passwordContext(r.id));
    const notes = vault.openOptional(r.notes_enc, notesContext(r.id));
    if (password !== null) c.password = password;
    if (notes !== null) c.notes = notes;
  }
  return c;
}

function getRow(id: string): CredentialRow {
  const row = get<CredentialRow>(`SELECT ${ROW_SELECT} FROM credentials WHERE id = ?`, id);
  if (!row) throw notFound("Credential");
  return row;
}

function searchFields(r: CredentialRow): string[] {
  return [r.name, r.url, r.username, ...parseJson<string[]>(r.domains, []), ...parseJson<string[]>(r.tags, [])];
}

function agentMayUse(agent: Agent, r: CredentialRow): boolean {
  if (!inAgentScope(agent, r.workspace_id)) return false;
  const allowed = agent.permissions?.credentialIds ?? null;
  return allowed === null || allowed.includes(r.id);
}

/** List credentials. workspaceId: undefined/"all" = everything, null = global only, id = that workspace only. Never includes secrets. */
export function listCredentials(opts: { workspaceId?: string | null | "all"; search?: string } = {}): Credential[] {
  const scope = scopeCondition(opts.workspaceId);
  return all<CredentialRow>(`SELECT ${ROW_SELECT} FROM credentials WHERE ${scope.sql} ORDER BY name COLLATE NOCASE, created_at`, ...scope.params)
    .filter((r) => matchesSearch(opts.search, searchFields(r)))
    .map((r) => toModel(r));
}

/** Get one credential; with reveal=true includes decrypted password + notes (caller must audit). */
export function getCredential(id: string, opts: { reveal?: boolean } = {}): Credential {
  const row = getRow(id);
  if (opts.reveal && !vault.isUnlocked()) throw locked();
  return toModel(row, opts.reveal);
}

export function createCredential(input: CredentialInput): Credential {
  const name = requireName(input.name);
  const workspaceId = input.workspaceId ?? null;
  assertWorkspace(workspaceId);
  const url = normalizeUrl(input.url);
  const id = newId("cred");
  const ts = now();
  tx(() => {
    insert("credentials", {
      id,
      workspace_id: workspaceId,
      name,
      url,
      domains: JSON.stringify(normalizeDomains(input.domains, url)),
      username: (input.username ?? "").trim(),
      password_enc: vault.sealOptional(input.password, passwordContext(id)),
      notes_enc: vault.sealOptional(input.notes, notesContext(id)),
      totp_id: null,
      tags: JSON.stringify(normalizeTags(input.tags)),
      last_used_at: null,
      created_at: ts,
      updated_at: ts,
    });
    if (input.totpId) linkCredentialTotp(id, input.totpId);
  });
  bus.changed("credentials");
  if (input.totpId) bus.changed("totp");
  return getCredential(id);
}

export function updateCredential(id: string, input: Partial<CredentialInput>): Credential {
  const row = getRow(id);
  const patch: Record<string, string | null | undefined> = { updated_at: now() };
  if (input.name !== undefined) patch.name = requireName(input.name);

  const workspaceChanged = input.workspaceId !== undefined && (input.workspaceId ?? null) !== row.workspace_id;
  if (workspaceChanged) {
    assertWorkspace(input.workspaceId);
    patch.workspace_id = input.workspaceId ?? null;
  }

  const url = input.url !== undefined ? normalizeUrl(input.url) : row.url;
  if (input.url !== undefined) patch.url = url;
  if (input.domains !== undefined) {
    patch.domains = JSON.stringify(normalizeDomains(input.domains, url));
  } else if (input.url !== undefined) {
    // Domains that were derived from the old url follow the new url.
    const current = parseJson<string[]>(row.domains, []);
    const derived = current.length === 0 || (current.length === 1 && current[0] === hostnameOf(row.url));
    if (derived) patch.domains = JSON.stringify(normalizeDomains([], url));
  }

  if (input.username !== undefined) patch.username = input.username.trim();
  if (input.password !== undefined) patch.password_enc = vault.sealOptional(input.password, passwordContext(id));
  if (input.notes !== undefined) patch.notes_enc = vault.sealOptional(input.notes, notesContext(id));
  if (input.tags !== undefined) patch.tags = JSON.stringify(normalizeTags(input.tags));

  let totpChanged = false;
  tx(() => {
    update("credentials", id, patch);
    if (workspaceChanged) totpChanged = dropIncompatibleLinks({ credentialId: id }) || totpChanged;
    if (input.totpId === null) {
      totpChanged = unlinkCredential(id) || totpChanged;
    } else if (input.totpId !== undefined) {
      const current = get<{ totp_id: string | null }>("SELECT totp_id FROM credentials WHERE id = ?", id)?.totp_id ?? null;
      if (input.totpId !== current) {
        linkCredentialTotp(id, input.totpId);
        totpChanged = true;
      }
    }
  });
  bus.changed("credentials");
  if (totpChanged) bus.changed("totp");
  return getCredential(id);
}

export function deleteCredential(id: string): void {
  getRow(id);
  const totpChanged = tx(() => {
    const changed = unlinkCredential(id);
    run("DELETE FROM credentials WHERE id = ?", id);
    return changed;
  });
  bus.changed("credentials");
  if (totpChanged) bus.changed("totp");
}

/** Credentials an agent may use: global + agent's workspace, filtered by agent.permissions.credentialIds. No secrets. */
export function credentialsForAgent(agent: Agent): Credential[] {
  const scope = agentScopeCondition(agent);
  return all<CredentialRow>(`SELECT ${ROW_SELECT} FROM credentials WHERE ${scope.sql} ORDER BY name COLLATE NOCASE, created_at`, ...scope.params)
    .filter((r) => agentMayUse(agent, r))
    .map((r) => toModel(r));
}

/**
 * Credentials for agent whose domains/url match the given url or domain (subdomains match).
 * Best matches first: exact host before subdomain match, workspace before global, then most recently used.
 */
export function findCredentialsForAgent(agent: Agent, urlOrDomain: string): Credential[] {
  const host = hostnameOf(urlOrDomain);
  if (!host) return [];
  const ranked: { credential: Credential; rank: number }[] = [];
  for (const credential of credentialsForAgent(agent)) {
    const targets = [...credential.domains, ...(credential.url ? [hostnameOf(credential.url)] : [])].filter(Boolean);
    if (!targets.some((d) => domainMatches(host, d))) continue;
    const exact = targets.some((d) => hostnameOf(d) === host);
    ranked.push({ credential, rank: (exact ? 0 : 2) + (credential.workspaceId ? 0 : 1) });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || (b.credential.lastUsedAt ?? "").localeCompare(a.credential.lastUsedAt ?? ""))
    .map((r) => r.credential);
}

/**
 * Decrypt username/password for a credential the agent may use. Throws 403 if not in agent scope.
 * The plaintext is for Godmode itself (typing into the page); the caller must only hand it to the model
 * when agent.permissions.secretAccess === "reveal", and must audit the access.
 */
export function revealForAgent(agent: Agent, credentialId: string): { username: string; password: string | null; url: string; totpId: string | null } {
  const row = getRow(credentialId);
  if (!agentMayUse(agent, row)) throw forbidden("This login is not available to this agent");
  if (!vault.isUnlocked()) throw locked();
  return {
    username: row.username,
    password: vault.openOptional(row.password_enc, passwordContext(row.id)),
    url: row.url,
    totpId: row.linked_totp_id,
  };
}

export function markCredentialUsed(id: string): void {
  if (run("UPDATE credentials SET last_used_at = ? WHERE id = ?", now(), id).changes > 0) bus.changed("credentials");
}
