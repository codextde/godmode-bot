/**
 * Encrypted config backup & restore.
 *
 * A `.godmode-backup` file is `sealWithPassphrase(passphrase, zip)` where the zip contains:
 *   manifest.json              BackupManifest
 *   db.json                    every row of every app table (encrypted columns stay encrypted)
 *   vault.json                 wrapped vault key (KDF params, wrapped DEK, canary)
 *   agents/<slug>/**           agent git repositories (optional)
 *   browser/<profileId>/**     Chromium user-data-dirs without caches (optional)
 *
 * Restoring replaces the database and the vault key: afterwards the vault is LOCKED and unlocks with the
 * passphrase of the vault that was backed up. Device-specific state (dashboard password, server/binding
 * settings, remembered vault key) is kept from the current machine.
 *
 * A backup file is untrusted input. On import, settings that name programs to run (Claude/Chrome paths, extra CLI
 * args, browser-use command) or where to send API keys (OpenAI base URL) are reset to defaults, stdio MCP servers
 * are disabled until the user reviews them, and agents / browser profiles with unsafe ids are renamed or skipped.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { BackupExportInput, BackupImportResult, BackupManifest, EntityName } from "@godmode/shared";
import { isValidBranch, parseGitUrl } from "@godmode/shared";
import { config, VERSION } from "../config";
import { all, get, getDb, run as exec } from "../db";
import { recoverInterruptedRuns } from "../runner/runner";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { applyRuntimeSettings } from "../services/runtime";
import { DEFAULT_SETTINGS, getSettings, resetSettingsCache } from "../services/settings";
import { startScheduler, stopScheduler } from "../scheduler/scheduler";
import { startFollowups, stopFollowups } from "../services/followups";
import { startAutomationEvents, stopAutomationEvents } from "../automations/events";
import { startAppTriggers, stopAppTriggers } from "../integrations/composioTriggers";
import { startMessaging, stopMessaging } from "../messaging/service";
import { shutdownBrowsers } from "../browser/manager";
import { resetComposioState } from "../integrations/composio";
import { workingDirectoryProblem } from "../services/folders";
import { isSafeCloneDir } from "../services/workspaceSources";
import * as vault from "../vault/vault";
import { assertSafeKdf, openWithPassphrase, sealWithPassphrase } from "../vault/crypto";
import { badRequest, conflict, HttpError, slugify } from "../util";

const log = logger("backup");

export const BACKUP_EXTENSION = ".godmode-backup";
export const MAX_BACKUP_BYTES = 2 * 1024 ** 3;
const FILE_PREFIX = "godmode-backup-";

/** Never exported: login sessions, paired phones and the migration ledger. */
const EXCLUDED_TABLES = new Set(["sessions", "mobile_devices", "_migrations"]);
/** Vault key material travels in vault.json, not db.json. */
const VAULT_META_KEYS = new Set(["vault.kdf", "vault.wrapped_dek", "vault.canary"]);
/** Settings sections that belong to this machine (bind address, remote access, allowed origins, phone access). */
const DEVICE_SETTINGS = new Set(["server", "mobile"]);

/** Meta keys that stay with the machine: dashboard auth, remembered vault key, cached Composio sessions, phone pairing. */
function isDeviceMetaKey(key: string): boolean {
  return key.startsWith("auth.") || key.startsWith("vault.remember_") || key.startsWith("composio.session.") || key.startsWith("mobile.");
}

/** Chromium profile content that is cache or lock files — never worth backing up. */
const BROWSER_SKIP_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "Service Worker",
  "CacheStorage",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
]);
const BROWSER_SKIP_FILES = new Set(["DevToolsActivePort", "Godmode-DevTools.json", "Godmode-stderr.log", "lockfile", "LOCK"]);

const ALL_ENTITIES: EntityName[] = [
  "workspaces",
  "agents",
  "routines",
  "credentials",
  "totp",
  "mcp-servers",
  "composio",
  "browser-profiles",
  "missing-logins",
  "notifications",
  "settings",
  "runs",
  "vms",
  "ssh-servers",
  "messaging",
  "followups",
];

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
/** Agent slugs and browser profile ids become directory names: restored ones must match this. */
const SAFE_ID = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

