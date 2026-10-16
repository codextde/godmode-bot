/**
 * Missing / broken login reports raised by agents (report_missing_login) and handled by the human in the inbox.
 */
import type {
  Credential,
  MissingLogin,
  MissingLoginKind,
  MissingLoginPatch,
  MissingLoginStatus,
  MissingLoginTotpChoices,
  MissingLoginTotpLinkInput,
  MissingLoginTotpLinkOutcome,
  MissingLoginTotpLinkResult,
} from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { addCredentialDomain, getCredential, linkCredentialTotp, listCredentials } from "../vault/credentials";
import { getTotp, issuerMatchesCredential, listTotp } from "../vault/totp";
import { audit } from "./audit";
import { notify } from "./notifications";
import { badRequest, domainMatches, hostnameOf, newId, notFound, now, truncate } from "../util";

interface MissingLoginRow {
  id: string;
  agent_id: string | null;
  run_id: string | null;
  workspace_id: string | null;
  kind: string;
  service: string;
  url: string;
  reason: string;
  status: string;
  credential_id: string | null;
  occurrences: number;
  created_at: string;
  updated_at: string;
}

const KINDS: readonly MissingLoginKind[] = [
  "missing_credential",
  "invalid_credential",
  "missing_totp",
  "missing_account",
  "other",
];
const STATUSES: readonly MissingLoginStatus[] = ["open", "resolved", "dismissed"];

