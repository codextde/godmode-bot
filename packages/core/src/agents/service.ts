/**
 * Agents (bots): CRUD, per-agent git repository and generated files (CLAUDE.md, MEMORY.md, state/agent.json).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Agent,
  AgentBrowserConfig,
  AgentCharacter,
  AgentFileEntry,
  AgentInput,
  AgentPermissions,
  AgentStatus,
  Effort,
  GitCommit,
  Settings,
  SubagentDefinition,
} from "@godmode/shared";
import {
  DEFAULT_AGENT_SLUG,
  EFFORT_OPTIONS,
  MASCOT_CHARACTER,
  MASCOT_COLOR,
  defaultCharacter,
  normalizeCharacter,
  parseCharacter,
} from "@godmode/shared";
import { config } from "../config";
import { all, bool, get, getMeta, insert, int, json, run, setMeta, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { normalizeWorkingDirectory } from "../services/folders";
import { onSettingsApplied } from "../services/runtime";
import { getSettings } from "../services/settings";
import { DEFAULT_AGENT_COMPUTER, normalizeAgentComputer } from "../computer/targets";
import { detachAgentComputer } from "../computer/service";
import { cancelRun, waitForRun } from "../runner/runner";
import { reloadSchedules } from "../scheduler/scheduler";
import { requestAppTriggerSync } from "../integrations/composioTriggers";
import { badRequest, newId, notFound, now, parseJson, slugify } from "../util";
import { assignmentsChanged, normalizeVmId } from "../vm/assignments";
import { normalizeSshServerIds, parseServerIds } from "../ssh/assignments";
import {
  AGENT_GITIGNORE,
  AGENT_REPO_DIRS,
  missingGitignoreRules,
  renderAgentState,
  renderClaudeMd,
  renderMemoryMd,
} from "./claudeMd";
import * as repo from "./repo";

const log = logger("agents");

interface AgentRow {
  id: string;
  workspace_id: string | null;
  name: string;
  slug: string;
  avatar: string;
  color: string;
  character: string | null;
  personality: string | null;
  description: string;
  instructions: string;
  model: string;
  effort: string | null;
  is_default: number;
  enabled: number;
  status: string;
  permissions: string;
  browser: string;
  computer: string;
  mcp_server_ids: string;
  inherit_mcp: number;
  subagents: string;
  working_directory: string | null;
  vm_id: string | null;
  ssh_server_ids: string;
  repo_path: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const BASE_PERMISSIONS: AgentPermissions = {
  canManageAgents: false,
  allowDelegation: true,
  delegateTo: [],
  secretAccess: "fill",
  credentialIds: null,
  totpIds: null,
  maxBudgetUsd: null,
};

const DEFAULT_BROWSER: AgentBrowserConfig = { profileId: null, enabled: true, headless: null };

const DEFAULT_AGENT_INSTRUCTIONS = `You are the human's main assistant and the orchestrator of their team of Godmode agents.

- Handle one-off requests yourself when you can do them well: research, writing, analysis, web tasks in the browser, logins through the vault.
- Delegate specialized or ongoing work to the agent that owns it (agents_list, agent_delegate). Give full context and check the result before you report back.
- When the human describes recurring work ("every morning…", "each month…", "keep an eye on…"), propose a dedicated agent and, once the details are clear, create it with focused instructions and a routine (cron + the human's timezone). Confirm the name, the schedule and what the agent should report.
- Supervise the team: when asked for status, check agents_list and runs_list for failed runs, stuck agents and missing logins, and suggest concrete fixes (clearer instructions, a missing login, a better schedule).
- Keep agents lean: one clear responsibility each and least privilege — only grant secret reveal access or agent management when truly needed.
- Remember the human's preferences, projects, tools and people in MEMORY.md so every agent you set up benefits from them.`;

const DEFAULT_AGENT_INPUT: AgentInput = {
  name: "Godmode",
  avatar: "⚡",
  color: MASCOT_COLOR,
  character: MASCOT_CHARACTER,
  personality: "buddy",
  description: "Your main AI coworker. Ask it anything — it can also create, configure and supervise your other agents.",
  instructions: DEFAULT_AGENT_INSTRUCTIONS,
  permissions: { canManageAgents: true, allowDelegation: true },
};

/* ------------------------------------------------------------------ */
/* Mapping + normalization                                             */
/* ------------------------------------------------------------------ */

