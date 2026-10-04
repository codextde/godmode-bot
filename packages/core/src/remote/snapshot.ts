/**
 * The config snapshot: the whole setup of a Godmode — workspaces, agents, logins, 2FA, integrations, settings and the
 * vault key — as the copy a runner works from. Built on the controller, applied on the runner.
 *
 * Rows keep their ids. Sealed columns are bound to `table.column:id`, so they are copied as they are and open on the
 * runner once it holds the same data key; and because ids match, both sides can speak about the same rows.
 * What a computer tracks about itself (where a repository lies, when a login was last used, what state a VM is in) is
 * never copied and never part of the digest, so using the setup doesn't make it look changed.
 *
 * Applying is idempotent and never replaces a table wholesale: the runner's chats and runs hang on its agent rows
 * (ON DELETE CASCADE), so rows are updated in place and only the ones the controller no longer has are removed.
 */
import { join } from "node:path";
import type { EntityName } from "@godmode/shared";
import { ensureAgentRepo, refreshAgentFiles, trashAgentRepo } from "../agents/service";
import { decodeValue, encodeValue, EXECUTABLE_SETTINGS, SAFE_ID, type DumpValue } from "../backup/backup";
import { ensureDefaultProfile } from "../browser/manager";
import { config } from "../config";
import { all, get, getDb, getMeta, run, setMeta, tx } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";
import { workingDirectoryProblem } from "../services/folders";
import { applyRuntimeSettings } from "../services/runtime";
import { DEFAULT_SETTINGS, getSettings, resetSettingsCache } from "../services/settings";
import { badRequest, parseJson } from "../util";
import { decrypt, sha256 } from "../vault/crypto";
import * as vault from "../vault/vault";

const log = logger("snapshot");

type Row = Record<string, DumpValue>;
type Value = string | number | null | Uint8Array;

interface TableSpec {
  table: string;
  /** Columns that stay the runner's own: never copied, never overwritten, not part of the digest. */
  own: string[];
  /** Only rows with this value are mirrored; the others belong to the computer they are on. */
  only?: { column: string; value: string };
  /** Own columns a new row can't take the column default for. */
  onInsert?: (row: Record<string, Value>) => Record<string, Value>;
  /** What the UI is told when rows changed. */
  entity: EntityName;
}

/**
 * The mirrored tables. Every other column is taken from the live schema, so columns added by later migrations are
 * mirrored without a change here. Listed parents first; applied in reverse (see `apply`).
 */
const TABLES: TableSpec[] = [
  { table: "workspaces", own: [], entity: "workspaces" },
  {
    table: "agents",
    // failed_run_id: the agent's last failed run on this computer ("error" in the list) — the runner's are its own.
    own: ["repo_path", "status", "last_run_at", "failed_run_id"],
    onInsert: (row) => ({ repo_path: join(config().agentsDir, String(row.slug)) }),
    entity: "agents",
  },
  { table: "credentials", own: ["last_used_at"], entity: "credentials" },
  { table: "totp", own: ["last_used_at"], entity: "totp" },
  { table: "secrets", own: [], entity: "settings" },
  { table: "mcp_servers", own: [], entity: "mcp-servers" },
  { table: "composio_connections", own: [], entity: "composio" },
  { table: "api_tools", own: ["last_used_at"], entity: "api-tools" },
  { table: "ssh_servers", own: ["last_connected_at", "last_error"], entity: "ssh-servers" },
  {
    table: "browser_profiles",
    own: ["user_data_dir", "cookie_count", "imported_from", "imported_at"],
    onInsert: (row) => ({ user_data_dir: join(config().browserDir, String(row.id)) }),
    entity: "browser-profiles",
  },
  {
    table: "workspace_sources",
    own: ["error", "note", "commit_sha", "head_branch", "synced_at"],
    // Folders are paths on the controller; repositories are cloned again on the runner.
    only: { column: "kind", value: "git" },
    entity: "workspaces",
  },
  { table: "vms", own: ["provisioned_at", "last_error", "last_started_at", "last_used_at"], entity: "vms" },
];