/** Settings that point at programs or endpoints; a backup must not be able to set them. */
const EXECUTABLE_SETTINGS: Record<string, string[]> = {
  runner: ["extraArgs", "claudePath"],
  browser: ["chromePath", "browserUseCommand"],
  computer: ["cuaDriverCommand"],
  vm: ["tartPath"],
  voice: ["openaiBaseUrl"],
};

let busy: "export" | "import" | null = null;

function withLock<T>(kind: "export" | "import", fn: () => Promise<T>): Promise<T> {
  if (busy) throw conflict(`A backup ${busy} is already in progress`);
  busy = kind;
  return fn().finally(() => {
    busy = null;
  });
}

/* ------------------------------------------------------------------ */
/* Database dump                                                        */
/* ------------------------------------------------------------------ */

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

type DumpValue = string | number | null | { $b64: string };
interface DbDump {
  tables: Record<string, Record<string, DumpValue>[]>;
}

/** Real app tables (virtual tables and their shadow tables are rebuilt by triggers, not copied). */
function appTables(): string[] {
  const rows = all<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const virtual = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? "")).map((r) => r.name);
  return rows
    .map((r) => r.name)
    .filter((n) => !EXCLUDED_TABLES.has(n) && !virtual.some((v) => n === v || n.startsWith(`${v}_`)));
}

function tableInfo(table: string): ColumnInfo[] {
  return all<ColumnInfo>(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function encodeValue(v: unknown): DumpValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v).toString("base64") };
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return JSON.stringify(v);
}

function decodeValue(v: unknown): string | number | null | Uint8Array {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string") {
    return new Uint8Array(Buffer.from((v as { $b64: string }).$b64, "base64"));
  }
  return JSON.stringify(v);
}

function dumpDatabase(): { dump: DbDump; counts: Record<string, number> } {
  const dump: DbDump = { tables: {} };
  const counts: Record<string, number> = {};
  for (const table of appTables()) {
    let rows = all<Record<string, unknown>>(`SELECT * FROM ${q(table)}`);
    if (table === "meta") rows = rows.filter((r) => !VAULT_META_KEYS.has(String(r.key)) && !isDeviceMetaKey(String(r.key)));
    if (table === "settings") rows = rows.filter((r) => !DEVICE_SETTINGS.has(String(r.key)));
    dump.tables[table] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encodeValue(v)])));
    counts[table] = rows.length;
  }
  return { dump, counts };
}

/* ------------------------------------------------------------------ */
/* Files                                                                */
/* ------------------------------------------------------------------ */

const STORED_EXT = /\.(pack|zip|gz|tgz|bz2|xz|zst|7z|png|jpe?g|gif|webp|avif|mp3|mp4|m4a|webm|ogg|pdf|woff2?)$/i;

/** Add every regular file below `root` as `<prefix>/<relative path>`; empty directories get a `dir/` entry. */
function addTree(zip: Zippable, root: string, prefix: string, skip?: (name: string, isDir: boolean) => boolean): number {
  let count = 0;
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`cannot read ${dir}`, err instanceof Error ? err.message : err);
      return;
    }
    const kept = entries.filter((e) => !skip?.(e.name, e.isDirectory()));
    if (kept.length === 0 && rel) zip[`${prefix}/${rel}/`] = new Uint8Array(0);
    for (const e of kept) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      // Symlinks and special files are skipped on purpose (never follow links out of the tree).
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile()) {
        try {
          const data = readFileSync(full);
          zip[`${prefix}/${relPath}`] = [data, { level: STORED_EXT.test(e.name) || data.length > 8 * 1024 ** 2 ? 0 : 6 }];
          count++;
        } catch (err) {
          log.warn(`skipping unreadable file ${full}`, err instanceof Error ? err.message : err);
        }
      }
    }
  };
  walk(root, "");
  return count;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */

export interface ExportResult {
  data: Uint8Array;
  filename: string;
  manifest: BackupManifest;
}

