/**
 * Mods: Claude Code mods the human installs (see `@godmode/shared` mods.ts). The database holds a mod's files; a run
 * gets them written to `<data>/mods/<name>/` and loaded with `--plugin-dir`, its options through the run's settings
 * file. A mod is only loaded when Claude Code's validator accepts it (check.ts) — the engine itself says nothing about
 * a mod it refuses. Only the human switches a mod on; code an agent wrote arrives switched off and marked for review.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Agent, Mod, ModCheck, ModIcon, ModInput, ModOption, ModOptionValue, ModOrigin, ModPatch, ModScope, ModTemplate } from "@godmode/shared";
import {
  MAX_MOD_BYTES,
  MAX_MOD_FILE_BYTES,
  MAX_MOD_FILES,
  MOD_ICONS,
  MOD_MANIFEST_PATH,
  MOD_NAME_RE,
  modAppliesTo,
  modNameFrom,
  modPathProblem,
} from "@godmode/shared";
import { config } from "../config";
import { all, bool, get, insert, run, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { badRequest, conflict, HttpError, newId, notFound, now, parseJson, truncate } from "../util";
import * as vault from "../vault/vault";
import { checkModFiles, claudeStamp, writeModFiles } from "./check";
import { fitsOption, manifestOptions, readManifest } from "./manifest";
import { blankModFiles, findModTemplate, listModTemplates, manifestJson } from "./templates";

const log = logger("mods");

/** Plugins Godmode and Claude Code load themselves. */
const RESERVED_NAMES = /^(claude-mem|cc-plugin-.*|godmode)$/;
const IMPORT_SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

interface ModRow {
  id: string;
  name: string;
  title: string;
  description: string;
  icon: string;
  origin: string;
  template_id: string | null;
  created_by: string;
  files: string;
  option_values: string;
  secrets_enc: string | null;
  secret_keys: string;
  enabled: number;
  needs_review: number;
  scope: string;
  agent_ids: string;
  check_report: string | null;
  check_key: string | null;
  created_at: string;
  updated_at: string;
}

type Values = Record<string, ModOptionValue>;

const secretsContext = (id: string) => `mods.secrets:${id}`;

/** A row's files. A restored backup or a synced setup wrote the row as it came: only paths that stay in the mod's folder count. */
function filesOf(row: ModRow): Record<string, string> {
  const stored = parseJson<Record<string, unknown>>(row.files, {});
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(stored ?? {})) {
    if (typeof content === "string" && !modPathProblem(path)) out[path] = content;
  }
  return out;
}

function optionsOf(files: Record<string, string>): ModOption[] {
  return manifestOptions(readManifest(files));
}

/** Saved values that still fit what the manifest declares (the code may have changed since they were saved). */
function valuesOf(row: ModRow, options: ModOption[]): Values {
  const stored = parseJson<Record<string, unknown>>(row.option_values, {});
  const out: Values = {};
  for (const option of options) {
    const value = stored[option.key];
    if (!option.sensitive && fitsOption(option, value)) out[option.key] = value;
  }
  return out;
}

function secretKeysOf(row: ModRow, options: ModOption[]): string[] {
  const saved = new Set(parseJson<string[]>(row.secret_keys, []));
  return options.filter((o) => o.sensitive && saved.has(o.key)).map((o) => o.key);
}

function existingAgents(): Set<string> {
  return new Set(all<{ id: string }>("SELECT id FROM agents").map((a) => a.id));
}