/** Settings that describe the computer they are on (how it is reached, what it logs, whether it was set up). */
// maintenance: how this computer keeps its own tools fixed and up to date — a runner, alone most of the time, keeps its own.
const LOCAL_SETTINGS = new Set(["server", "mobile", "cloud", "diagnostics", "maintenance", "onboardingComplete"]);
/** A runner's vault is opened by a sync, not by a human with the passphrase: it must not lock itself in between. */
const RUNNER_SETTINGS: Record<string, string[]> = { security: ["autoLockMinutes"] };
/** VM ids become Tart VM names and folder names. */
const VM_ID = /^vm_[A-Za-z0-9]{8,64}$/;
const DIGEST_KEY = "link.config_digest";

export interface ConfigSnapshot {
  v: 1;
  digest: string;
  tables: Record<string, Row[]>;
  /** Section → value. */
  settings: Record<string, unknown>;
  vault: {
    kdf: string | null;
    wrappedDek: string | null;
    canary: string | null;
    /** The data key (base64), when the controller's vault is unlocked. */
    dek: string | null;
  };
}

type Parts = Pick<ConfigSnapshot, "tables" | "settings"> & { vault: Omit<ConfigSnapshot["vault"], "dek"> };

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function columnsOf(table: string): { name: string; pk: number }[] {
  return all<{ name: string; pk: number }>(`PRAGMA table_info(${q(table)})`);
}

/** Fields of a settings section that keep the runner's value: they name programs and endpoints on that computer. */
function keptFields(section: string): string[] {
  return [...(EXECUTABLE_SETTINGS[section] ?? []), ...(RUNNER_SETTINGS[section] ?? [])];
}

/* ------------------------------------------------------------------ */
/* Build (controller)                                                   */
/* ------------------------------------------------------------------ */

function collect(): Parts {
  const tables: Record<string, Row[]> = {};
  for (const spec of TABLES) {
    const columns = columnsOf(spec.table);
    const pk = columns.find((c) => c.pk)?.name;
    if (!pk) continue;
    const names = columns.map((c) => c.name).filter((n) => !spec.own.includes(n));
    const rows = all<Record<string, unknown>>(
      `SELECT ${names.map(q).join(", ")} FROM ${q(spec.table)}${spec.only ? ` WHERE ${q(spec.only.column)} = ?` : ""}`,
      ...(spec.only ? [spec.only.value] : []),
    );
    tables[spec.table] = rows
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encodeValue(v)])))
      .sort((a, b) => (String(a[pk]) < String(b[pk]) ? -1 : 1));
  }

  const settings: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(getSettings())) {
    if (LOCAL_SETTINGS.has(section)) continue;
    const kept = keptFields(section);
    settings[section] = isObject(value) ? Object.fromEntries(Object.entries(value).filter(([field]) => !kept.includes(field))) : value;
  }
  return { tables, settings, vault: vault.vaultMetaForBackup() };
}

/** JSON with object keys in a fixed order, so the same setup always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, canonical(value[k])]),
  );
}

/** `updated_at` is copied but not hashed: bookkeeping that touches a row is not a change of the setup. */
function digestOf(parts: Parts): string {
  const tables = Object.fromEntries(Object.entries(parts.tables).map(([table, rows]) => [table, rows.map(({ updated_at: _stamp, ...row }) => row)]));
  return sha256(JSON.stringify(canonical({ v: 1, tables, settings: parts.settings, vault: parts.vault })));
}

export function buildSnapshot(): ConfigSnapshot {
  // The key first: reading it gives a vault from before canaries its canary, which the snapshot has to carry.
  const dek = vault.isUnlocked() ? vault.exportKeyForBackup().toString("base64") : null;
  const parts = collect();
  return { v: 1, digest: digestOf(parts), tables: parts.tables, settings: parts.settings, vault: { ...parts.vault, dek } };
}