export function exportBackup(input: BackupExportInput, actor = "user"): Promise<ExportResult> {
  return withLock("export", async () => {
    const passphrase = input.passphrase;
    if (typeof passphrase !== "string" || passphrase.length < 8) throw badRequest("Backup passphrase must be at least 8 characters");
    const includeAgentRepos = input.includeAgentRepos !== false;
    const includeBrowserProfiles = input.includeBrowserProfiles === true;

    const { dump, counts } = dumpDatabase();
    const zip: Zippable = {};
    let files = 0;
    let agentRepos = 0;
    let browserProfiles = 0;

    if (includeAgentRepos) {
      for (const a of all<{ slug: string; repo_path: string }>("SELECT slug, repo_path FROM agents")) {
        if (!SAFE_SEGMENT.test(a.slug) || a.slug.includes("..") || !isDir(a.repo_path)) continue;
        files += addTree(zip, a.repo_path, `agents/${a.slug}`);
        agentRepos++;
      }
    }
    if (includeBrowserProfiles) {
      for (const p of all<{ id: string; user_data_dir: string }>("SELECT id, user_data_dir FROM browser_profiles")) {
        if (!SAFE_SEGMENT.test(p.id) || p.id.includes("..") || !isDir(p.user_data_dir)) continue;
        files += addTree(
          zip,
          p.user_data_dir,
          `browser/${p.id}`,
          (name, dir) => (dir ? BROWSER_SKIP_DIRS.has(name) : name.startsWith("Singleton") || BROWSER_SKIP_FILES.has(name)),
        );
        browserProfiles++;
      }
    }

    const manifest: BackupManifest = {
      format: "godmode-backup",
      version: 1,
      appVersion: VERSION,
      createdAt: new Date().toISOString(),
      counts: { ...counts, agentRepos, browserProfiles, files },
    };
    zip["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
    zip["db.json"] = strToU8(JSON.stringify(dump));
    zip["vault.json"] = strToU8(JSON.stringify(vault.vaultMetaForBackup()));

    const archive = zipSync(zip, { level: 6 });
    const data = sealWithPassphrase(passphrase, archive);
    const filename = `${FILE_PREFIX}${timestamp()}${BACKUP_EXTENSION}`;
    keepLatestCopy(filename, data);

    audit(actor, "backup.export", filename, { includeAgentRepos, includeBrowserProfiles, bytes: data.byteLength, agentRepos, browserProfiles });
    log.info(`backup exported (${(data.byteLength / 1024 / 1024).toFixed(1)} MB, ${files} files)`);
    return { data, filename, manifest };
  });
}

/** Keep the most recent manual export in the backups dir (older manual exports are replaced). */
function keepLatestCopy(filename: string, data: Uint8Array) {
  const dir = config().backupsDir;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, filename), data, { mode: 0o600 });
    for (const name of readdirSync(dir)) {
      if (name !== filename && name.startsWith(FILE_PREFIX) && name.endsWith(BACKUP_EXTENSION)) unlinkSync(join(dir, name));
    }
  } catch (err) {
    log.warn("could not keep a copy of the backup in the backups directory", err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

interface PlannedFile {
  top: string;
  segments: string[];
  data: Uint8Array;
  dir: boolean;
}

function parseJsonEntry<T>(entries: Record<string, Uint8Array>, name: string): T {
  const raw = entries[name];
  if (!raw) throw badRequest(`The backup is missing ${name}`);
  try {
    return JSON.parse(strFromU8(raw)) as T;
  } catch {
    throw badRequest(`The backup's ${name} is corrupted`);
  }
}

function validateManifest(m: unknown): BackupManifest {
  const manifest = m as Partial<BackupManifest> | null;
  if (!manifest || manifest.format !== "godmode-backup") throw badRequest("This is not a Godmode backup");
  if (manifest.version !== 1) {
    throw badRequest(`Unsupported backup version ${String(manifest.version)} (created by Godmode ${manifest.appVersion ?? "unknown"}). Update Godmode and try again.`);
  }
  return manifest as BackupManifest;
}

/** Validate archive paths up front (zip-slip safe) and group them per restore root. */
function planFiles(entries: Record<string, Uint8Array>, kind: "agents" | "browser", allowedTops: Set<string>): PlannedFile[] {
  const out: PlannedFile[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(`${kind}/`)) continue;
    const dir = name.endsWith("/");
    const parts = name.split("/");
    if (dir) parts.pop();
    const [, top, ...segments] = parts;
    if (!top || !SAFE_SEGMENT.test(top) || top.includes("..")) throw badRequest(`Unsafe path in backup: ${name}`);
    for (const s of segments) {
      if (!s || s === "." || s === ".." || /[\\:\0]/.test(s)) throw badRequest(`Unsafe path in backup: ${name}`);
    }
    if (!allowedTops.has(top)) {
      log.warn(`ignoring ${kind} files for unknown entry ${top}`);
      continue;
    }
    if (!dir && segments.length === 0) continue;
    out.push({ top, segments, data, dir });
  }
  return out;
}

/**
 * Make an untrusted dump safe to apply (mutates `dump`): rename agents whose slug is not a safe folder name, drop
 * browser profiles with unsafe ids, reset settings that name programs/endpoints and disable stdio MCP servers.
 * Returns human-readable warnings for the import result.
 */
function sanitizeDump(dump: DbDump): string[] {
  const warnings: string[] = [];
  const tables = dump.tables;
  const rowsOf = (table: string) => (Array.isArray(tables[table]) ? tables[table]! : []);

  const agents = rowsOf("agents");
  const taken = new Set(agents.map((r) => r.slug).filter((s): s is string => typeof s === "string" && SAFE_ID.test(s)));
  for (const row of agents) {
    const slug = typeof row.slug === "string" ? row.slug : "";
    if (SAFE_ID.test(slug)) continue;
    const base = slugify(slug || String(row.name ?? "")) || "agent";
    let next = base;
    for (let i = 2; taken.has(next); i++) next = `${base}-${i}`;
    taken.add(next);
    row.slug = next;
    warnings.push(`Agent "${String(row.name ?? next)}" had an unsafe folder name and was renamed to "${next}"; its files were not restored.`);
  }

  let clearedFolders = 0;
  for (const row of [...rowsOf("agents"), ...rowsOf("conversations")]) {
    if (row.working_directory == null) continue;
    if (typeof row.working_directory === "string" && !workingDirectoryProblem(row.working_directory)) continue;
    row.working_directory = null;
    clearedFolders++;
  }
  if (clearedFolders) warnings.push(`Cleared ${clearedFolders} working folder(s) that don't exist on this machine or aren't allowed.`);

  // Workspace folders must exist here; repositories are cloned again (clones aren't in backups) from URLs that must
  // still pass the checks new ones do.
  let droppedSources = 0;
  tables.workspace_sources = rowsOf("workspace_sources").filter((row) => {
    const ok =
      row.kind === "folder"
        ? typeof row.path === "string" && !workingDirectoryProblem(row.path)
        : row.kind === "git" &&
          typeof row.url === "string" &&
          !("error" in parseGitUrl(row.url)) &&
          (row.branch == null || (typeof row.branch === "string" && isValidBranch(row.branch))) &&
          typeof row.path === "string" &&
          isSafeCloneDir(row.path);
    if (!ok) droppedSources++;
    else if (row.kind === "git") Object.assign(row, { error: null, commit_sha: null, head_branch: null, synced_at: null });
    return ok;
  });
  if (droppedSources) warnings.push(`Removed ${droppedSources} workspace folder(s) or repositories that don't exist on this machine or aren't allowed.`);

  // Computer use: shared windows/screens belong to the machine they were shared on, and unattended control of this
  // computer is something the human turns on here, not something a backup grants.
  for (const row of rowsOf("conversations")) if (row.computer_target != null) row.computer_target = null;
  let computerAgents = 0;
  for (const row of rowsOf("agents")) {
    let enabled = false;
    try {
      enabled = typeof row.computer === "string" && (JSON.parse(row.computer) as { enabled?: unknown })?.enabled === true;
    } catch {
      /* malformed → reset below */
    }
    if (typeof row.computer === "string" && !enabled) continue;
    if (enabled) computerAgents++;
    row.computer = "{}";
  }
  if (computerAgents) warnings.push(`Turned off computer use for ${computerAgents} agent(s) — turn it back on in their settings if you trust them with this computer.`);

  // Automations: trigger JSON the database can't parse would break the scheduler's queries.
  const isJson = (v: unknown) => {
    if (typeof v !== "string") return false;
    try {
      return typeof JSON.parse(v) === "object";
    } catch {
      return false;
    }
  };
  let brokenTriggers = 0;
  for (const row of rowsOf("routines")) {
    if (row.trigger !== undefined && !isJson(row.trigger)) {
      row.trigger = '{"type":"schedule"}';
      row.enabled = 0;
      brokenTriggers++;
    }
    if (row.trigger_state !== undefined && !isJson(row.trigger_state)) row.trigger_state = "{}";
  }
  if (brokenTriggers) warnings.push(`Paused ${brokenTriggers} automation(s) whose trigger couldn't be read — set their trigger again.`);

  // VM ids become Tart VM names and folder names.
  const vms = rowsOf("vms");
  const safeVms = vms.filter((row) => typeof row.id === "string" && /^vm_[A-Za-z0-9]{8,64}$/.test(row.id));
  if (safeVms.length !== vms.length) {
    tables.vms = safeVms;
    warnings.push(`Skipped ${vms.length - safeVms.length} virtual machine(s) with an unsafe id.`);
  }

  const profiles = rowsOf("browser_profiles");
  const safeProfiles = profiles.filter((row) => typeof row.id === "string" && SAFE_ID.test(row.id));
  if (safeProfiles.length !== profiles.length) {
    tables.browser_profiles = safeProfiles;
    warnings.push(`Skipped ${profiles.length - safeProfiles.length} browser profile(s) with an unsafe id.`);
  }

  const reset: string[] = [];
  for (const row of rowsOf("settings")) {
    const section = String(row.key ?? "");
    const fields = EXECUTABLE_SETTINGS[section];
    if (!fields) continue;
    let value: unknown = null;
    try {
      value = typeof row.value === "string" ? JSON.parse(row.value) : null;
    } catch {
      /* corrupted section → defaults */
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      row.value = "{}";
      continue;
    }
    const obj = value as Record<string, unknown>;
    const defaults = DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS] as unknown as Record<string, unknown>;
    for (const field of fields) {
      if (!(field in obj)) continue;
      if (JSON.stringify(obj[field]) !== JSON.stringify(defaults[field])) reset.push(`${section}.${field}`);
      delete obj[field];
    }
    row.value = JSON.stringify(obj);
  }
  if (reset.length) {
    warnings.push(`Reset ${reset.join(", ")} to the default: settings that choose which programs Godmode runs are never restored from a backup.`);
  }

  const disabled: string[] = [];
  for (const row of rowsOf("mcp_servers")) {
    if ((row.transport ?? "stdio") !== "stdio") continue;
    if (row.enabled !== 0) disabled.push(String(row.name ?? row.id ?? "unnamed"));
    row.enabled = 0;
  }
  if (disabled.length) {
    warnings.push(
      `Disabled ${disabled.length} command-line MCP server(s) from the backup (${disabled.join(", ")}). Check their commands under Integrations before turning them back on.`,
    );
  }

  // A bot answers from one place: the machine the backup came from may still be running it.
  const bots: string[] = [];
  for (const row of rowsOf("messaging_connections")) {
    if (row.enabled !== 0) bots.push(String(row.name ?? row.id ?? "unnamed"));
    row.enabled = 0;
  }
  if (bots.length) {
    warnings.push(`Turned off ${bots.length} messaging bot(s) from the backup (${bots.join(", ")}). Turn them on under Messaging once no other Godmode runs them.`);
  }
  return warnings;
}