function toModel(row: ModRow, agents: Set<string>): Mod {
  const files = filesOf(row);
  const options = optionsOf(files);
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    icon: (MOD_ICONS as readonly string[]).includes(row.icon) ? (row.icon as ModIcon) : "puzzle",
    origin: (["template", "custom", "agent", "import"].includes(row.origin) ? row.origin : "custom") as ModOrigin,
    templateId: row.template_id,
    createdBy: row.created_by,
    enabled: bool(row.enabled),
    needsReview: bool(row.needs_review),
    scope: row.scope === "agents" ? "agents" : "all",
    agentIds: parseJson<string[]>(row.agent_ids, []).filter((id) => agents.has(id)),
    files,
    options,
    values: valuesOf(row, options),
    secretKeys: secretKeysOf(row, options),
    check: parseJson<ModCheck | null>(row.check_report, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): ModRow {
  const row = get<ModRow>("SELECT * FROM mods WHERE id = ?", id);
  if (!row) throw notFound("Mod");
  return row;
}

export function listMods(): Mod[] {
  const agents = existingAgents();
  return all<ModRow>("SELECT * FROM mods ORDER BY created_at, id").map((r) => toModel(r, agents));
}

export function getMod(id: string): Mod {
  return toModel(getRow(id), existingAgents());
}

/** By id or plugin name: how an agent names a mod. */
export function findMod(ref: string): Mod | null {
  const row = get<ModRow>("SELECT * FROM mods WHERE id = ? OR name = ?", ref, ref);
  return row ? toModel(row, existingAgents()) : null;
}

export function listTemplates(): ModTemplate[] {
  return listModTemplates();
}

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

function cleanTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) throw badRequest("Give the mod a name");
  return title.trim().slice(0, 80);
}

function cleanDescription(description: unknown): string {
  return typeof description === "string" ? description.trim().slice(0, 500) : "";
}

function cleanIcon(icon: unknown): ModIcon {
  if (!(MOD_ICONS as readonly string[]).includes(icon as string)) throw badRequest(`icon must be one of: ${MOD_ICONS.join(", ")}`);
  return icon as ModIcon;
}

function cleanName(name: unknown): string {
  if (typeof name !== "string" || !MOD_NAME_RE.test(name)) {
    throw badRequest("A mod's name is 2–48 lowercase letters, digits and dashes, starting with a letter");
  }
  if (RESERVED_NAMES.test(name)) throw badRequest(`"${name}" is a name Godmode or Claude Code uses itself`);
  return name;
}

function nameTaken(name: string): boolean {
  return !!get<{ id: string }>("SELECT id FROM mods WHERE name = ?", name);
}

function freeName(base: string): string {
  const root = RESERVED_NAMES.test(base) ? `${base}-mod` : base;
  let name = root;
  for (let n = 2; nameTaken(name); n++) name = `${root.slice(0, 44)}-${n}`;
  return name;
}

/** The files as they are kept: checked paths and sizes, and a manifest that carries the mod's name. */
function cleanFiles(name: string, input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw badRequest("files must be an object of path → text");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_MOD_FILES) throw badRequest(`A mod has at most ${MAX_MOD_FILES} files`);
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  let total = 0;
  for (const [path, content] of entries) {
    const problem = modPathProblem(path);
    if (problem) throw badRequest(problem);
    if (typeof content !== "string" || content.includes("\0")) throw badRequest(`${path} must be a text file`);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_MOD_FILE_BYTES) throw badRequest(`${path} is larger than ${MAX_MOD_FILE_BYTES / 1000} KB`);
    total += bytes;
    // One name in two spellings is one file on macOS and Windows.
    const key = path.toLowerCase();
    if (seen.has(key)) throw badRequest(`${path} is there twice`);
    seen.add(key);
    out[path] = content;
  }
  if (total > MAX_MOD_BYTES) throw badRequest(`A mod's files add up to at most ${MAX_MOD_BYTES / 1000} KB`);
  for (const path of seen) {
    if ([...seen].some((other) => other.startsWith(`${path}/`))) throw badRequest(`${path} is both a file and a folder`);
  }
  if (!(MOD_MANIFEST_PATH in out)) throw badRequest(`A mod needs its manifest, ${MOD_MANIFEST_PATH}`);
  const manifest = readManifest(out);
  if (!manifest) throw badRequest(`${MOD_MANIFEST_PATH} must be a JSON object`);
  if (manifest.name !== name) out[MOD_MANIFEST_PATH] = manifestJson("name" in manifest ? { ...manifest, name } : { name, ...manifest });
  return out;
}

function cleanScope(scope: unknown): ModScope {
  if (scope !== "all" && scope !== "agents") throw badRequest('scope must be "all" or "agents"');
  return scope;
}

function cleanAgentIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw badRequest("agentIds must be a list of agent ids");
  const known = existingAgents();
  const unique = [...new Set(ids as string[])];
  const unknown = unique.find((id) => !known.has(id));
  if (unknown) throw badRequest(`Agent ${unknown} does not exist`);
  return unique;
}

function digestOf(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\0`);
  return hash.digest("hex");
}

function checkKey(files: Record<string, string>): string {
  return `${digestOf(files)}|${claudeStamp() ?? ""}`;
}

/** Secret option values; throws 423 while the vault is locked. */
function openSecrets(row: ModRow): Record<string, string> {
  if (!row.secrets_enc) return {};
  const values = parseJson<Record<string, string>>(vault.open(row.secrets_enc, secretsContext(row.id)), {});
  vault.rememberSecretValues(values);
  return values;
}

function sealSecrets(id: string, values: Record<string, string>): string | null {
  if (Object.keys(values).length === 0) return null;
  vault.rememberSecretValues(values);
  return vault.seal(JSON.stringify(values), secretsContext(id));
}

/** The first required option that has neither a value nor a default. */
function missingOption(options: ModOption[], values: Values, secretKeys: string[]): ModOption | null {
  return options.find((o) => o.required && o.default === null && !(o.sensitive ? secretKeys.includes(o.key) : o.key in values)) ?? null;
}

/** The first problem in one line, without the reminder of the API's spelling the validator appends to it. */
function firstError(check: ModCheck): string {
  const e = check.errors[0];
  return e ? truncate(`${e.where}: ${e.message.split("; $ is always spelled")[0]}`, 300) : "Claude Code refused it";
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

interface NewMod {
  name: string;
  title: string;
  description: string;
  icon: ModIcon;
  origin: ModOrigin;
  templateId: string | null;
  files: Record<string, string>;
  enabled: boolean;
  scope: ModScope;
  agentIds: string[];
}

async function insertMod(mod: NewMod, actor: string): Promise<Mod> {
  const check = await checkModFiles(mod.name, mod.files);
  const byAgent = actor.startsWith("agent:");
  // A mod that is on from the start has to load: one the check refuses, or with an option still to fill in, waits.
  const ready = (!check || check.ok) && !missingOption(optionsOf(mod.files), {}, []);
  const id = newId("mod");
  const ts = now();
  insert("mods", {
    id,
    name: mod.name,
    title: mod.title,
    description: mod.description,
    icon: mod.icon,
    origin: mod.origin,
    template_id: mod.templateId,
    created_by: actor,
    files: JSON.stringify(mod.files),
    option_values: "{}",
    secrets_enc: null,
    secret_keys: "[]",
    enabled: mod.enabled && ready && !byAgent ? 1 : 0,
    needs_review: byAgent ? 1 : 0,
    scope: mod.scope,
    agent_ids: JSON.stringify(mod.agentIds),
    check_report: check ? JSON.stringify(check) : null,
    check_key: check ? checkKey(mod.files) : null,
    created_at: ts,
    updated_at: ts,
  });
  audit(actor, "mod.create", id, { name: mod.name, origin: mod.origin, files: Object.keys(mod.files) });
  bus.changed("mods");
  return getMod(id);
}

export async function createMod(input: ModInput, actor = "user"): Promise<Mod> {
  if (!input || typeof input !== "object") throw badRequest("Invalid mod");
  const template = input.templateId ? findModTemplate(input.templateId) : null;
  if (input.templateId && !template) throw badRequest(`There is no mod "${input.templateId}" in the gallery`);
  const title = cleanTitle(input.title ?? template?.title);
  let name: string;
  if (input.name !== undefined) {
    name = cleanName(input.name);
    if (nameTaken(name)) throw conflict(`There already is a mod named "${name}"`);
  } else name = freeName(template?.id ?? modNameFrom(title));
  const description = cleanDescription(input.description ?? template?.description);
  return insertMod(
    {
      name,
      title,
      description,
      icon: input.icon !== undefined ? cleanIcon(input.icon) : (template?.icon ?? "puzzle"),
      origin: template ? "template" : actor.startsWith("agent:") ? "agent" : "custom",
      templateId: template?.id ?? null,
      files: cleanFiles(name, input.files ?? template?.files ?? blankModFiles(name, description || title)),
      // The gallery's mods are Godmode's own: adding one switches it on.
      enabled: input.enabled ?? !!template,
      scope: input.scope !== undefined ? cleanScope(input.scope) : "all",
      agentIds: input.agentIds !== undefined ? cleanAgentIds(input.agentIds) : [],
    },
    actor,
  );
}

export async function updateMod(id: string, patch: ModPatch, actor = "user"): Promise<Mod> {
  const row = getRow(id);
  if (!patch || typeof patch !== "object") throw badRequest("Invalid mod update");
  const byAgent = actor.startsWith("agent:");
  const changes: Record<string, string | number | null> = { updated_at: now() };
  if (patch.title !== undefined) changes.title = cleanTitle(patch.title);
  if (patch.description !== undefined) changes.description = cleanDescription(patch.description);
  if (patch.icon !== undefined) changes.icon = cleanIcon(patch.icon);
  if (patch.scope !== undefined) changes.scope = cleanScope(patch.scope);
  if (patch.agentIds !== undefined) changes.agent_ids = JSON.stringify(cleanAgentIds(patch.agentIds));

  let files = filesOf(row);
  let check = parseJson<ModCheck | null>(row.check_report, null);
  let codeChanged = false;
  if (patch.files !== undefined) {
    const next = cleanFiles(row.name, patch.files);
    codeChanged = digestOf(next) !== digestOf(files);
    files = next;
  }
  if (codeChanged) {
    check = await checkModFiles(row.name, files);
    changes.files = JSON.stringify(files);
    changes.check_report = check ? JSON.stringify(check) : null;
    changes.check_key = check ? checkKey(files) : null;
    // Code the human never saw doesn't run: an agent's change waits for them.
    if (byAgent) Object.assign(changes, { enabled: 0, needs_review: 1 });
  }

  const options = optionsOf(files);
  let values = valuesOf(row, options);
  let secretKeys = secretKeysOf(row, options);
  if (patch.values !== undefined) {
    if (typeof patch.values !== "object" || patch.values === null || Array.isArray(patch.values)) throw badRequest("values must be an object");
    values = { ...values };
    let secrets: Record<string, string> | null = null;
    for (const [key, value] of Object.entries(patch.values)) {
      const option = options.find((o) => o.key === key);
      if (!option) throw badRequest(`The mod has no option "${key}"`);
      if (option.sensitive) {
        secrets ??= openSecrets(row);
        if (value === null || value === "") delete secrets[key];
        else if (typeof value === "string" && value.length <= 16_384) secrets[key] = value;
        else throw badRequest(`"${option.title}" must be text`);
      } else if (value === null) delete values[key];
      else if (fitsOption(option, value)) values[key] = value;
      else throw badRequest(`"${option.title}" doesn't take that value`);
    }
    changes.option_values = JSON.stringify(values);
    if (secrets) {
      secretKeys = options.filter((o) => o.sensitive && o.key in secrets).map((o) => o.key);
      changes.secrets_enc = sealSecrets(id, secrets);
      changes.secret_keys = JSON.stringify(secretKeys);
    }
  }

  if (patch.enabled !== undefined && !byAgent) {
    if (patch.enabled) {
      if (check && !check.ok) throw conflict(`Fix the mod before you switch it on — ${firstError(check)}`);
      const missing = missingOption(options, values, secretKeys);
      if (missing) throw conflict(`Set "${missing.title}" under Options before you switch the mod on.`);
      // Switching it on is the human's OK for the code as it stands.
      changes.needs_review = 0;
    }
    changes.enabled = patch.enabled ? 1 : 0;
  }

  update("mods", id, changes);
  audit(actor, "mod.update", id, {
    name: row.name,
    ...(codeChanged ? { files: Object.keys(files) } : {}),
    ...(changes.enabled !== undefined ? { enabled: changes.enabled === 1 } : {}),
    ...(patch.values !== undefined ? { options: Object.keys(patch.values) } : {}),
  });
  bus.changed("mods");
  return getMod(id);
}