/** The digest `buildSnapshot()` would carry, without touching the vault key. */
export function snapshotDigest(): string {
  return digestOf(collect());
}

/** Digest of the snapshot this runner applied last; null = never synced. */
export function appliedDigest(): string | null {
  return getMeta(DIGEST_KEY);
}

/* ------------------------------------------------------------------ */
/* Apply (runner)                                                       */
/* ------------------------------------------------------------------ */

/** Why a row can't be copied: its slug or id becomes a folder name on the runner (an agent's id does too, for its browser files). */
function unsafe(table: string, row: Record<string, unknown>): string | null {
  const label = typeof row.name === "string" && row.name ? row.name : String(row.id);
  if (table === "agents" && !(typeof row.slug === "string" && SAFE_ID.test(row.slug) && SAFE_ID.test(String(row.id)))) {
    return `Skipped agent "${label}": its folder name isn't safe.`;
  }
  if (table === "browser_profiles" && !SAFE_ID.test(String(row.id))) return `Skipped browser profile "${label}": its id isn't a safe folder name.`;
  if (table === "vms" && !VM_ID.test(String(row.id))) return `Skipped virtual machine "${label}": its id isn't a safe folder name.`;
  return null;
}

/** One apply at a time: the work after the commit (vault key, agent files, digest) must not interleave. */
let applying: Promise<unknown> = Promise.resolve();

export function applySnapshot(s: ConfigSnapshot): Promise<{ digest: string; warnings: string[] }> {
  const result = applying.then(() => apply(s));
  applying = result.catch(() => undefined);
  return result;
}

