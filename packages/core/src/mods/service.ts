/**
 * Plugins (mods in the code; see `@godmode/shared` mods.ts). The database holds a small plugin's files; a run gets its
 * own copy under `<data>/mods/<run-id>/` and loads it with `--plugin-dir`, its options through the run's settings file.
 * A plugin from a git repository lies in a checkout of its installed commit (git.ts) that runs load as it is. A plugin is
 * only loaded when Claude Code's validator accepts it (check.ts) — the engine itself says nothing about a plugin it
 * refuses. Only the human switches a plugin on; code an agent wrote or installed arrives switched off and marked for
 * review.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  Agent,
  Mod,
  ModCatalogEntry,
  ModCheck,
  ModContents,
  ModIcon,
  ModInput,
  ModInstallInput,
  ModOption,
  ModOptionValue,
  ModOrigin,
  ModPatch,
  ModScope,
  ModSource,
  ModTemplate,
} from "@godmode/shared";
import {
  isValidBranch,
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
import type { McpServerJson } from "../types";
import { badRequest, conflict, HttpError, newId, notFound, now, parseJson, truncate } from "../util";
import * as vault from "../vault/vault";
import { listCatalog } from "./catalog";
import { checkMod, checkPluginFolder, claudeStamp, filesDigest, writeModFiles } from "./check";
import {
  alwaysOnTokens,
  checkoutPath,
  checkoutsRoot,
  cleanPath,
  cloneAt,
  cloneLatest,
  contentsStartPrograms,
  gitTarget,
  inventory,
  keyFiles,
  latestCommit,
  manifestVersion,
  pluginDirIn,
  pluginMcpServers,
  remoteVersion,
  resolvePlugin,
  validateTarget,
  writeManifest,
} from "./git";
import { fitsOption, manifestOptions, readManifest } from "./manifest";
import { blankModFiles, findModTemplate, listModTemplates, manifestJson } from "./templates";

const log = logger("mods");

/** Plugins Godmode and Claude Code load themselves. */
const RESERVED_NAMES = /^(claude-mem|cc-plugin-.*|godmode)$/;
const IMPORT_SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);
/** Run ids name the folder a run's mods are copied to. */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_MOD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
/** How often plugins from repositories are looked up for a newer commit. */
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;

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
  source: string | null;
  contents: string | null;
  created_at: string;
  updated_at: string;
}

type Values = Record<string, ModOptionValue>;

const secretsContext = (id: string) => `mods.secrets:${id}`;

/** A JSON column as an object: a restored backup or a synced setup wrote the row as it came. */
function objectOf(json: string | null): Record<string, unknown> {
  const parsed = parseJson<unknown>(json, null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function stringsOf(json: string | null): string[] {
  const parsed = parseJson<unknown>(json, null);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

/** A row's files: only paths that stay in the mod's folder count. */
function filesOf(row: ModRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(objectOf(row.files))) {
    if (typeof content === "string" && !modPathProblem(path)) out[path] = content;
  }
  return out;
}

function optionsOf(files: Record<string, string>): ModOption[] {
  return manifestOptions(readManifest(files));
}

/** Saved values that fit what the manifest declares. */
function valuesOf(row: ModRow, options: ModOption[]): Values {
  const stored = objectOf(row.option_values);
  const out: Values = {};
  for (const option of options) {
    const value = stored[option.key];
    if (!option.sensitive && fitsOption(option, value)) out[option.key] = value;
  }
  return out;
}

function secretKeysOf(row: ModRow, options: ModOption[]): string[] {
  const saved = new Set(stringsOf(row.secret_keys));
  return options.filter((o) => o.sensitive && saved.has(o.key)).map((o) => o.key);
}

function checkOf(row: ModRow): ModCheck | null {
  const check = objectOf(row.check_report);
  return typeof check.ok === "boolean" && [check.errors, check.warnings, check.hooks, check.calls].every(Array.isArray)
    ? (check as unknown as ModCheck)
    : null;
}

/** Where a plugin from a repository comes from; null for one whose files Godmode keeps. */
function sourceOf(row: Pick<ModRow, "source">): ModSource | null {
  const s = objectOf(row.source);
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  if (typeof s.url !== "string" || typeof s.commit !== "string" || !COMMIT.test(s.commit)) return null;
  const latest = text(s.latestCommit);
  // A restored backup or a synced setup wrote the row as it came: a folder or ref that leads elsewhere makes it no source.
  const ref = text(s.ref);
  if (ref !== null && !isValidBranch(ref)) return null;
  let path: string;
  try {
    path = cleanPath(text(s.path) ?? "");
  } catch {
    return null;
  }
  return {
    url: s.url,
    repo: text(s.repo) ?? s.url,
    web: text(s.web),
    ref,
    path,
    commit: s.commit,
    version: text(s.version),
    installedAt: text(s.installedAt) ?? "",
    latestCommit: latest && COMMIT.test(latest) ? latest : null,
    latestVersion: text(s.latestVersion),
    checkedAt: text(s.checkedAt),
    checkError: text(s.checkError),
  };
}

function contentsOf(row: Pick<ModRow, "contents">): ModContents | null {
  const c = objectOf(row.contents);
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (!Array.isArray(c.skills)) return null;
  return {
    skills: names(c.skills),
    commands: names(c.commands),
    agents: names(c.agents),
    hooks: names(c.hooks),
    mcpServers: names(c.mcpServers),
    files: typeof c.files === "number" ? c.files : 0,
    bytes: typeof c.bytes === "number" ? c.bytes : 0,
    alwaysOnTokens: typeof c.alwaysOnTokens === "number" ? c.alwaysOnTokens : null,
  };
}

/** Which code a plugin is: its files, or the commit of its repository. The human's OK and every check are for it. */
function codeDigest(row: Pick<ModRow, "source">, files: Record<string, string>): string {
  const source = sourceOf(row);
  return source ? `git:${source.commit}` : filesDigest(files);
}

function scopeOf(row: ModRow): ModScope {
  return row.scope === "agents" ? "agents" : "all";
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
    origin: (["template", "custom", "agent", "import", "git"].includes(row.origin) ? row.origin : "custom") as ModOrigin,
    templateId: row.template_id,
    createdBy: row.created_by,
    enabled: bool(row.enabled),
    needsReview: bool(row.needs_review),
    scope: scopeOf(row),
    agentIds: stringsOf(row.agent_ids).filter((id) => agents.has(id)),
    files,
    digest: codeDigest(row, files),
    options,
    values: valuesOf(row, options),
    secretKeys: secretKeysOf(row, options),
    check: checkOf(row),
    source: sourceOf(row),
    contents: contentsOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): ModRow {
  const row = get<ModRow>("SELECT * FROM mods WHERE id = ?", id);
  if (!row) throw notFound("Plugin");
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

export function listModCatalog(): ModCatalogEntry[] {
  return listCatalog();
}

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

function cleanTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) throw badRequest("Give the plugin a name");
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
    throw badRequest("A plugin's name is 2–48 lowercase letters, digits and dashes, starting with a letter");
  }
  if (RESERVED_NAMES.test(name)) throw badRequest(`"${name}" is a name Godmode or Claude Code uses itself`);
  return name;
}

