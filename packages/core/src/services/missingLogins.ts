/**
 * Missing / broken login reports raised by agents (report_missing_login) and handled by the human in the inbox.
 */
import type { MissingLogin, MissingLoginKind, MissingLoginPatch, MissingLoginStatus } from "@godmode/shared";
import { all, get, insert, run, update } from "../db";
import { bus } from "../events/bus";
import { notify } from "./notifications";
import { badRequest, hostnameOf, newId, notFound, now, truncate } from "../util";

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