async function apply(s: ConfigSnapshot): Promise<{ digest: string; warnings: string[] }> {
  if (!isObject(s) || s.v !== 1 || typeof s.digest !== "string" || !isObject(s.tables) || !isObject(s.settings) || !isObject(s.vault)) {
    throw badRequest("This runner can't read the setup Godmode sent — update Godmode on both computers.");
  }
  const { kdf, wrappedDek, canary, dek } = s.vault;
  if (dek != null) {
    if (typeof dek !== "string" || typeof kdf !== "string" || typeof wrappedDek !== "string" || (canary != null && typeof canary !== "string")) {
      throw badRequest("The vault key doesn't match");
    }
    // Checked before anything is written: rows sealed with a key the runner can't adopt would be useless.
    const key = Buffer.from(dek, "base64");
    if (key.length !== 32) throw badRequest("The vault key doesn't match");
    if (canary) {
      try {
        decrypt(key, canary, "vault.canary");
      } catch {
        throw badRequest("The vault key doesn't match");
      }
    }
  }

  const cfg = config();
  const warnings: string[] = [];
  const changed = new Set<EntityName>();
  /** Keys of rows that were added or really changed, per table. */
  const touched = new Map<string, Set<string>>(TABLES.map((spec) => [spec.table, new Set<string>()]));
  const removedAgents: { slug: string; repoPath: string }[] = [];
  /** An agent with an active run stood in the way: this sync isn't recorded as applied, so the next one tries again. */
  let pending = false;
  const touch = (spec: TableSpec, key: string) => {
    changed.add(spec.entity);
    touched.get(spec.table)!.add(key);
  };

  tx(() => {
    // Rows arrive children first; foreign keys are verified at COMMIT.
    getDb().run("PRAGMA defer_foreign_keys = ON");
    // Never pull an agent out from under a run.
    const busy = new Set(listActiveRuns().map((r) => r.agentId));
    const workspaces = Array.isArray(s.tables.workspaces) ? new Set(s.tables.workspaces.map((r) => (isObject(r) ? r.id : null))) : null;

    // Children before parents: by the time a workspace or an agent the controller no longer has is deleted, every row
    // that stays points at its new parent — the delete cascades to nothing that should survive (an agent that moved to
    // another workspace keeps its chats).
    for (const spec of [...TABLES].reverse()) {
      const incoming: unknown = s.tables[spec.table];
      const columns = columnsOf(spec.table);
      const pk = columns.find((c) => c.pk)?.name;
      // A table one side doesn't know (different versions) is left as it is.
      if (!Array.isArray(incoming) || !pk) continue;
      const mirrored = columns.map((c) => c.name).filter((n) => !spec.own.includes(n));

      const keys = new Set<string>();
      const rows: Record<string, Value>[] = [];
      for (const raw of incoming as unknown[]) {
        if (!isObject(raw) || typeof raw[pk] !== "string" || !raw[pk]) continue;
        if (spec.only && raw[spec.only.column] !== spec.only.value) continue;
        keys.add(raw[pk]);
        const problem = unsafe(spec.table, raw);
        if (problem) warnings.push(problem);
        else rows.push(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeValue(v)])));
      }

      // Delete before insert: a row that goes may hold a slug (UNIQUE) a row that comes needs — a runner's own default
      // agent and the controller's are both "godmode".
      const filter = spec.only ? ` WHERE ${q(spec.only.column)} = ?` : "";
      for (const local of all<Record<string, unknown>>(`SELECT * FROM ${q(spec.table)}${filter}`, ...(spec.only ? [spec.only.value] : []))) {
        const key = String(local[pk]);
        if (keys.has(key)) continue;
        if (spec.table === "agents" && busy.has(key)) {
          pending = true;
          warnings.push(
            `Agent "${String(local.name)}" isn't part of this setup anymore but is still working on the runner — it goes with the next sync after its run.`,
          );
          // Its workspace may go with this sync, and deleting a workspace takes its agents along.
          if (local.workspace_id !== null && workspaces && !workspaces.has(String(local.workspace_id))) {
            run("UPDATE agents SET workspace_id = NULL WHERE id = ?", key);
          }
          continue;
        }
        run(`DELETE FROM ${q(spec.table)} WHERE ${q(pk)} = ?`, key);
        touch(spec, key);
        if (spec.table === "agents") {
          // Its chats and runs went with it.
          changed.add("runs");
          const slug = String(local.slug);
          if (SAFE_ID.test(slug)) removedAgents.push({ slug, repoPath: join(cfg.agentsDir, slug) });
        }
      }

      for (const row of rows) {
        const key = String(row[pk]);
        if (spec.table === "agents") {
          const holder = get<{ name: string }>("SELECT name FROM agents WHERE slug = ? AND id != ?", String(row.slug), key);
          if (holder) {
            pending = true;
            warnings.push(`Agent "${String(row.name)}" wasn't copied yet: "${holder.name}" uses the same folder and is still working on the runner.`);
            continue;
          }
          // A folder of the controller is only used when the runner has a usable folder at the same path.
          const dir = row.working_directory;
          if (dir != null && (typeof dir !== "string" || workingDirectoryProblem(dir))) row.working_directory = null;
        }
        // Columns this schema doesn't have are ignored; columns the snapshot lacks keep their default.
        const names = mirrored.filter((n) => n in row);
        const extra = spec.onInsert?.(row) ?? {};
        const inserted = [...names, ...Object.keys(extra)];
        const updates = names.filter((n) => n !== pk);
        // The WHERE makes an unchanged row count as no change (so nobody is told, and no file is rewritten).
        const set = updates.map((n) => `${q(n)} = excluded.${q(n)}`).join(", ");
        const differs = updates.map((n) => `${q(spec.table)}.${q(n)} IS NOT excluded.${q(n)}`).join(" OR ");
        const onConflict = updates.length ? `UPDATE SET ${set} WHERE ${differs}` : "NOTHING";
        const res = run(
          `INSERT INTO ${q(spec.table)} (${inserted.map(q).join(", ")}) VALUES (${inserted.map(() => "?").join(", ")}) ON CONFLICT(${q(pk)}) DO ${onConflict}`,
          ...names.map((n) => row[n] ?? null),
          ...Object.values(extra),
        );
        if (res.changes > 0) touch(spec, key);
      }
    }

    // What belongs to an agent that wasn't copied (see the warnings) would fail the commit: leave it out too. Agents
    // themselves are never dropped here — their chats would go with them; a snapshot that broken fails as a whole.
    let orphans = 0;
    for (const spec of TABLES) {
      if (spec.table === "agents") continue;
      for (const violation of all<{ rowid: number | null }>(`PRAGMA foreign_key_check(${q(spec.table)})`)) {
        if (violation.rowid === null) continue;
        const res = run(`DELETE FROM ${q(spec.table)} WHERE rowid = ?`, violation.rowid);
        if (res.changes > 0) changed.add(spec.entity);
        orphans += res.changes;
      }
    }
    if (orphans) warnings.push(`Left out ${orphans} item(s) that belong to an agent that wasn't copied.`);

    const current = new Map(all<{ key: string; value: string }>("SELECT key, value FROM settings").map((r) => [r.key, r.value]));
    const store = (key: string, value: string) => {
      if (current.get(key) === value) return;
      run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
      changed.add("settings");
    };
    for (const [section, value] of Object.entries(s.settings)) {
      if (LOCAL_SETTINGS.has(section) || !(section in DEFAULT_SETTINGS) || !isObject(value)) continue;
      const mine = parseJson<unknown>(current.get(section), null);
      const next = { ...value };
      for (const field of keptFields(section)) {
        delete next[field];
        if (isObject(mine) && field in mine) next[field] = mine[field];
      }
      store(section, JSON.stringify(next));
    }
    // A runner is set up by pairing it; nobody clicks through onboarding there.
    store("onboardingComplete", "true");
  });

  if (dek != null) {
    await vault.adoptKey(dek, { kdf: kdf as string, wrappedDek: wrappedDek as string, canary: canary ?? null });
  } else if (wrappedDek && wrappedDek !== getMeta("vault.wrapped_dek")) {
    warnings.push("The vault on the runner is from another setup — unlock the vault in Godmode and sync again.");
  }

  resetSettingsCache();
  applyRuntimeSettings(getSettings());
  ensureDefaultProfile();

  // A removed agent's repository goes to the trash first: a new agent with the same folder name must not inherit its
  // memory.
  for (const gone of removedAgents) {
    await trashAgentRepo(gone).catch((err) => log.warn(`could not move the repository of removed agent ${gone.slug} to the trash`, err));
  }
  const staleAgents = touched.get("agents")!;
  const staleWorkspaces = touched.get("workspaces")!;
  for (const agent of all<{ id: string; name: string; workspace_id: string | null }>("SELECT id, name, workspace_id FROM agents")) {
    try {
      // CLAUDE.md carries the agent's instructions and its workspace: rewrite it when either changed.
      if (staleAgents.has(agent.id) || (agent.workspace_id !== null && staleWorkspaces.has(agent.workspace_id))) {
        await refreshAgentFiles(agent.id, "Copy settings from Godmode");
      } else {
        await ensureAgentRepo(agent.id);
      }
    } catch (err) {
      log.warn(`could not prepare the repository of agent ${agent.id}`, err);
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`Couldn't prepare the files of agent "${agent.name}" on the runner: ${reason}`);
    }
  }

  if (!pending) setMeta(DIGEST_KEY, s.digest);
  for (const entity of changed) bus.changed(entity);
  for (const warning of warnings) log.warn(warning);
  log.info(`setup ${s.digest.slice(0, 12)} applied${pending ? " as far as agents with active runs allow" : ""}`);
  // What the runner now reports as applied: the controller sees a difference and syncs again while something is pending.
  return { digest: appliedDigest() ?? "", warnings };
}