function nameTaken(name: string): boolean {
  return !!get<{ id: string }>("SELECT id FROM mods WHERE name = ?", name);
}

function freeName(base: string): string {
  const root = RESERVED_NAMES.test(base) ? `${base.slice(0, 44)}-mod` : base;
  let name = root;
  for (let n = 2; nameTaken(name); n++) name = `${root.slice(0, 44)}-${n}`;
  return name;
}

/** The files as they are kept: checked paths and sizes, and a manifest that carries the mod's name. */
function cleanFiles(name: string, input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw badRequest("files must be an object of path → text");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_MOD_FILES) throw badRequest(`A plugin has at most ${MAX_MOD_FILES} files here — install a larger one from its git repository`);
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
  if (total > MAX_MOD_BYTES) throw badRequest(`A plugin's files add up to at most ${MAX_MOD_BYTES / 1000} KB here — install a larger one from its git repository`);
  for (const path of seen) {
    if ([...seen].some((other) => other.startsWith(`${path}/`))) throw badRequest(`${path} is both a file and a folder`);
  }
  if (!Object.hasOwn(out, MOD_MANIFEST_PATH)) throw badRequest(`A plugin needs its manifest, ${MOD_MANIFEST_PATH}`);
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

function checkKey(row: Pick<ModRow, "source">, files: Record<string, string>): string {
  return `${codeDigest(row, files)}|${claudeStamp() ?? ""}`;
}

/** The saved secret option values; throws 423 while the vault is locked. */
function openSecrets(row: ModRow, keys: string[]): Record<string, string> {
  if (!row.secrets_enc || keys.length === 0) return {};
  const stored = parseJson<unknown>(vault.open(row.secrets_enc, secretsContext(row.id)), null);
  const out: Record<string, string> = {};
  if (typeof stored !== "object" || stored === null) return out;
  // Only what `secret_keys` still names: a value whose option the code dropped doesn't come back with a later version.
  for (const key of keys) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  vault.rememberSecretValues(out);
  return out;
}

function sealSecrets(id: string, values: Record<string, string>): string | null {
  if (Object.keys(values).length === 0) return null;
  vault.rememberSecretValues(values);
  return vault.seal(JSON.stringify(values), secretsContext(id));
}

/** The first required option that has neither a value nor a default. */
function missingOption(options: ModOption[], values: Values, secretKeys: string[]): ModOption | null {
  const has = (o: ModOption) => (o.sensitive ? secretKeys.includes(o.key) : values[o.key] !== undefined && values[o.key] !== "");
  return options.find((o) => o.required && (o.default === null || o.default === "") && !has(o)) ?? null;
}

/** The first problem in one line, without the reminder of the API's spelling the validator appends to it. */
function firstError(check: ModCheck): string {
  const e = check.errors[0];
  return e ? truncate(`${e.where}: ${e.message.split("; $ is always spelled")[0]}`, 300) : "Claude Code refused it";
}

interface Checked {
  check: ModCheck | null;
  columns: { check_report: string | null; check_key: string | null };
}