function toModel(r: MissingLoginRow): MissingLogin {
  return {
    id: r.id,
    agentId: r.agent_id,
    runId: r.run_id,
    workspaceId: r.workspace_id,
    kind: r.kind as MissingLoginKind,
    service: r.service,
    url: r.url,
    reason: r.reason,
    status: r.status as MissingLoginStatus,
    credentialId: r.credential_id,
    occurrences: r.occurrences,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRow(id: string): MissingLoginRow {
  const row = get<MissingLoginRow>("SELECT * FROM missing_logins WHERE id = ?", id);
  if (!row) throw notFound("Missing login");
  return row;
}

/** Dedupe key: the site's hostname when a URL is known, else the lowercase service name. */
function keysOf(service: string, url: string): string[] {
  const keys = [service.trim().toLowerCase()];
  const host = url ? hostnameOf(url) : "";
  if (host) keys.unshift(host);
  return keys.filter(Boolean);
}

export function reportMissingLogin(input: {
  agentId: string | null;
  runId: string | null;
  workspaceId: string | null;
  kind: MissingLoginKind;
  service: string;
  url?: string;
  reason?: string;
}): MissingLogin {
  const service = truncate((input.service ?? "").trim(), 200);
  const url = truncate((input.url ?? "").trim(), 2000);
  if (!service && !url) throw badRequest("service is required");
  const displayService = service || hostnameOf(url);
  const kind: MissingLoginKind = KINDS.includes(input.kind) ? input.kind : "other";
  const reason = truncate((input.reason ?? "").trim(), 2000);
  const ts = now();

  // An open report for the same site in the same scope is updated instead of duplicated.
  const wanted = keysOf(displayService, url);
  const existing = all<MissingLoginRow>(
    "SELECT * FROM missing_logins WHERE status = 'open' AND workspace_id IS ? ORDER BY updated_at DESC",
    input.workspaceId,
  ).find((row) => keysOf(row.service, row.url).some((k) => wanted.includes(k)));

  if (existing) {
    update("missing_logins", existing.id, {
      occurrences: existing.occurrences + 1,
      kind,
      reason: reason || undefined,
      url: existing.url ? undefined : url || undefined,
      agent_id: input.agentId ?? undefined,
      run_id: input.runId ?? undefined,
      updated_at: ts,
    });
    const item = toModel(getRow(existing.id));
    bus.emit({ type: "missing-login.updated", item });
    return item;
  }

  const row: MissingLoginRow = {
    id: newId("mlg"),
    agent_id: input.agentId,
    run_id: input.runId,
    workspace_id: input.workspaceId,
    kind,
    service: displayService,
    url,
    reason,
    status: "open",
    credential_id: null,
    occurrences: 1,
    created_at: ts,
    updated_at: ts,
  };
  insert("missing_logins", { ...row });
  const item = toModel(row);
  bus.emit({ type: "missing-login.created", item });
  notify("missing_login", `Login needed: ${displayService}`, reason, "/inbox");
  return item;
}

/** status: "open" | "resolved" | "dismissed" | "all" (default: all), open items first. */
export function listMissingLogins(opts: { status?: string } = {}): MissingLogin[] {
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  if (status && !STATUSES.includes(status as MissingLoginStatus)) {
    throw badRequest(`Invalid status "${status}" (expected ${STATUSES.join(", ")} or all)`);
  }
  const rows = status
    ? all<MissingLoginRow>("SELECT * FROM missing_logins WHERE status = ? ORDER BY updated_at DESC", status)
    : all<MissingLoginRow>(
        "SELECT * FROM missing_logins ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC",
      );
  return rows.map(toModel);
}

/** Resolve/dismiss/reopen an item or link the credential that fixes it (linking resolves it unless a status is given). */
export function updateMissingLogin(id: string, patch: MissingLoginPatch): MissingLogin {
  getRow(id);
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw badRequest(`Invalid status "${patch.status}"`);
  if (patch.credentialId && !get<{ id: string }>("SELECT id FROM credentials WHERE id = ?", patch.credentialId)) {
    throw badRequest("Credential not found");
  }
  const status = patch.status ?? (patch.credentialId ? "resolved" : undefined);
  update("missing_logins", id, { status, updated_at: now() });
  if (patch.credentialId !== undefined) run("UPDATE missing_logins SET credential_id = ? WHERE id = ?", patch.credentialId, id);
  const item = toModel(getRow(id));
  bus.emit({ type: "missing-login.updated", item });
  return item;
}

/* ------------------------------------------------------------------ */
/* Link a 2FA entry that is already in the vault                        */
/* ------------------------------------------------------------------ */

const hostsOf = (c: Pick<Credential, "domains" | "url">) => [...c.domains, ...(c.url ? [hostnameOf(c.url)] : [])].filter(Boolean);
const covers = (c: Pick<Credential, "domains" | "url">, host: string) => hostsOf(c).some((d) => domainMatches(host, d));
const sameUser = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

function siteOf(row: MissingLoginRow): string {
  const host = hostnameOf(row.url) || hostnameOf(row.service);
  if (!host) throw badRequest("This report has no website address, so Godmode can't tell which login the 2FA belongs to");
  return host;
}

/** The site's logins, the report's workspace first, then global, then the rest. */
function siteLogins(row: MissingLoginRow, host: string): Credential[] {
  const rank = (c: Credential) => (c.workspaceId === row.workspace_id ? 0 : c.workspaceId === null ? 1 : 2);
  return listCredentials({ workspaceId: "all" })
    .filter((c) => covers(c, host))
    .sort((a, b) => rank(a) - rank(b));
}

export function totpChoicesForMissingLogin(id: string): MissingLoginTotpChoices {
  const row = getRow(id);
  const host = siteOf(row);
  const logins = siteLogins(row, host);
  const credentials = new Map(listCredentials({ workspaceId: "all" }).map((c) => [c.id, c]));
  const site = { name: row.service, url: row.url || `https://${host}`, domains: JSON.stringify([host]) };
  const scored = listTotp({ workspaceId: "all" })
    .map((t) => {
      const linked = t.credentialId ? credentials.get(t.credentialId) : undefined;
      let score = 0;
      if (t.issuer && issuerMatchesCredential(t.issuer, site)) score += 3;
      if (logins.some((l) => sameUser(l.username, t.accountName))) score += 3;
      if (linked && logins.some((l) => sameUser(l.username, linked.username))) score += 2;
      if (linked && covers(linked, host)) score += 2;
      if (linked && linked.name.trim().toLowerCase() === row.service.trim().toLowerCase()) score += 1;
      return { id: t.id, score };
    })
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score);
  // A strong match (site and account) hides codes that only share the account.
  const floor = Math.max(3, (scored[0]?.score ?? 0) - 2);
  return {
    host,
    logins: logins.map(({ id, name, username, url, workspaceId, totpId }) => ({ id, name, username, url, workspaceId, totpId })),
    suggestedTotpIds: scored.filter((s) => s.score >= floor).map((s) => s.id),
  };
}

/**
 * The human picked a 2FA entry that is already in the vault for this report's site: make it usable there and
 * resolve the report. A free entry goes to the site's login. One linked to a login of the same account stays there
 * and that login gets the site (vault_fill_totp then finds it through the same account); one linked to another
 * account's login moves here.
 */
export function linkTotpToMissingLogin(id: string, input: MissingLoginTotpLinkInput): MissingLoginTotpLinkResult {
  const row = getRow(id);
  const host = siteOf(row);
  const totp = getTotp(input.totpId);
  const logins = siteLogins(row, host);
  let login: Credential | undefined;
  if (input.credentialId) {
    login = getCredential(input.credentialId);
    if (!covers(login, host)) throw badRequest(`"${login.name}" is not a login for ${host}`);
  } else {
    login =
      logins.find((l) => l.totpId === totp.id) ??
      logins.find((l) => sameUser(l.username, totp.accountName)) ??
      (logins.length === 1 ? logins[0] : undefined);
  }
  if (!login) {
    throw badRequest(
      logins.length ? `Pick which login for ${host} this 2FA belongs to` : `No login is saved for ${host} yet. Add the login first, then link its 2FA.`,
    );
  }
  const site = login;
  const owner = totp.credentialId && totp.credentialId !== site.id ? getCredential(totp.credentialId) : null;

  let outcome: MissingLoginTotpLinkOutcome;
  let credentialId = site.id;
  tx(() => {
    if (totp.credentialId === site.id) {
      outcome = "already";
    } else if (owner && (covers(owner, host) || sameUser(owner.username, site.username))) {
      outcome = addCredentialDomain(owner.id, host) ? "domain_added" : "already";
      credentialId = owner.id;
    } else {
      linkCredentialTotp(site.id, totp.id);
      outcome = owner ? "moved" : "linked";
    }
    update("missing_logins", id, { status: "resolved", updated_at: now() });
    run("UPDATE missing_logins SET credential_id = ? WHERE id = ?", credentialId, id);
  });
  bus.changed("totp");
  bus.changed("credentials");
  audit("user", "totp.link", totp.id, { credentialId, missingLoginId: id, outcome: outcome!, host });
  const item = toModel(getRow(id));
  bus.emit({ type: "missing-login.updated", item });
  return { item, credentialId, outcome: outcome! };
}