export function deleteMod(id: string, actor = "user"): void {
  const row = getRow(id);
  run("DELETE FROM mods WHERE id = ?", id);
  rmSync(modDir(row.name), { recursive: true, force: true });
  audit(actor, "mod.delete", id, { name: row.name });
  bus.changed("mods");
}

/** Check a saved mod again (after a Claude Code update, or when it couldn't be checked before). */
export async function recheckMod(id: string): Promise<Mod> {
  const row = getRow(id);
  await storeCheck(row, filesOf(row));
  bus.changed("mods");
  return getMod(id);
}

async function storeCheck(row: ModRow, files: Record<string, string>): Promise<ModCheck | null> {
  const check = await checkModFiles(row.name, files);
  run("UPDATE mods SET check_report = ?, check_key = ? WHERE id = ?", check ? JSON.stringify(check) : null, check ? checkKey(files) : null, row.id);
  return check;
}

/** Check files that aren't saved (the editor's "Check"). */
export async function checkUnsaved(files: unknown): Promise<ModCheck | null> {
  const name = readManifestName(files) ?? "mod";
  return checkModFiles(name, cleanFiles(name, files));
}

function readManifestName(files: unknown): string | null {
  if (typeof files !== "object" || files === null) return null;
  const text = (files as Record<string, unknown>)[MOD_MANIFEST_PATH];
  const name = typeof text === "string" ? readManifest({ [MOD_MANIFEST_PATH]: text })?.name : null;
  return typeof name === "string" && MOD_NAME_RE.test(name) ? name : null;
}

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