function restoreDatabase(dump: DbDump, vaultMeta: { kdf?: unknown; wrappedDek?: unknown; canary?: unknown } | null): Record<string, number> {
  const db = getDb();
  const cfg = config();
  const local = new Map(appTables().map((t) => [t, tableInfo(t)]));
  const counts: Record<string, number> = {};

  db.transaction(() => {
    // Rows are inserted in arbitrary order; foreign keys are verified at COMMIT.
    db.run("PRAGMA defer_foreign_keys = ON");
    for (const table of local.keys()) {
      if (table === "meta") {
        for (const r of all<{ key: string }>("SELECT key FROM meta")) {
          if (!isDeviceMetaKey(r.key)) db.query("DELETE FROM meta WHERE key = ?").run(r.key);
        }
      } else if (table === "settings") {
        db.run(`DELETE FROM settings WHERE key NOT IN (${[...DEVICE_SETTINGS].map((k) => `'${k}'`).join(", ")})`);
      } else if (table === "vms") {
        // VM disks live on this Mac: its VMs stay (the backup's version of a VM replaces the local record).
        for (const r of Array.isArray(dump.tables.vms) ? dump.tables.vms : []) {
          if (typeof r.id === "string") db.query("DELETE FROM vms WHERE id = ?").run(r.id);
        }
      } else {
        db.run(`DELETE FROM ${q(table)}`);
      }
    }

    for (const [table, rows] of Object.entries(dump.tables)) {
      const columns = local.get(table);
      if (!columns || !Array.isArray(rows)) {
        if (!columns) log.warn(`backup table ${table} does not exist in this version; skipped`);
        continue;
      }
      let n = 0;
      for (const raw of rows) {
        if (!raw || typeof raw !== "object") continue;
        const row: Record<string, string | number | null | Uint8Array> = {};
        for (const [k, v] of Object.entries(raw)) row[k] = decodeValue(v);
        if (table === "meta" && (isDeviceMetaKey(String(row.key)) || VAULT_META_KEYS.has(String(row.key)))) continue;
        if (table === "settings" && DEVICE_SETTINGS.has(String(row.key))) continue;
        // Paths are machine specific: point them at this machine's data directory.
        if (table === "agents" && typeof row.slug === "string") row.repo_path = join(cfg.agentsDir, row.slug);
        if (table === "browser_profiles" && typeof row.id === "string") row.user_data_dir = join(cfg.browserDir, row.id);

        const names: string[] = [];
        const values: (string | number | null | Uint8Array)[] = [];
        let skip = false;
        for (const col of columns) {
          if (col.name in row) {
            names.push(col.name);
            values.push(row[col.name]!);
          } else if (col.notnull && col.dflt_value === null) {
            // Column added after the backup was made: fill a neutral value (a missing key is fatal).
            if (col.pk) {
              skip = true;
              break;
            }
            names.push(col.name);
            values.push(/INT|REAL|NUM|FLOA|DOUB/i.test(col.type) ? 0 : "");
          }
        }
        if (skip || names.length === 0) continue;
        // OR IGNORE: a malformed backup with duplicate keys loses the duplicates instead of the whole restore.
        const res = db
          .query(`INSERT OR IGNORE INTO ${q(table)} (${names.map(q).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...values);
        n += res.changes;
      }
      counts[table] = n;
    }

    // Drop rows whose parents are missing instead of failing the whole restore.
    for (let pass = 0; pass < 5; pass++) {
      const violations = db.query("PRAGMA foreign_key_check").all() as { table: string; rowid: number | null }[];
      if (violations.length === 0) break;
      for (const v of violations) {
        if (v.rowid === null) continue;
        db.query(`DELETE FROM ${q(v.table)} WHERE rowid = ?`).run(v.rowid);
        if (counts[v.table]) counts[v.table]!--;
      }
    }

    if (vaultMeta && typeof vaultMeta.kdf === "string" && typeof vaultMeta.wrappedDek === "string") {
      vault.importVaultMeta({
        kdf: vaultMeta.kdf,
        wrappedDek: vaultMeta.wrappedDek,
        canary: typeof vaultMeta.canary === "string" ? vaultMeta.canary : null,
      });
    } else {
      // The backed-up installation had no vault yet.
      for (const key of VAULT_META_KEYS) db.query("DELETE FROM meta WHERE key = ?").run(key);
      vault.lock();
    }
  })();
  return counts;
}

/** Move the current contents of `baseDir` to `.trash/restore-<ts>/` and write the restored files. */
function restoreFiles(baseDir: string, files: PlannedFile[], stamp: string) {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const existing = readdirSync(baseDir).filter((n) => n !== ".trash");
  if (existing.length) {
    const trash = join(baseDir, ".trash", `restore-${stamp}`);
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    for (const name of existing) renameSync(join(baseDir, name), join(trash, name));
    log.info(`moved ${existing.length} existing entries of ${baseDir} to ${trash}`);
  }
  const root = resolve(baseDir);
  for (const f of files) {
    const target = resolve(root, f.top, ...f.segments);
    if (!target.startsWith(root + sep)) throw badRequest("Unsafe path in backup");
    if (f.dir) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    } else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, f.data, { mode: 0o600 });
    }
  }
}

export function importBackup(file: Uint8Array, passphrase: string, actor = "user"): Promise<BackupImportResult> {
  return withLock("import", async () => {
    if (typeof passphrase !== "string" || !passphrase) throw badRequest("Enter the passphrase of the backup");
    if (!file || file.byteLength === 0) throw badRequest("The backup file is empty");
    if (file.byteLength > MAX_BACKUP_BYTES) throw new HttpError(413, "The backup file is larger than 2 GB", "too_large");

    let archive: Uint8Array;
    try {
      archive = openWithPassphrase(passphrase, file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      throw badRequest(/not a godmode backup/i.test(msg) ? "This is not a Godmode backup file" : "Wrong backup passphrase or corrupted file", undefined);
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(archive);
    } catch {
      throw badRequest("The backup archive is corrupted");
    }

    const manifest = validateManifest(parseJsonEntry<unknown>(entries, "manifest.json"));
    const dump = parseJsonEntry<DbDump>(entries, "db.json");
    if (!dump || typeof dump.tables !== "object" || dump.tables === null) throw badRequest("The backup's db.json is corrupted");
    const vaultMeta = parseJsonEntry<{ kdf?: unknown; wrappedDek?: unknown; canary?: unknown } | null>(entries, "vault.json");
    if (vaultMeta && typeof vaultMeta.kdf === "string") {
      // The restored KDF parameters are used on every unlock: refuse ones that would exhaust memory/CPU.
      try {
        assertSafeKdf(JSON.parse(vaultMeta.kdf));
      } catch {
        throw badRequest("The backup's vault key uses unsupported parameters");
      }
    }

    // Files are only restored for agents whose original slug is a safe folder name (checked before renaming).
    const slugs = new Set(
      (Array.isArray(dump.tables.agents) ? dump.tables.agents : [])
        .map((r) => r.slug)
        .filter((s): s is string => typeof s === "string" && SAFE_ID.test(s)),
    );
    const warnings = sanitizeDump(dump);
    const profileIds = new Set((dump.tables.browser_profiles ?? []).map((r) => String(r.id)));
    const agentFiles = planFiles(entries, "agents", slugs);
    const browserFiles = planFiles(entries, "browser", profileIds);

    const active = get<{ c: number }>("SELECT COUNT(*) AS c FROM runs WHERE status IN ('queued', 'running')")?.c ?? 0;
    if (active > 0) throw conflict("Wait for running tasks to finish (or cancel them) before restoring a backup");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    stopScheduler();
    stopFollowups();
    stopAppTriggers();
    stopAutomationEvents();
    await stopMessaging();
    try {
      try {
        await shutdownBrowsers();
      } catch (err) {
        log.warn("could not stop browsers before restore", err instanceof Error ? err.message : err);
      }
      const counts = restoreDatabase(dump, vaultMeta);
      // Runs that were in progress when the backup was made will never finish, and events that were waiting then
      // are stale now: don't replay them.
      recoverInterruptedRuns();
      exec("UPDATE automation_events SET status = 'skipped', note = 'Restored from a backup' WHERE status = 'pending'");
      exec("DELETE FROM followups WHERE due_at <= ?", new Date().toISOString());
      // The restored vault has a different key: a key remembered on this device is obsolete.
      try {
        await vault.setRememberDevice(false);
      } catch (err) {
        log.warn("could not forget the remembered vault key", err instanceof Error ? err.message : err);
      }
      if (agentFiles.length) restoreFiles(config().agentsDir, agentFiles, stamp);
      if (browserFiles.length) restoreFiles(config().browserDir, browserFiles, stamp);

      resetSettingsCache();
      resetComposioState();
      applyRuntimeSettings(getSettings());

      const result = {
        ...counts,
        agentRepos: new Set(agentFiles.map((f) => f.top)).size,
        browserProfiles: new Set(browserFiles.map((f) => f.top)).size,
        files: agentFiles.filter((f) => !f.dir).length + browserFiles.filter((f) => !f.dir).length,
      };
      audit(actor, "backup.import", null, { createdAt: manifest.createdAt, appVersion: manifest.appVersion, counts: result, warnings });
      log.info(`backup from ${manifest.createdAt} restored`);
      for (const w of warnings) log.warn(w);
      for (const entity of ALL_ENTITIES) bus.changed(entity);
      bus.emit({ type: "vault.status", status: vault.status() });
      return { ok: true as const, counts: result, warnings };
    } finally {
      startScheduler();
      startFollowups();
      startAutomationEvents();
      startAppTriggers();
      startMessaging();
    }
  });
}