function repoPathFor(slug: string): string {
  return join(config().agentsDir, slug);
}

function trashDir(): string {
  return join(config().agentsDir, ".trash");
}

/** The stored look; none stored = the agent's stable default (the mascot for the built-in agent). */
function characterOf(r: Pick<AgentRow, "id" | "character" | "is_default">): AgentCharacter {
  if (!bool(r.is_default)) return parseCharacter(r.character, r.id);
  return normalizeCharacter(parseJson<unknown>(r.character, null), MASCOT_CHARACTER);
}

const MAX_PERSONALITY = 2000;

function normalizePersonality(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, MAX_PERSONALITY);
}

function toModel(r: AgentRow): Agent {
  const enabled = bool(r.enabled);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    slug: r.slug,
    avatar: r.avatar,
    color: r.color,
    character: characterOf(r),
    personality: r.personality ?? "",
    description: r.description,
    instructions: r.instructions,
    model: r.model,
    effort: (EFFORT_OPTIONS as readonly string[]).includes(r.effort ?? "") ? (r.effort as Effort) : null,
    isDefault: bool(r.is_default),
    enabled,
    status: enabled ? (r.status as AgentStatus) : "disabled",
    permissions: normalizePermissions({ ...BASE_PERMISSIONS, ...parseJson<Partial<AgentPermissions>>(r.permissions, {}) }),
    browser: normalizeBrowser({ ...DEFAULT_BROWSER, ...parseJson<Partial<AgentBrowserConfig>>(r.browser, {}) }),
    computer: normalizeAgentComputer(parseJson<unknown>(r.computer, {})),
    mcpServerIds: existingMcpServerIds(stringList(parseJson<unknown>(r.mcp_server_ids, []))),
    inheritMcp: bool(r.inherit_mcp),
    subagents: normalizeSubagents(parseJson<unknown>(r.subagents, [])),
    workingDirectory: r.working_directory,
    vmId: r.vm_id ?? null,
    sshServerIds: parseServerIds(r.ssh_server_ids),
    // Derived from the slug so the data dir can move (backup restore, GODMODE_HOME change).
    repoPath: repoPathFor(r.slug),
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRow(a: Agent): Record<string, string | number | null> {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    name: a.name,
    slug: a.slug,
    avatar: a.avatar,
    color: a.color,
    character: json(a.character)!,
    personality: a.personality,
    description: a.description,
    instructions: a.instructions,
    model: a.model,
    effort: a.effort,
    is_default: int(a.isDefault)!,
    enabled: int(a.enabled)!,
    status: a.status,
    permissions: json(a.permissions)!,
    browser: json(a.browser)!,
    computer: json(a.computer)!,
    mcp_server_ids: json(a.mcpServerIds)!,
    inherit_mcp: int(a.inheritMcp)!,
    subagents: json(a.subagents)!,
    working_directory: a.workingDirectory,
    vm_id: a.vmId,
    ssh_server_ids: json(a.sshServerIds)!,
    repo_path: a.repoPath,
    last_run_at: a.lastRunAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))];
}