/** Check the files and say what goes into the row: a check that gave no report keeps no key, so it is asked again. */
async function checked(name: string, files: Record<string, string>): Promise<Checked> {
  const { check, retry } = await checkMod(name, files);
  return { check, columns: { check_report: check ? JSON.stringify(check) : null, check_key: check && !retry ? checkKey({ source: null }, files) : null } };
}

/** Check a plugin from a repository in its checkout. */
async function checkedFolder(row: Pick<ModRow, "source">, dir: string, files: Record<string, string>, contents: ModContents): Promise<Checked> {
  const { check, retry } = await checkPluginFolder(dir, validateTarget(dir), files, contentsStartPrograms(dir, contents));
  return { check, columns: { check_report: check ? JSON.stringify(check) : null, check_key: check && !retry ? checkKey(row, files) : null } };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

interface NewMod {
  /** Given when the id names a checkout already laid down. */
  id?: string;
  name: string;
  /** The name was made up from the title: when it got taken meanwhile, another is as good. */
  anyName: boolean;
  title: string;
  description: string;
  icon: ModIcon;
  origin: ModOrigin;
  templateId: string | null;
  files: Record<string, string>;
  enabled: boolean;
  scope: ModScope;
  agentIds: string[];
  /** A plugin from a repository: where it comes from, what it brings and what the check said in its checkout. */
  git?: { source: ModSource; contents: ModContents; checked: Checked };
}

async function insertMod(mod: NewMod, actor: string): Promise<Mod> {
  const { check, columns } = mod.git?.checked ?? (await checked(mod.name, mod.files));
  const byAgent = actor.startsWith("agent:");
  // A mod that is on from the start has to load: one the check refuses, or with an option still to fill in, waits.
  const ready = (!check || check.ok) && !missingOption(optionsOf(mod.files), {}, []);
  // The check took a moment: another request may have taken the name meanwhile.
  let name = mod.name;
  if (nameTaken(name)) {
    if (!mod.anyName) throw conflict(`There already is a plugin named "${name}"`);
    name = freeName(name);
  }
  const files = name === mod.name ? mod.files : cleanFiles(name, mod.files);
  const id = mod.id ?? newId("mod");
  const ts = now();
  insert("mods", {
    id,
    name,
    title: mod.title,
    description: mod.description,
    icon: mod.icon,
    origin: mod.origin,
    template_id: mod.templateId,
    created_by: actor,
    files: JSON.stringify(files),
    option_values: "{}",
    secrets_enc: null,
    secret_keys: "[]",
    enabled: mod.enabled && ready && !byAgent ? 1 : 0,
    needs_review: byAgent ? 1 : 0,
    scope: mod.scope,
    agent_ids: JSON.stringify(mod.agentIds),
    check_report: columns.check_report,
    check_key: columns.check_key && name === mod.name ? columns.check_key : null,
    source: mod.git ? JSON.stringify(mod.git.source) : null,
    contents: mod.git ? JSON.stringify(mod.git.contents) : null,
    created_at: ts,
    updated_at: ts,
  });
  audit(actor, "mod.create", id, { name, origin: mod.origin, ...(mod.git ? { repo: mod.git.source.repo, commit: mod.git.source.commit } : { files: Object.keys(files) }) });
  bus.changed("mods");
  return getMod(id);
}

export async function createMod(input: ModInput, actor = "user"): Promise<Mod> {
  if (!input || typeof input !== "object") throw badRequest("Invalid plugin");
  // A gallery mod is Godmode's code as it ships: other files under its label would be on from the start, unread.
  if (input.templateId && input.files !== undefined) throw badRequest("Add the gallery plugin first, then change its code");
  const template = input.templateId ? findModTemplate(input.templateId) : null;
  if (input.templateId && !template) throw badRequest(`There is no plugin "${input.templateId}" in the gallery`);
  const title = cleanTitle(input.title ?? template?.title);
  let name: string;
  if (input.name !== undefined) {
    name = cleanName(input.name);
    if (nameTaken(name)) throw conflict(`There already is a plugin named "${name}"`);
  } else name = freeName(template?.id ?? modNameFrom(title));
  const description = cleanDescription(input.description ?? template?.description);
  return insertMod(
    {
      name,
      anyName: input.name === undefined,
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

/** `agentMaySwitch`: a manager agent's plugin_update, which the human allowed to switch plugins on and off. */
export async function updateMod(id: string, patch: ModPatch, actor = "user", opts: { agentMaySwitch?: boolean } = {}): Promise<Mod> {
  let row = getRow(id);
  if (!patch || typeof patch !== "object") throw badRequest("Invalid plugin update");
  const byAgent = actor.startsWith("agent:");
  const source = sourceOf(row);
  if (source && patch.files !== undefined) throw badRequest("A plugin from a repository changes when you update it, not by editing its files here");
  const changes: Record<string, string | number | null> = { updated_at: now() };
  if (patch.title !== undefined) changes.title = cleanTitle(patch.title);
  if (patch.description !== undefined) changes.description = cleanDescription(patch.description);
  if (patch.icon !== undefined) changes.icon = cleanIcon(patch.icon);
  if (patch.scope !== undefined) changes.scope = cleanScope(patch.scope);
  if (patch.agentIds !== undefined) changes.agent_ids = JSON.stringify(cleanAgentIds(patch.agentIds));

  let files = filesOf(row);
  let check = checkOf(row);
  let codeChanged = false;
  if (patch.files !== undefined) {
    const next = cleanFiles(row.name, patch.files);
    codeChanged = filesDigest(next) !== filesDigest(files);
    files = next;
  }
  const options = optionsOf(files);
  let values = valuesOf(row, options);
  let secretKeys = secretKeysOf(row, options);
  if (codeChanged) {
    const result = await checked(row.name, files);
    check = result.check;
    Object.assign(changes, result.columns, {
      files: JSON.stringify(files),
      // What the new code no longer declares is forgotten for good, not kept for a later version to pick up.
      option_values: JSON.stringify(values),
      secret_keys: JSON.stringify(secretKeys),
    });
    // Code the human never saw doesn't run: an agent's change waits for them.
    if (byAgent) Object.assign(changes, { enabled: 0, needs_review: 1 });
    // A gallery mod with other code is no longer the gallery's.
    const template = row.template_id ? findModTemplate(row.template_id) : null;
    if (template && filesDigest(cleanFiles(row.name, template.files)) !== filesDigest(files)) Object.assign(changes, { origin: byAgent ? "agent" : "custom", template_id: null });
  }

  if (patch.values !== undefined) {
    if (typeof patch.values !== "object" || patch.values === null || Array.isArray(patch.values)) throw badRequest("values must be an object");
    values = { ...values };
    let secrets: Record<string, string> | null = null;
    for (const [key, value] of Object.entries(patch.values)) {
      const option = options.find((o) => o.key === key);
      if (!option) throw badRequest(`The plugin has no option "${key}"`);
      if (option.sensitive) {
        secrets ??= openSecrets(row, secretKeys);
        if (value === null || value === "") delete secrets[key];
        else if (typeof value === "string" && value.length <= 16_384) secrets[key] = value;
        else throw badRequest(`"${option.title}" must be text`);
      } else if (value === null) delete values[key];
      else if (fitsOption(option, value)) values[key] = value;
      else throw badRequest(`"${option.title}" doesn't take that value`);
    }
    changes.option_values = JSON.stringify(values);
    if (secrets) {
      const kept = secrets;
      secretKeys = options.filter((o) => o.sensitive && Object.hasOwn(kept, o.key)).map((o) => o.key);
      changes.secrets_enc = sealSecrets(id, kept);
      changes.secret_keys = JSON.stringify(secretKeys);
    }
  }

  if (patch.enabled !== undefined && (!byAgent || opts.agentMaySwitch)) {
    if (patch.enabled) {
      // Hook code an agent wrote itself runs inside every turn: the human reads it before it does.
      if (byAgent && !source && !row.template_id && row.created_by.startsWith("agent:") && bool(row.needs_review)) {
        throw new HttpError(403, "This plugin is a draft an agent wrote: the human reads its code and switches it on under Plugins.", "forbidden");
      }
      // The human's OK is for the code they read: an agent may have saved another version since the page loaded.
      if (patch.digest !== undefined && patch.digest !== codeDigest(row, files)) {
        throw conflict("The code changed since you opened this plugin. Read it again, then switch it on.");
      }
      // A checkout that is gone (a restored backup) comes back first: there is nothing to check or load without it.
      if (source) {
        await ensureCheckout(row);
        row = getRow(id);
      }
      // A report about other code, or from another Claude Code, says nothing about what would load now.
      if (!codeChanged && row.check_key !== checkKey(row, files)) {
        const result = source ? await checkedFolder(row, gitPluginDir(row.id, source), files, contentsOf(row) ?? inventory(gitPluginDir(row.id, source))) : await checked(row.name, files);
        check = result.check;
        Object.assign(changes, result.columns);
        run("UPDATE mods SET check_report = ?, check_key = ? WHERE id = ?", result.columns.check_report, result.columns.check_key, id);
      }
      if (check && !check.ok) throw conflict(`${source ? "Claude Code refuses this plugin" : "Fix the plugin before you switch it on"} — ${firstError(check)}`);
      const missing = missingOption(options, values, secretKeys);
      if (missing) throw conflict(`Set "${missing.title}" under Options before you switch the plugin on.`);
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
    ...(changes.scope !== undefined ? { scope: changes.scope } : {}),
    ...(patch.agentIds !== undefined ? { agents: patch.agentIds.length } : {}),
  });
  bus.changed("mods");
  return getMod(id);
}

export function deleteMod(id: string, actor = "user"): void {
  const row = getRow(id);
  run("DELETE FROM mods WHERE id = ?", id);
  audit(actor, "mod.delete", id, { name: row.name, ...(row.source ? { repo: sourceOf(row)?.repo } : {}) });
  bus.changed("mods");
  // Its checkouts go once no run holds them.
  if (row.source) tidyCheckouts();
}

/** Check a saved mod again (after a Claude Code update, or when it couldn't be checked before). */
export async function recheckMod(id: string): Promise<Mod> {
  const row = getRow(id);
  await storeCheck(row, filesOf(row));
  bus.changed("mods");
  return getMod(id);
}

async function storeCheck(row: ModRow, files: Record<string, string>): Promise<ModCheck | null> {
  const source = sourceOf(row);
  if (source) {
    await ensureCheckout(row);
    const dir = gitPluginDir(row.id, source);
    const { check, columns } = await checkedFolder(row, dir, files, contentsOf(row) ?? inventory(dir));
    run("UPDATE mods SET check_report = ?, check_key = ? WHERE id = ? AND source = ?", columns.check_report, columns.check_key, row.id, row.source);
    return check;
  }
  const { check, columns } = await checked(row.name, files);
  // Only for the code that was checked: the human may have saved another version meanwhile.
  run("UPDATE mods SET check_report = ?, check_key = ? WHERE id = ? AND files = ?", columns.check_report, columns.check_key, row.id, row.files);
  return check;
}

/** Check files that aren't saved (the editor's "Check"). */
export async function checkUnsaved(files: unknown): Promise<ModCheck | null> {
  const name = readManifestName(files) ?? "mod";
  return (await checkMod(name, cleanFiles(name, files))).check;
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
      if (IMPORT_SKIP_DIRS.has(entry.name) || path.toLowerCase() === ".claude-plugin/types") continue;
      // Links could lead anywhere on the computer.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) {
        if (Object.keys(files).length >= MAX_MOD_FILES) throw badRequest(`The folder has more than ${MAX_MOD_FILES} files — install a plugin this large from its git repository`);
        if (statSync(join(dir, entry.name)).size > MAX_MOD_FILE_BYTES) throw badRequest(`${path} is larger than ${MAX_MOD_FILE_BYTES / 1000} KB`);
        const content = readFileSync(join(dir, entry.name), "utf8");
        if (content.includes("\0")) throw badRequest(`${path} isn't a text file — install a plugin with sounds or images from its git repository`);
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
  if (nameTaken(name)) throw conflict(`There already is a plugin named "${name}"`);
  const words = name.replace(/-/g, " ");
  return insertMod(
    {
      name,
      anyName: false,
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
/* Plugins from git repositories                                        */
/* ------------------------------------------------------------------ */

/** The folder a run loads for a plugin from a repository. */
function gitPluginDir(id: string, source: ModSource): string {
  return pluginDirIn(checkoutPath(id, source.commit), source.path);
}

/** Checkouts being laid down (installs, updates, restores): not tidied away meanwhile. */
const busyCheckouts = new Set<string>();
/** The checkouts each run loaded: kept until the run ends, also when the plugin was updated or uninstalled meanwhile. */
const runCheckouts = new Map<string, Set<string>>();
const restoring = new Map<string, Promise<void>>();

function titleFrom(name: string): string {
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sameRepo(a: string, b: string): boolean {
  const norm = (url: string) => url.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function stagingPath(id: string): string {
  return join(checkoutsRoot(), id, `.staging-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
}

interface Laid {
  source: ModSource;
  contents: ModContents;
  files: Record<string, string>;
  description: string;
  checked: Checked;
}

/**
 * Clone the newest commit of `target` for plugin `id`, find the plugin in it, and check it there. The checkout ends up
 * at its commit's place; on failure nothing is left behind.
 */
async function layDown(
  id: string,
  target: { url: string; repo: string; web: string | null; ref: string | null; path: string },
  plugin: string | undefined,
  fallbackName: string,
  want: (name: string) => void,
  /** The commit that is installed: when the clone is that one, there is nothing to lay down (null). */
  current: string | null = null,
): Promise<(Laid & { name: string }) | null> {
  if (!SAFE_MOD_ID.test(id)) throw badRequest("This plugin's record is damaged. Uninstall it and install it again.");
  const staging = stagingPath(id);
  busyCheckouts.add(staging);
  let final: string | null = null;
  let fresh = false;
  try {
    const commit = await cloneLatest(target.url, target.ref, staging);
    if (commit === current) return null;
    const resolved = resolvePlugin(staging, target.path, plugin, fallbackName);
    want(resolved.name);
    if (resolved.manifest) writeManifest(pluginDirIn(staging, resolved.path), resolved.manifest);
    final = checkoutPath(id, commit);
    busyCheckouts.add(final);
    // A checkout of this commit that is still there (a run holds an earlier version) is the same files: it stays.
    if (!existsSync(final)) {
      renameSync(staging, final);
      fresh = true;
    }
    const dir = pluginDirIn(final, resolved.path);
    const contents = inventory(dir);
    contents.alwaysOnTokens = await alwaysOnTokens(dir, resolved.name).catch(() => null);
    const files = keyFiles(dir);
    const ts = now();
    const source: ModSource = {
      url: target.url,
      repo: target.repo,
      web: target.web,
      ref: target.ref,
      path: resolved.path,
      commit,
      version: manifestVersion(dir),
      installedAt: ts,
      latestCommit: commit,
      latestVersion: manifestVersion(dir),
      checkedAt: ts,
      checkError: null,
    };
    const result = await checkedFolder({ source: JSON.stringify(source) }, dir, files, contents);
    return { name: resolved.name, source, contents, files, description: resolved.description, checked: result };
  } catch (err) {
    if (final && fresh) rmSync(final, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    busyCheckouts.delete(staging);
    if (final) busyCheckouts.delete(final);
  }
}

/** Tidy the checkouts without failing what called for it: the record is what counts. */
function tidyCheckouts(): void {
  try {
    pruneCheckouts();
  } catch (err) {
    log.warn("could not tidy plugin checkouts", err);
  }
}

/**
 * Install a plugin from a git repository: "owner/repo", a GitHub link or a clone URL. The human's install switches it on
 * (unless `enabled: false`) when the check passes; an agent's arrives switched off, for the human to review.
 */
export async function installMod(input: ModInstallInput, actor = "user"): Promise<Mod> {
  if (!input || typeof input !== "object" || typeof input.source !== "string") throw badRequest("Name the repository to install from");
  const catalog = input.catalogId ? (listCatalog().find((entry) => entry.id === input.catalogId) ?? null) : null;
  if (input.catalogId && !catalog) throw badRequest(`There is no plugin "${input.catalogId}" in the catalog`);
  const target = gitTarget(catalog ? catalog.repo : input.source, input.ref);
  // Told before anything is downloaded where it is certain; a repository with several plugins is told by the name below.
  const installed = listMods().find((m) => m.source && sameRepo(m.source.url, target.url) && m.source.path === target.path && (input.plugin ? m.name === input.plugin : !!catalog));
  if (installed) throw conflict(`${installed.title} is installed already. Update it from its page instead.`);
  const id = newId("mod");
  const nameCheck = (name: string) => {
    if (RESERVED_NAMES.test(name)) throw badRequest(`"${name}" is a name Godmode or Claude Code uses itself`);
    if (nameTaken(name)) throw conflict(`A plugin named "${name}" is installed already`);
  };
  const byAgent = actor.startsWith("agent:");
  try {
    const laid = (await layDown(id, target, input.plugin, target.repo.split("/").at(-1) ?? target.repo, nameCheck))!;
    nameCheck(laid.name);
    return await insertMod(
      {
        id,
        name: laid.name,
        anyName: false,
        title: catalog?.title ?? titleFrom(laid.name),
        description: cleanDescription(catalog?.description ?? laid.description),
        icon: catalog?.icon ?? "puzzle",
        origin: "git",
        templateId: null,
        files: laid.files,
        enabled: !byAgent && input.enabled !== false,
        scope: "all",
        agentIds: [],
        git: { source: laid.source, contents: laid.contents, checked: laid.checked },
      },
      actor,
    );
  } catch (err) {
    rmSync(join(checkoutsRoot(), id), { recursive: true, force: true });
    throw err;
  }
}

/** One update at a time per plugin. */
const updating = new Map<string, Promise<Mod>>();

/**
 * Bring a plugin from a repository to the newest commit of what it follows. The new version replaces the old one only
 * when Claude Code accepts it; runs under way keep the version they loaded. An agent's update waits for the human's OK.
 */
export function updateGitMod(id: string, actor = "user"): Promise<Mod> {
  let pending = updating.get(id);
  if (!pending) {
    pending = doUpdate(id, actor).finally(() => updating.delete(id));
    updating.set(id, pending);
  }
  return pending;
}

async function doUpdate(id: string, actor: string): Promise<Mod> {
  const row = getRow(id);
  const source = sourceOf(row);
  if (!source) throw badRequest("Only plugins installed from a repository can be updated");
  const upToDate = () => {
    run("UPDATE mods SET source = ? WHERE id = ? AND source = ?", JSON.stringify({ ...source, latestCommit: source.commit, latestVersion: source.version, checkedAt: now(), checkError: null }), id, row.source);
    bus.changed("mods");
    return getMod(id);
  };
  if ((await latestCommit(source.url, source.ref)) === source.commit) return upToDate();
  const laid = await layDown(
    id,
    { ...source },
    row.name,
    row.name,
    (name) => {
      if (name !== row.name) throw conflict(`The new version calls itself "${name}" instead of "${row.name}". Uninstall the plugin and install it again.`);
    },
    source.commit,
  );
  if (!laid) return upToDate();
  if (laid.checked.check && !laid.checked.check.ok) {
    tidyCheckouts();
    throw conflict(`Claude Code refuses the new version, so ${row.title} stays as it is — ${firstError(laid.checked.check)}`);
  }
  const current = getRow(id);
  const byAgent = actor.startsWith("agent:");
  const options = optionsOf(laid.files);
  update("mods", id, {
    files: JSON.stringify(laid.files),
    source: JSON.stringify({ ...laid.source, installedAt: now() }),
    contents: JSON.stringify(laid.contents),
    option_values: JSON.stringify(valuesOf(current, options)),
    secret_keys: JSON.stringify(secretKeysOf(current, options)),
    ...laid.checked.columns,
    ...(byAgent ? { enabled: 0, needs_review: 1 } : {}),
    updated_at: now(),
  });
  audit(actor, "mod.update", id, { name: row.name, repo: source.repo, from: source.commit, to: laid.source.commit });
  bus.changed("mods");
  tidyCheckouts();
  return getMod(id);
}

let checkingUpdates: Promise<Mod[]> | null = null;

/** Look up the newest commit of every plugin from a repository (or of `ids`). A failed lookup is noted on the plugin. */
export function checkModUpdates(ids?: string[]): Promise<Mod[]> {
  if (!ids && checkingUpdates) return checkingUpdates;
  const work = (async () => {
    const rows = all<ModRow>("SELECT * FROM mods WHERE source IS NOT NULL ORDER BY created_at, id").filter((row) => !ids || ids.includes(row.id));
    await Promise.all(
      rows.map(async (row) => {
        const source = sourceOf(row);
        if (!source) return;
        let next: ModSource;
        try {
          const latest = await latestCommit(source.url, source.ref);
          const latestVersion = latest === source.commit ? source.version : latest === source.latestCommit ? source.latestVersion : await remoteVersion(source.repo, source.web, source.path, latest);
          next = { ...source, latestCommit: latest, latestVersion, checkedAt: now(), checkError: null };
        } catch (err) {
          next = { ...source, checkedAt: now(), checkError: err instanceof Error ? truncate(err.message, 300) : "The repository couldn't be reached." };
        }
        // Only over the version that was looked at: an update may have landed meanwhile.
        run("UPDATE mods SET source = ? WHERE id = ? AND source = ?", JSON.stringify(next), row.id, row.source);
      }),
    );
    if (rows.length) bus.changed("mods");
    return listMods().filter((m) => m.source && (!ids || ids.includes(m.id)));
  })();
  if (!ids) checkingUpdates = work.finally(() => (checkingUpdates = null));
  return work;
}

let updateTimer: ReturnType<typeof setInterval> | null = null;

/** Look for updates a minute after start and every few hours: the Plugins page and the sidebar say when one is waiting. */
export function startModUpdates(): void {
  if (updateTimer) return;
  const due = () => {
    const stale = all<ModRow>("SELECT * FROM mods WHERE source IS NOT NULL")
      .filter((row) => {
        const checkedAt = sourceOf(row)?.checkedAt;
        return !checkedAt || Date.now() - Date.parse(checkedAt) > UPDATE_CHECK_EVERY_MS - 60_000;
      })
      .map((row) => row.id);
    if (stale.length) checkModUpdates(stale).catch((err) => log.warn("could not look for plugin updates", err));
  };
  setTimeout(due, 60_000).unref?.();
  updateTimer = setInterval(due, UPDATE_CHECK_EVERY_MS);
  updateTimer.unref?.();
}

export function stopModUpdates(): void {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
}

/** A checkout that is gone (a restored backup, a runner that hasn't loaded the plugin yet) comes back at its commit. */
async function ensureCheckout(row: ModRow): Promise<void> {
  const source = sourceOf(row);
  if (!source || !SAFE_MOD_ID.test(row.id)) return;
  const final = checkoutPath(row.id, source.commit);
  if (existsSync(pluginDirIn(final, source.path))) return;
  const key = `${row.id}:${source.commit}`;
  let pending = restoring.get(key);
  if (!pending) {
    pending = (async () => {
      const staging = stagingPath(row.id);
      busyCheckouts.add(staging);
      try {
        await cloneAt(source.url, source.commit, staging);
        // A plugin that ships no manifest got one at install: exactly that one comes back, never one derived anew.
        const recorded = parseJson<Record<string, unknown> | null>(filesOf(row)[MOD_MANIFEST_PATH], null);
        const dir = pluginDirIn(staging, source.path);
        if (recorded && !existsSync(join(dir, ...MOD_MANIFEST_PATH.split("/")))) writeManifest(dir, recorded);
        if (!existsSync(pluginDirIn(final, source.path))) {
          rmSync(final, { recursive: true, force: true });
          renameSync(staging, final);
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
        busyCheckouts.delete(staging);
      }
    })().finally(() => restoring.delete(key));
    restoring.set(key, pending);
  }
  await pending;
}

/** Remove checkouts no plugin points at and no run holds: older versions, uninstalled plugins, interrupted installs. */
export function pruneCheckouts(): void {
  const root = checkoutsRoot();
  if (!existsSync(root)) return;
  const current = new Map<string, string>();
  for (const row of all<Pick<ModRow, "id" | "source">>("SELECT id, source FROM mods WHERE source IS NOT NULL")) {
    const source = sourceOf(row);
    if (source) current.set(row.id, checkoutPath(row.id, source.commit));
  }
  const held = new Set([...runCheckouts.values()].flatMap((dirs) => [...dirs]));
  const keep = (path: string) => [...busyCheckouts, ...held].some((p) => p === path || p.startsWith(`${path}/`));
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const version of readdirSync(dir)) {
      const path = join(dir, version);
      if (path === current.get(id) || keep(path)) continue;
      rmSync(path, { recursive: true, force: true });
    }
    if (!current.has(id) && !keep(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

function modsRoot(): string {
  return join(config().dataDir, "mods");
}

/** Where a run's copy of a mod lies. A copy per run: a run that writes into its mods reaches no other run's. */
export function runModDir(runId: string, name: string): string {
  return join(modsRoot(), runId, name);
}

/** A run ended: its copy of the mods goes, and the checkouts it held may be tidied away. */
export function removeRunMods(runId: string): void {
  if (SAFE_RUN_ID.test(runId)) rmSync(join(modsRoot(), runId), { recursive: true, force: true });
  if (runCheckouts.delete(runId)) tidyCheckouts();
}

/** At startup no run is at work: what crashed runs left behind goes, and checkouts nothing points at. */
export function clearRunMods(): void {
  rmSync(modsRoot(), { recursive: true, force: true });
  tidyCheckouts();
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
  /** The MCP servers the loaded plugins declare, for the run's MCP config (the only place a run takes servers from). */
  mcpServers: Record<string, McpServerJson>;
}

/** Where a plugin keeps data of its own between runs (`${CLAUDE_PLUGIN_DATA}`). */
function pluginDataDir(name: string): string {
  return join(config().dataDir, "plugins", "data", name);
}

/**
 * The mods a run of `agent` loads, copied to the run's own folder. A mod that is switched on but can't be loaded (the
 * check fails, an option is missing, its secrets are locked) is left out and named through `onNotice` — the human
 * relies on it.
 */
export async function modsForRun(agent: Pick<Agent, "id">, runId: string, onNotice: (text: string) => void): Promise<RunMods> {
  const out: RunMods = { dirs: [], configs: {}, mcpServers: {} };
  const loadServers = (dir: string, name: string, values: Record<string, ModOptionValue>) => {
    try {
      const servers = pluginMcpServers(dir, name, pluginDataDir(name), values);
      if (Object.keys(servers).length) mkdirSync(pluginDataDir(name), { recursive: true, mode: 0o700 });
      Object.assign(out.mcpServers, servers);
    } catch (err) {
      log.warn(`could not read the MCP servers of the plugin ${name}`, err);
    }
  };
  const agents = existingAgents();
  const rows = all<ModRow>("SELECT * FROM mods WHERE enabled = 1 ORDER BY created_at, id")
    .filter((row) => modAppliesTo({ scope: scopeOf(row), agentIds: stringsOf(row.agent_ids).filter((id) => agents.has(id)) }, agent.id))
    .map((row, i) => ({ row, i, rank: loadRank(row) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.row);
  if (rows.length === 0 || !SAFE_RUN_ID.test(runId)) return out;
  const stamp = claudeStamp();
  let rechecked = false;
  // A plugin from a repository whose checkout isn't here yet (a runner, a restored backup) is cloned first.
  const unavailable = new Map<string, string>();
  // Held from here on: an update that lands while this run waits for a clone or a check doesn't take its version away.
  for (const row of rows) {
    const source = sourceOf(row);
    if (!source || !SAFE_MOD_ID.test(row.id)) continue;
    const held = runCheckouts.get(runId) ?? new Set<string>();
    held.add(checkoutPath(row.id, source.commit));
    runCheckouts.set(runId, held);
  }
  await Promise.all(
    rows
      .filter((row) => row.source)
      .map((row) =>
        ensureCheckout(row).catch((err) => {
          log.warn(`could not lay down the plugin ${row.name}`, err);
          unavailable.set(row.id, err instanceof Error ? err.message : "its repository couldn't be reached.");
        }),
      ),
  );
  const checks = await Promise.all(
    rows.map(async (row) => {
      const files = filesOf(row);
      if (unavailable.has(row.id)) return null;
      if (row.check_key === `${codeDigest(row, files)}|${stamp ?? ""}`) return checkOf(row);
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
    const skip = (why: string) => onNotice(`The plugin "${row.title}" wasn't loaded: ${why} Fix it under Plugins.`);
    const failed = unavailable.get(row.id);
    if (failed) return skip(`its files couldn't be downloaded (${truncate(failed.replace(/\.$/, ""), 200)}).`);
    const check = checks[i];
    if (check && !check.ok) return skip(`${firstError(check)}.`);
    const files = filesOf(row);
    const options = optionsOf(files);
    const values: Record<string, ModOptionValue> = valuesOf(row, options);
    const secretKeys = secretKeysOf(row, options);
    if (secretKeys.length) {
      try {
        Object.assign(values, openSecrets(row, secretKeys));
      } catch (err) {
        return skip(err instanceof HttpError && err.status === 423 ? "its secret options need the vault unlocked." : "its secret options couldn't be read.");
      }
    }
    const missing = missingOption(options, values, secretKeys);
    if (missing) return skip(`its option "${missing.title}" has no value.`);
    const source = sourceOf(row);
    // A record that says it comes from a repository but names none that can be trusted isn't loaded from its leftovers.
    if (!source && row.origin === "git") return skip("its record is damaged. Uninstall it and install it again.");
    if (source) {
      const dir = gitPluginDir(row.id, source);
      if (!SAFE_MOD_ID.test(row.id) || !existsSync(dir)) return skip("its files are missing.");
      out.dirs.push(dir);
      if (Object.keys(values).length) out.configs[row.name] = { options: values };
      loadServers(dir, row.name, values);
      return;
    }
    try {
      const dir = runModDir(runId, row.name);
      rmSync(dir, { recursive: true, force: true });
      writeModFiles(dir, files);
      out.dirs.push(dir);
      if (Object.keys(values).length) out.configs[row.name] = { options: values };
      loadServers(dir, row.name, values);
    } catch (err) {
      log.warn(`could not write the mod ${row.name}`, err);
      skip("its files couldn't be written.");
    }
  });
  return out;
}