function readPluginFolder(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (IMPORT_SKIP_DIRS.has(entry.name) || path === ".claude-plugin/types") continue;
      // Links could lead anywhere on the computer.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) {
        if (Object.keys(files).length >= MAX_MOD_FILES) throw badRequest(`The folder has more than ${MAX_MOD_FILES} files — a mod is a small plugin`);
        if (statSync(join(dir, entry.name)).size > MAX_MOD_FILE_BYTES) throw badRequest(`${path} is larger than ${MAX_MOD_FILE_BYTES / 1000} KB`);
        const content = readFileSync(join(dir, entry.name), "utf8");
        if (content.includes("\0")) throw badRequest(`${path} isn't a text file — mods with sounds or images can't be imported yet`);
        files[path] = content;
      }
    }
  };
  walk(root, "");
  return files;
}

/** Add a Claude Code plugin folder from this computer. It arrives switched off. */
export async function importMod(path: unknown, actor = "user"): Promise<Mod> {
  if (typeof path !== "string" || !isAbsolute(path.trim())) throw badRequest("Enter the full path of the plugin's folder");
  const root = path.trim();
  if (!existsSync(root) || !statSync(root).isDirectory()) throw badRequest(`${root} isn't a folder on this computer`);
  if (!existsSync(join(root, ...MOD_MANIFEST_PATH.split("/")))) {
    throw badRequest(`${root} is no Claude Code plugin: it has no ${MOD_MANIFEST_PATH}`);
  }
  const files = readPluginFolder(root);
  const manifest = readManifest(files);
  if (!manifest) throw badRequest(`${MOD_MANIFEST_PATH} must be a JSON object`);
  const declared = typeof manifest.name === "string" ? manifest.name : "";
  const name = cleanName(MOD_NAME_RE.test(declared) ? declared : modNameFrom(declared));
  if (nameTaken(name)) throw conflict(`There already is a mod named "${name}"`);
  const words = name.replace(/-/g, " ");
  return insertMod(
    {
      name,
      title: words.charAt(0).toUpperCase() + words.slice(1),
      description: cleanDescription(manifest.description),
      icon: "puzzle",
      origin: "import",
      templateId: null,
      files: cleanFiles(name, files),
      enabled: false,
      scope: "all",
      agentIds: [],
    },
    actor,
  );
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

export function modDir(name: string): string {
  return join(config().dataDir, "mods", name);
}

/** Claude Code lays its type declarations (and a tsconfig for them) beside a mod it loads: those stay. */
function isEngineFile(path: string, files: Record<string, string>): boolean {
  return path.startsWith(".claude-plugin/types/") || (path === "tsconfig.json" && !("tsconfig.json" in files));
}

/** Make the folder hold exactly the mod's files: whatever else got there (a run may write anywhere) is removed. */
function syncModDir(dir: string, files: Record<string, string>) {
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), path);
      else if (!entry.isFile() || !(path in files || isEngineFile(path, files))) rmSync(join(at, entry.name), { recursive: true, force: true });
    }
  };
  walk(dir, "");
  const stale: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    let current = false;
    try {
      current = lstatSync(full).isFile() && readFileSync(full, "utf8") === content;
    } catch {
      /* not there */
    }
    if (current) continue;
    rmSync(full, { recursive: true, force: true });
    stale[path] = content;
  }
  writeModFiles(dir, stale);
}