/** Drop ids of MCP servers that were deleted since they were attached (they are pruned on the next update). */
function existingMcpServerIds(ids: string[]): string[] {
  if (!ids.length) return ids;
  const found = new Set(
    all<{ id: string }>(`SELECT id FROM mcp_servers WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids).map((r) => r.id),
  );
  return ids.filter((id) => found.has(id));
}

function normalizePermissions(p: AgentPermissions): AgentPermissions {
  const budget = typeof p.maxBudgetUsd === "number" && Number.isFinite(p.maxBudgetUsd) && p.maxBudgetUsd > 0 ? p.maxBudgetUsd : null;
  return {
    canManageAgents: p.canManageAgents === true,
    allowDelegation: p.allowDelegation !== false,
    delegateTo: stringList(p.delegateTo),
    secretAccess: p.secretAccess === "reveal" ? "reveal" : "fill",
    credentialIds: Array.isArray(p.credentialIds) ? stringList(p.credentialIds) : null,
    totpIds: Array.isArray(p.totpIds) ? stringList(p.totpIds) : null,
    maxBudgetUsd: budget,
  };
}

function normalizeBrowser(b: AgentBrowserConfig): AgentBrowserConfig {
  return {
    profileId: typeof b.profileId === "string" && b.profileId ? b.profileId : null,
    enabled: b.enabled !== false,
    headless: typeof b.headless === "boolean" ? b.headless : null,
  };
}

function normalizeSubagents(v: unknown): SubagentDefinition[] {
  if (!Array.isArray(v)) return [];
  const out: SubagentDefinition[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") continue;
    const { name, description, prompt, model } = s as Record<string, unknown>;
    if (typeof name !== "string" || typeof description !== "string" || typeof prompt !== "string") continue;
    const def: SubagentDefinition = { name: name.trim(), description: description.trim(), prompt };
    if (typeof model === "string" && model.trim()) def.model = model.trim();
    if (def.name && def.description && def.prompt.trim()) out.push(def);
  }
  return out;
}

function validateEffort(effort: Effort | null | undefined): Effort | null {
  if (effort == null) return null;
  if (!(EFFORT_OPTIONS as readonly string[]).includes(effort)) {
    throw badRequest(`Invalid effort "${effort}" (expected ${EFFORT_OPTIONS.join(", ")})`);
  }
  return effort;
}

function assertWorkspace(workspaceId: string) {
  if (!get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) throw badRequest("Workspace not found");
}

function assertBrowserProfile(profileId: string | null) {
  if (profileId && !get<{ id: string }>("SELECT id FROM browser_profiles WHERE id = ?", profileId)) {
    throw badRequest("Browser profile not found");
  }
}

function defaultPermissions(settings: Settings): AgentPermissions {
  return { ...BASE_PERMISSIONS, secretAccess: settings.security.defaultSecretAccess };
}

/** Changes made by an agent (MCP tools, actor "agent:<id>") rather than the human. */
const isAgentActor = (actor: string) => actor.startsWith("agent:");

/**
 * Permissions an agent may never grant or change: secret access, agent management and the login/2FA allow-lists
 * stay human-only. Agent-created agents always start in "fill" mode without management rights, whatever the
 * default secret access setting is.
 */
function lockHumanOnlyPermissions(p: AgentPermissions, current: AgentPermissions | null): AgentPermissions {
  return {
    ...p,
    secretAccess: current?.secretAccess ?? "fill",
    canManageAgents: current?.canManageAgents ?? false,
    credentialIds: current ? current.credentialIds : null,
    totpIds: current ? current.totpIds : null,
  };
}

/** Unique slug across agents and existing directories in agentsDir (repo dirs are never reused). */
function uniqueSlug(base: string): string {
  const root = slugify(base);
  let candidate = root;
  for (let i = 2; ; i++) {
    const taken = get<{ id: string }>("SELECT id FROM agents WHERE slug = ?", candidate) || existsSync(repoPathFor(candidate));
    if (!taken) return candidate;
    candidate = `${root}-${i}`;
  }
}

function auditPermissions(actor: string, before: AgentPermissions | null, after: AgentPermissions, agentId: string) {
  const changed =
    (before?.secretAccess ?? "fill") !== after.secretAccess || (before?.canManageAgents ?? false) !== after.canManageAgents;
  if (!changed) return;
  audit(actor, "agent.permissions", agentId, {
    secretAccess: after.secretAccess,
    canManageAgents: after.canManageAgents,
    previous: before ? { secretAccess: before.secretAccess, canManageAgents: before.canManageAgents } : null,
  });
}

/* ------------------------------------------------------------------ */
/* Repository files                                                     */
/* ------------------------------------------------------------------ */

function claudeMdContext(agent: Agent) {
  const workspace = agent.workspaceId
    ? get<{ name: string; description: string }>("SELECT name, description FROM workspaces WHERE id = ?", agent.workspaceId)
    : null;
  return { userName: getSettings().general.userName ?? "", workspace };
}

/**
 * Make sure the agent repository and its generated files exist. Existing CLAUDE.md, MEMORY.md and .gitignore are
 * kept unless `regenerate` is set (CLAUDE.md + state/agent.json are then rewritten from the agent settings).
 */
async function syncRepoFiles(agent: Agent, regenerate: boolean): Promise<void> {
  const dir = agent.repoPath;
  await repo.initRepo(dir);
  const claudeMd = renderClaudeMd(agent, claudeMdContext(agent));
  await repo.withRepoLock(dir, async () => {
    for (const sub of AGENT_REPO_DIRS) {
      await mkdir(join(dir, sub), { recursive: true });
      const keep = join(dir, sub, ".gitkeep");
      if (!existsSync(keep)) await writeFile(keep, "");
    }
    const writeIfMissing = async (file: string, content: string) => {
      if (!existsSync(join(dir, file))) await writeFile(join(dir, file), content, "utf8");
    };
    await syncGitignore(dir);
    await writeIfMissing("MEMORY.md", renderMemoryMd(agent));
    if (regenerate) await writeFile(join(dir, "CLAUDE.md"), claudeMd, "utf8");
    else await writeIfMissing("CLAUDE.md", claudeMd);
    if (regenerate || !existsSync(join(dir, "state", "agent.json"))) {
      await writeFile(join(dir, "state", "agent.json"), renderAgentState(agent), "utf8");
    }
  });
}

/** Create .gitignore, or append managed rules an older repository lacks (untracking newly ignored uploads). */
async function syncGitignore(dir: string): Promise<void> {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) {
    await writeFile(file, AGENT_GITIGNORE, "utf8");
    return;
  }
  const current = await readFile(file, "utf8");
  const missing = missingGitignoreRules(current);
  if (!missing.length) return;
  const separator = current.endsWith("\n") || current === "" ? "" : "\n";
  await writeFile(file, `${current}${separator}# Added by Godmode Bot\n${missing.join("\n")}\n`, "utf8");
  if (missing.includes("workspace/uploads/")) await repo.untrackInLock(dir, "workspace/uploads");
}

function gitignoreComplete(dir: string): boolean {
  try {
    return missingGitignoreRules(readFileSync(join(dir, ".gitignore"), "utf8")).length === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the repository of an agent exists with all generated files (never overwrites CLAUDE.md or MEMORY.md).
 * Cheap when everything is in place, so it is safe to call before every run (e.g. after a backup restore
 * without agent repositories).
 */
export async function ensureAgentRepo(agentOrId: Agent | string): Promise<void> {
  const agent = typeof agentOrId === "string" ? getAgent(agentOrId) : agentOrId;
  const essentials = [".git", "CLAUDE.md", "MEMORY.md", join("state", "agent.json")];
  if (essentials.every((p) => existsSync(join(agent.repoPath, p))) && gitignoreComplete(agent.repoPath)) return;
  const fresh = !existsSync(join(agent.repoPath, ".git"));
  await syncRepoFiles(agent, false);
  await repo.commitAll(agent.repoPath, fresh ? `Create agent ${agent.name}` : "Update generated files");
}

/** Rewrite CLAUDE.md + state/agent.json from the current settings and commit (no-op commit if unchanged). */
export async function refreshAgentFiles(agentId: string, message = "Update agent settings"): Promise<void> {
  const agent = getAgent(agentId);
  await syncRepoFiles(agent, true);
  await repo.commitAll(agent.repoPath, message);
}

/** Move an agent's repository to agents/.trash (never hard-deletes user data). */
export async function trashAgentRepo(agent: Pick<Agent, "slug" | "repoPath">): Promise<string | null> {
  return repo.moveToTrash(agent.repoPath, trashDir(), agent.slug);
}

/** Cancel queued/running runs of an agent and wait (bounded) for them to settle. */
export async function stopAgentRuns(agentId: string): Promise<void> {
  const active = all<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued', 'running')", agentId);
  for (const { id } of active) {
    try {
      await cancelRun(id);
      await waitForRun(id, 15_000);
    } catch (err) {
      log.warn(`could not stop run ${id} of agent ${agentId}`, err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Queries                                                              */
/* ------------------------------------------------------------------ */

const ORDER = "ORDER BY is_default DESC, name COLLATE NOCASE ASC";

export function getDefaultAgentId(): string | null {
  return get<{ id: string }>("SELECT id FROM agents WHERE is_default = 1 ORDER BY created_at LIMIT 1")?.id ?? null;
}

/**
 * workspaceId: "all"/undefined = every agent; null/"global" = global agents only;
 * a workspace id = that workspace's agents plus the default agent.
 */
export function listAgents(opts: { workspaceId?: string | null | "all" } = {}): Agent[] {
  const ws = opts.workspaceId;
  let rows: AgentRow[];
  if (ws === undefined || ws === "all") rows = all<AgentRow>(`SELECT * FROM agents ${ORDER}`);
  else if (ws === null || ws === "global") rows = all<AgentRow>(`SELECT * FROM agents WHERE workspace_id IS NULL ${ORDER}`);
  else rows = all<AgentRow>(`SELECT * FROM agents WHERE workspace_id = ? OR is_default = 1 ${ORDER}`, ws);
  return rows.map(toModel);
}

/** Look up an agent by id (or slug). */
export function getAgent(id: string): Agent {
  const row =
    get<AgentRow>("SELECT * FROM agents WHERE id = ?", id) ?? get<AgentRow>("SELECT * FROM agents WHERE slug = ?", id);
  if (!row) throw notFound("Agent");
  return toModel(row);
}

/** Agents visible to `agent` for delegation (same workspace + global), excluding itself, respecting delegateTo. */
export function peersFor(agent: Agent): Agent[] {
  // Agent managers (the default orchestrator) can reach every agent; others their workspace + global agents.
  const rows = agent.permissions.canManageAgents
    ? all<AgentRow>(`SELECT * FROM agents WHERE enabled = 1 AND id != ? ${ORDER}`, agent.id)
    : all<AgentRow>(
        `SELECT * FROM agents WHERE enabled = 1 AND id != ? AND (workspace_id IS NULL OR workspace_id IS ?) ${ORDER}`,
        agent.id,
        agent.workspaceId,
      );
  const allowed = agent.permissions.delegateTo;
  const peers = rows.map(toModel);
  return allowed.length ? peers.filter((p) => allowed.includes(p.id)) : peers;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                            */
/* ------------------------------------------------------------------ */

async function createAgentRecord(input: AgentInput, isDefault: boolean, actor: string, preferredSlug?: string): Promise<Agent> {
  const name = (input.name ?? "").trim();
  if (!name) throw badRequest("Agent name is required");
  const workspaceId = isDefault ? null : (input.workspaceId ?? null);
  if (workspaceId) assertWorkspace(workspaceId);
  const browser = normalizeBrowser({ ...DEFAULT_BROWSER, ...input.browser });
  assertBrowserProfile(browser.profileId);
  const settings = getSettings();
  const enabled = isDefault ? true : input.enabled !== false;
  // A fresh database next to an existing agents/godmode (e.g. after a reset) re-attaches the default agent's
  // repository so its memory and history are kept.
  const adopt =
    isDefault &&
    !!preferredSlug &&
    !get<{ id: string }>("SELECT id FROM agents WHERE slug = ?", preferredSlug) &&
    existsSync(join(repoPathFor(preferredSlug), ".git"));
  const slug = adopt ? preferredSlug! : uniqueSlug(preferredSlug ?? name);
  let permissions = normalizePermissions({ ...defaultPermissions(settings), ...input.permissions });
  if (isAgentActor(actor)) permissions = lockHumanOnlyPermissions(permissions, null);
  const ts = now();
  const id = newId("agt");
  const agent: Agent = {
    id,
    workspaceId,
    name,
    slug,
    avatar: input.avatar?.trim() || "🤖",
    color: input.color?.trim() || "violet",
    // Stored explicitly so the look never depends on how defaults are derived later.
    character: normalizeCharacter(input.character, isDefault ? MASCOT_CHARACTER : defaultCharacter(id)),
    personality: normalizePersonality(input.personality),
    description: input.description?.trim() ?? "",
    instructions: input.instructions?.trim() ?? "",
    model: input.model?.trim() ?? "",
    effort: validateEffort(input.effort),
    isDefault,
    enabled,
    status: enabled ? "idle" : "disabled",
    permissions,
    browser,
    // Human-only: unattended control of the human's computer.
    computer: isAgentActor(actor) ? { ...DEFAULT_AGENT_COMPUTER } : normalizeAgentComputer({ ...DEFAULT_AGENT_COMPUTER, ...input.computer }),
    mcpServerIds: existingMcpServerIds(stringList(input.mcpServerIds ?? [])),
    inheritMcp: input.inheritMcp !== false,
    subagents: normalizeSubagents(input.subagents ?? []),
    // Human-only: without bypass mode the working directory is where Claude may edit files.
    workingDirectory: isAgentActor(actor) ? null : normalizeWorkingDirectory(input.workingDirectory),
    // A VM only takes host access away, so managers may give one; removing it stays with the human (updateAgent).
    vmId: normalizeVmId(input.vmId) ?? null,
    // Human-only: signing in to remote machines.
    sshServerIds: isAgentActor(actor) ? [] : (normalizeSshServerIds(input.sshServerIds) ?? []),
    repoPath: repoPathFor(slug),
    lastRunAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
  insert("agents", toRow(agent));
  try {
    await syncRepoFiles(agent, true);
    await repo.commitAll(agent.repoPath, adopt ? `Re-attach agent ${agent.name}` : `Create agent ${agent.name}`);
  } catch (err) {
    run("DELETE FROM agents WHERE id = ?", agent.id);
    // A new directory did not exist before (uniqueSlug guarantees it), so removing it cannot lose user data.
    if (!adopt) await rm(agent.repoPath, { recursive: true, force: true }).catch(() => undefined);
    log.error(`failed to initialize repository for agent ${agent.slug}`, err);
    throw err;
  }
  if (!isDefault) auditPermissions(actor, null, agent.permissions, agent.id);
  log.info(`created agent ${agent.slug}${agent.isDefault ? " (default)" : ""}`);
  bus.emit({ type: "agent.updated", agent });
  if (agent.vmId) assignmentsChanged();
  if (agent.sshServerIds.length) bus.changed("ssh-servers");
  return agent;
}

export async function createAgent(input: AgentInput, actor = "user"): Promise<Agent> {
  return createAgentRecord(input, false, actor);
}

export async function updateAgent(id: string, patch: Partial<AgentInput>, actor = "user"): Promise<Agent> {
  const current = getAgent(id);
  const next: Agent = { ...current };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest("Agent name is required");
    next.name = name;
  }
  if (patch.workspaceId !== undefined) {
    const ws = patch.workspaceId ?? null;
    if (current.isDefault && ws !== null) throw badRequest("The default agent is global and cannot be moved into a workspace");
    if (ws) assertWorkspace(ws);
    next.workspaceId = ws;
  }
  if (patch.avatar !== undefined) next.avatar = patch.avatar.trim() || "🤖";
  if (patch.color !== undefined) next.color = patch.color.trim() || "violet";
  if (patch.character !== undefined) next.character = normalizeCharacter(patch.character, current.character);
  if (patch.personality !== undefined) next.personality = normalizePersonality(patch.personality);
  if (patch.description !== undefined) next.description = patch.description.trim();
  if (patch.instructions !== undefined) next.instructions = patch.instructions.trim();
  if (patch.model !== undefined) next.model = patch.model.trim();
  if (patch.effort !== undefined) next.effort = validateEffort(patch.effort);
  if (patch.enabled !== undefined) {
    if (current.isDefault && !patch.enabled) throw badRequest("The default agent cannot be disabled");
    next.enabled = patch.enabled;
  }
  if (patch.permissions !== undefined) {
    next.permissions = normalizePermissions({ ...current.permissions, ...patch.permissions });
    if (isAgentActor(actor)) next.permissions = lockHumanOnlyPermissions(next.permissions, current.permissions);
  }
  if (patch.browser !== undefined) {
    next.browser = normalizeBrowser({ ...current.browser, ...patch.browser });
    if (next.browser.profileId !== current.browser.profileId) assertBrowserProfile(next.browser.profileId);
  }
  if (patch.computer !== undefined && !isAgentActor(actor)) {
    next.computer = normalizeAgentComputer({ ...current.computer, ...patch.computer });
    // Turning unattended access off (or pointing it elsewhere) applies to running runs too.
    if (JSON.stringify(next.computer) !== JSON.stringify(current.computer)) void detachAgentComputer(current.id);
  }
  if (patch.mcpServerIds !== undefined) next.mcpServerIds = existingMcpServerIds(stringList(patch.mcpServerIds));
  if (patch.inheritMcp !== undefined) next.inheritMcp = patch.inheritMcp;
  if (patch.subagents !== undefined) next.subagents = normalizeSubagents(patch.subagents);
  if (patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory && !isAgentActor(actor)) {
    next.workingDirectory = normalizeWorkingDirectory(patch.workingDirectory);
  }
  // Moving an agent into a VM only narrows what it reaches on this computer; taking it out is human-only.
  if (patch.vmId !== undefined && (patch.vmId || !isAgentActor(actor))) next.vmId = normalizeVmId(patch.vmId) ?? null;
  if (patch.sshServerIds !== undefined && !isAgentActor(actor)) next.sshServerIds = normalizeSshServerIds(patch.sshServerIds) ?? [];

  next.status = !next.enabled ? "disabled" : current.status === "disabled" ? "idle" : current.status;
  next.updatedAt = now();

  const { id: _id, created_at: _created, slug: _slug, last_run_at: _lastRun, ...row } = toRow(next);
  update("agents", current.id, row);
  auditPermissions(actor, current.permissions, next.permissions, current.id);

  try {
    await refreshAgentFiles(current.id);
  } catch (err) {
    // The database is the source of truth; the files are regenerated on the next update or ensureAgentRepo().
    log.error(`failed to update repository files of agent ${current.slug}`, err);
  }

  const agent = getAgent(current.id);
  bus.emit({ type: "agent.updated", agent });
  if (current.vmId !== agent.vmId) assignmentsChanged();
  if (JSON.stringify(current.sshServerIds) !== JSON.stringify(agent.sshServerIds)) bus.changed("ssh-servers");
  if (current.enabled !== agent.enabled || current.workspaceId !== agent.workspaceId) {
    reloadSchedules();
    requestAppTriggerSync();
  }
  return agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const agent = getAgent(id);
  if (agent.isDefault) throw badRequest("The default Godmode agent cannot be deleted");
  await stopAgentRuns(agent.id);
  const routines = get<{ c: number }>("SELECT COUNT(*) AS c FROM routines WHERE agent_id = ?", agent.id)?.c ?? 0;
  tx(() => {
    run("DELETE FROM agents WHERE id = ?", agent.id);
    removeFromDelegateLists([agent.id]);
  });
  try {
    const moved = await trashAgentRepo(agent);
    if (moved) log.info(`moved repository of deleted agent ${agent.slug} to ${moved}`);
  } catch (err) {
    log.error(`failed to move repository of deleted agent ${agent.slug} to trash`, err);
  }
  bus.emit({ type: "agent.deleted", id: agent.id });
  if (routines) bus.changed("routines");
  bus.changed("runs");
  reloadSchedules();
  requestAppTriggerSync();
}

/** Remove deleted agent ids from every other agent's permissions.delegateTo (call inside a transaction). */
export function removeFromDelegateLists(agentIds: string[]): void {
  if (!agentIds.length) return;
  const gone = new Set(agentIds);
  for (const row of all<Pick<AgentRow, "id" | "permissions">>("SELECT id, permissions FROM agents")) {
    const perms = parseJson<Partial<AgentPermissions>>(row.permissions, {});
    if (!Array.isArray(perms.delegateTo) || !perms.delegateTo.some((x) => gone.has(x))) continue;
    perms.delegateTo = perms.delegateTo.filter((x) => !gone.has(x));
    run("UPDATE agents SET permissions = ? WHERE id = ?", JSON.stringify(perms), row.id);
  }
}

/* ------------------------------------------------------------------ */
/* Default agent                                                        */
/* ------------------------------------------------------------------ */

let ensuring: Promise<Agent> | null = null;
let settingsHookRegistered = false;
let lastUserName: string | null = null;

/** Meta key: the built-in agent's files were rewritten after it became the mascot (migration 20). */
const MASCOT_FILES_KEY = "agents.mascot_files";

/** Regenerate every agent's CLAUDE.md when the user's display name changes (it is part of each CLAUDE.md). */
function registerSettingsHook() {
  if (settingsHookRegistered) return;
  settingsHookRegistered = true;
  lastUserName = getSettings().general.userName ?? "";
  onSettingsApplied((s) => {
    const name = s.general.userName ?? "";
    if (name === lastUserName) return;
    lastUserName = name;
    void (async () => {
      for (const agent of listAgents()) {
        // Missing repositories are created lazily (ensureAgentRepo) with the current name anyway.
        if (!existsSync(join(agent.repoPath, ".git"))) continue;
        await refreshAgentFiles(agent.id, "Update user name").catch((err) =>
          log.warn(`failed to refresh CLAUDE.md of agent ${agent.slug}`, err),
        );
      }
    })();
  });
}

/** Create the built-in "Godmode" agent, or repair it (global, enabled, unique default, repository present). */
export function ensureDefaultAgent(): Promise<Agent> {
  if (!ensuring) {
    ensuring = ensureDefaultAgentOnce().finally(() => {
      ensuring = null;
    });
  }
  return ensuring;
}

async function ensureDefaultAgentOnce(): Promise<Agent> {
  registerSettingsHook();
  const agent = await ensureDefaultRecord();
  // Startup repair for every other agent too, e.g. after a backup was restored without agent repositories.
  for (const other of listAgents()) {
    if (other.id === agent.id) continue;
    await ensureAgentRepo(other).catch((err) => log.error(`failed to repair the repository of agent ${other.slug}`, err));
  }
  return agent;
}

async function ensureDefaultRecord(): Promise<Agent> {
  const row = get<AgentRow>("SELECT * FROM agents WHERE is_default = 1 ORDER BY created_at LIMIT 1");
  if (!row) {
    const created = await createAgentRecord(DEFAULT_AGENT_INPUT, true, "system", DEFAULT_AGENT_SLUG);
    setMeta(MASCOT_FILES_KEY, "1");
    return created;
  }

  const current = toModel(row);
  run("UPDATE agents SET is_default = 0 WHERE is_default = 1 AND id != ?", current.id);
  if (current.workspaceId !== null || !current.enabled || row.repo_path !== current.repoPath) {
    run(
      "UPDATE agents SET workspace_id = NULL, enabled = 1, status = CASE WHEN status = 'disabled' THEN 'idle' ELSE status END, repo_path = ? WHERE id = ?",
      current.repoPath,
      current.id,
    );
  }
  const agent = getAgent(current.id);
  try {
    await ensureAgentRepo(agent);
    // Migration 20 gave the built-in agent its look and personality: write them into its CLAUDE.md once.
    if (getMeta(MASCOT_FILES_KEY) !== "1") {
      await refreshAgentFiles(agent.id, "Add personality");
      setMeta(MASCOT_FILES_KEY, "1");
    }
  } catch (err) {
    log.error("failed to repair the default agent repository", err);
  }
  return agent;
}

/* ------------------------------------------------------------------ */
/* Runtime state                                                        */
/* ------------------------------------------------------------------ */

/** Update runtime status (idle/running/error). Emits agent.updated. Unknown agents are ignored. */
export function setAgentStatus(id: string, status: AgentStatus): void {
  const row = get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  if (!row) return;
  const effective: AgentStatus = !bool(row.enabled) && status === "idle" ? "disabled" : status;
  if (row.status === effective) return;
  run("UPDATE agents SET status = ? WHERE id = ?", effective, id);
  bus.emit({ type: "agent.updated", agent: toModel({ ...row, status: effective }) });
}

/** Set lastRunAt = now. */
export function touchAgentRun(id: string): void {
  const row = get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  if (!row) return;
  const ts = now();
  run("UPDATE agents SET last_run_at = ? WHERE id = ?", ts, id);
  bus.emit({ type: "agent.updated", agent: toModel({ ...row, last_run_at: ts }) });
}

/**
 * Commit all changes in the agent repo (serialized per repo). No-op if nothing changed or when
 * settings.memory.autoCommit is off. Failures are logged, never thrown (committing is best effort).
 */
export async function commitAgentRepo(agentId: string, message: string): Promise<void> {
  const row = get<AgentRow>("SELECT * FROM agents WHERE id = ?", agentId);
  if (!row || !getSettings().memory.autoCommit) return;
  const agent = toModel(row);
  try {
    if (!existsSync(join(agent.repoPath, ".git"))) await ensureAgentRepo(agent);
    await repo.commitAll(agent.repoPath, message);
  } catch (err) {
    log.warn(`commit failed for agent ${agent.slug}`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Repository browsing (file explorer in the UI)                        */
/* ------------------------------------------------------------------ */

/** The agent, with its repository created first if it is missing (e.g. restored from a backup without repos). */
async function withRepo(id: string): Promise<Agent> {
  const agent = getAgent(id);
  if (!existsSync(join(agent.repoPath, ".git"))) await ensureAgentRepo(agent);
  return agent;
}

export async function listAgentFiles(id: string, path = ""): Promise<AgentFileEntry[]> {
  return repo.listFiles((await withRepo(id)).repoPath, path);
}

export async function readAgentFile(id: string, path: string): Promise<{ path: string; content: string }> {
  return repo.readRepoFile((await withRepo(id)).repoPath, path);
}

/** Write a file as the user and commit it ("Edit <path>"). CLAUDE.md edits last until the next settings update. */
export async function writeAgentFile(id: string, path: string, content: string): Promise<void> {
  const agent = await withRepo(id);
  const rel = await repo.writeRepoFile(agent.repoPath, path, content);
  await repo.commitAll(agent.repoPath, `Edit ${rel}`);
}

export async function listAgentCommits(id: string, limit = 50): Promise<GitCommit[]> {
  return repo.log((await withRepo(id)).repoPath, limit);
}
