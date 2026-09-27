import type { AuditEntry } from "@godmode/shared";
import { all, insert, run } from "../db";
import { newId, now, parseJson } from "../util";

interface AuditRow {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  details: string;
}

/** Append an entry to the tamper-evident-ish audit log (every secret access goes here). */
export function audit(actor: string, action: string, target: string | null = null, details: Record<string, unknown> = {}) {
  insert("audit_log", {
    id: newId("aud"),
    ts: now(),
    actor,
    action,
    target,
    details: JSON.stringify(details),
  });
}

export function listAudit(limit = 200, action?: string): AuditEntry[] {
  const rows = action
    ? all<AuditRow>("SELECT * FROM audit_log WHERE action LIKE ? ORDER BY ts DESC LIMIT ?", `${action}%`, limit)
    : all<AuditRow>("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", limit);
  return rows.map((r) => ({ ...r, details: parseJson(r.details, {}) }));
}

export function pruneAudit(retentionDays: number) {
  if (retentionDays <= 0) return;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  run("DELETE FROM audit_log WHERE ts < ?", cutoff);
}