/**
 * Where a mod loads among the others — the first sees an event first and its result last. Insight mods go first, so
 * they see every call, refused ones included; guardrails go last, so they judge a call as it will run, after anything
 * another mod rewrote. The human's own mods sit between.
 */
function loadRank(row: ModRow): number {
  const category = row.template_id ? findModTemplate(row.template_id)?.category : undefined;
  return category === "insight" ? 0 : category === "privacy" ? 2 : category === "guardrails" ? 3 : 1;
}

export interface RunMods {
  /** One `--plugin-dir` each, in load order (see `loadRank`; within a rank, the order the mods were added). */
  dirs: string[];
  /** `pluginConfigs` for the run's settings file: the options of the mods that have any set. */
  configs: Record<string, { options: Record<string, ModOptionValue> }>;
}

/**
 * The mods a run of `agent` loads, written to disk. A mod that is switched on but can't be loaded (the check fails,
 * an option is missing, its secrets are locked) is left out and named through `onNotice` — the human relies on it.
 */
export async function modsForRun(agent: Pick<Agent, "id">, onNotice: (text: string) => void): Promise<RunMods> {
  const out: RunMods = { dirs: [], configs: {} };
  const agents = existingAgents();
  const rows = all<ModRow>("SELECT * FROM mods WHERE enabled = 1 ORDER BY created_at, id")
    .filter((row) =>
      modAppliesTo({ scope: row.scope === "agents" ? "agents" : "all", agentIds: parseJson<string[]>(row.agent_ids, []).filter((id) => agents.has(id)) }, agent.id),
    )
    .map((row, i) => ({ row, i, rank: loadRank(row) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.row);
  if (rows.length === 0) return out;
  const stamp = claudeStamp();
  let rechecked = false;
  const checks = await Promise.all(
    rows.map(async (row) => {
      const files = filesOf(row);
      if (row.check_key === `${digestOf(files)}|${stamp ?? ""}`) return parseJson<ModCheck | null>(row.check_report, null);
      // Another Claude Code than the one that checked it: what loaded yesterday may be refused today.
      rechecked = true;
      return storeCheck(row, files).catch((err) => {
        log.warn(`could not check the mod ${row.name}`, err);
        return null;
      });
    }),
  );
  if (rechecked) bus.changed("mods");
  rows.forEach((row, i) => {
    const skip = (why: string) => onNotice(`The mod "${row.title}" wasn't loaded: ${why} Fix it under Mods.`);
    const check = checks[i];
    if (check && !check.ok) return skip(`${firstError(check)}.`);
    const files = filesOf(row);
    const options = optionsOf(files);
    const values: Record<string, ModOptionValue> = valuesOf(row, options);
    const secretKeys = secretKeysOf(row, options);
    if (secretKeys.length) {
      try {
        const secrets = openSecrets(row);
        for (const key of secretKeys) if (key in secrets) values[key] = secrets[key]!;
      } catch (err) {
        return skip(err instanceof HttpError && err.status === 423 ? "its secret options need the vault unlocked." : "its secret options couldn't be read.");
      }
    }
    const missing = missingOption(options, values, secretKeys);
    if (missing) return skip(`its option "${missing.title}" has no value.`);
    try {
      const dir = modDir(row.name);
      syncModDir(dir, files);
      out.dirs.push(dir);
      if (Object.keys(values).length) out.configs[row.name] = { options: values };
    } catch (err) {
      log.warn(`could not write the mod ${row.name}`, err);
      skip("its files couldn't be written.");
    }
  });
  return out;
}
