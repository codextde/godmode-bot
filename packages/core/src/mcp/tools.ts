/**
 * Tools of the Godmode MCP gateway. Every call runs as the agent that owns the run token (RunContext):
 * vault fills (the model never sees secrets), missing-login reports, notifications, peer agents and
 * delegation, and — for the orchestrator (`canManageAgents`) — agent/routine/run management.
 */
import { z } from "zod";
import type { Agent, Credential, MissingLoginKind, Run } from "@godmode/shared";
import type { RunContext } from "../types";
import { HttpError, domainMatches, hostnameOf, sleep } from "../util";
import { logger } from "../log";
import { redact } from "../vault/vault";
import { audit } from "../services/audit";
import { notify } from "../services/notifications";
import { listMissingLogins, reportMissingLogin } from "../services/missingLogins";
import { createRoutine, deleteRoutine, getRoutine, listRoutines, updateRoutine } from "../services/routines";
import { listWorkspaces } from "../services/workspaces";
import { createAgent, deleteAgent, getAgent, listAgents, peersFor, updateAgent } from "../agents/service";
import { addCredentialDomain, credentialsForAgent, findCredentialsForAgent, getCredential, listCredentials, markCredentialUsed, revealForAgent } from "../vault/credentials";
import { codeForAgent, listTotp, totpForAgent } from "../vault/totp";
import { nameGuessMatchesHost } from "../vault/match";
import { currentPage, fillIntoPage, resolveProfileForAgent } from "../browser/manager";
import { getMcpServer, mcpServerInAgentScope } from "../integrations/mcpServers";
import { loginFillScope } from "../browser/fill";
import { createConversation, sendMessage } from "../services/conversations";
import { getRun, listRuns, markMissingLoginReported, waitForRun } from "../runner/runner";

const log = logger("mcp");

export const MAX_DELEGATION_DEPTH = 3;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface ToolEnv {
  ctx: RunContext;
  agent: Agent;
}

type ToolOutput = string | { text: string; isError?: boolean };

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Tool is listed/allowed for this agent. Default: always. */
  when?: (agent: Agent) => boolean;
  run: (args: never, env: ToolEnv) => Promise<ToolOutput> | ToolOutput;
}

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  when?: (agent: Agent) => boolean;
  run: (args: z.infer<S>, env: ToolEnv) => Promise<ToolOutput> | ToolOutput;
}): ToolDef {
  return def as unknown as ToolDef;
}

/** Error thrown for a tool name the gateway doesn't know at all (JSON-RPC -32602). */
export class UnknownToolError extends Error {}

const isManager = (a: Agent) => a.permissions.canManageAgents;
const canDelegate = (a: Agent) => a.permissions.allowDelegation || a.permissions.canManageAgents;
const canReveal = (a: Agent) => a.permissions.secretAccess === "reveal";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const fail = (text: string): ToolOutput => ({ text, isError: true });

function snippet(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function workspaceNames(): Map<string, string> {
  try {
    return new Map(listWorkspaces().map((w) => [w.id, w.name]));
  } catch {
    return new Map();
  }
}

function scopeName(workspaceId: string | null, names: Map<string, string>): string {
  return workspaceId ? (names.get(workspaceId) ?? workspaceId) : "global";
}

function agentSummary(a: Agent, names: Map<string, string>) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    workspace: scopeName(a.workspaceId, names),
    status: a.status,
    enabled: a.enabled,
    lastRunAt: a.lastRunAt,
    ...(a.workingDirectory ? { workingDirectory: a.workingDirectory } : {}),
    ...(a.isDefault ? { isDefault: true } : {}),
  };
}

/** Agents the caller may see/delegate to. */
function reachableAgents(agent: Agent): Agent[] {
  if (isManager(agent)) return listAgents({ workspaceId: "all" }).filter((a) => a.id !== agent.id);
  return peersFor(agent);
}

function requireReachable(agent: Agent, targetId: string): Agent {
  const target = reachableAgents(agent).find((a) => a.id === targetId);
  if (!target) throw new HttpError(403, `Agent ${targetId} is not one of your peers (use agents_list to see who you can work with).`);
  return target;
}

const ASK_HUMAN = "ask the human to change this in Settings";

/**
 * A reveal-mode agent gets plaintext secrets, so it only takes work (tasks, schedules, instructions) from a
 * caller that could reveal them itself — and never from another workspace. Returns the refusal, or null.
 */
function revealTargetRefusal(caller: Agent, target: Agent, what: string): string | null {
  if (target.permissions.secretAccess !== "reveal") return null;
  if (caller.permissions.secretAccess !== "reveal") return `Target agent can reveal secrets; only the human can ${what} from here.`;
  if (target.workspaceId !== null && target.workspaceId !== caller.workspaceId) {
    return `${target.name} can reveal secrets and belongs to another workspace; only the human can ${what}.`;
  }
  return null;
}

/**
 * Settings of agents that only the human may change through the UI: workspace, browser profile, and MCP servers
 * outside the agent's scope (global / its workspace / pinned to it). `target` is null for a new agent.
 */
function assertAgentPatchAllowed(
  target: Agent | null,
  patch: { workspaceId?: string | null; browser?: { profileId?: string | null }; mcpServerIds?: string[] },
): void {
  if (target && patch.workspaceId !== undefined && (patch.workspaceId ?? null) !== target.workspaceId) {
    throw new HttpError(403, `Agents cannot move agents between workspaces; ${ASK_HUMAN}.`);
  }
  const profileId = patch.browser?.profileId;
  if (profileId !== undefined && (profileId ?? null) !== (target?.browser.profileId ?? null)) {
    throw new HttpError(403, `Agents cannot change an agent's browser profile; ${ASK_HUMAN}.`);
  }
  if (patch.mcpServerIds?.length) {
    const scope = { id: target?.id ?? "", workspaceId: target ? target.workspaceId : (patch.workspaceId ?? null) };
    const outside = patch.mcpServerIds.filter((id) => {
      try {
        return !mcpServerInAgentScope(getMcpServer(id), scope);
      } catch {
        return false; // unknown ids are dropped by the agent service
      }
    });
    if (outside.length) {
      throw new HttpError(403, `MCP server ${outside.join(", ")} is outside this agent's scope (global, its workspace or pinned to it); ${ASK_HUMAN}.`);
    }
  }
}

/** Browser error text with the filled value removed (redact() only knows passwords, not usernames/codes). */
function scrub(detail: string, value: string): string {
  const masked = value ? detail.split(value).join("••••••••") : detail;
  return redact(masked);
}

function requireBrowser(agent: Agent) {
  if (!agent.browser.enabled) throw new HttpError(409, "The browser is disabled for this agent, so nothing can be filled into a page.");
  return resolveProfileForAgent(agent);
}

/**
 * Fill binding for a login, extended to the page the agent is on when that site is not one of the login's own
 * but its brand name matches it exactly (e.g. a login named "Bitpanda" on bitpanda.com it never listed). This is
 * the only way a name guess widens where a secret may be typed; `guessHost` (the host that was added) is returned
 * so the caller can remember it on the login after a successful fill. The scope stays https-only.
 */
async function fillScopeFor(profileId: string, login: Credential): Promise<{ scope: { allowedHosts: string[]; httpHosts: string[] }; guessHost: string | null }> {
  const scope = loginFillScope(login);
  const host = hostnameOf((await currentPage(profileId))?.url ?? "");
  if (!host || scope.allowedHosts.some((d) => domainMatches(host, d)) || !nameGuessMatchesHost(login, host, { strict: true })) {
    return { scope, guessHost: null };
  }
  return { scope: { allowedHosts: [...scope.allowedHosts, host], httpHosts: scope.httpHosts }, guessHost: host };
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const missingKind = z.enum(["missing_credential", "invalid_credential", "missing_totp", "missing_account", "other"]);

/** Agent fields an orchestrator may set. Secret access and management rights stay human-only. */
const agentFields = {
  workspaceId: z.string().nullable().optional().describe("Workspace id, or null for a global agent (agent_create only; moving agents is human-only)"),
  avatar: z.string().max(16).optional().describe("Emoji avatar"),
  color: z.string().max(32).optional(),
  description: z.string().max(2000).optional().describe("One-line description of what the agent does"),
  instructions: z.string().max(20000).optional().describe("Standing instructions / role (goes into the agent's CLAUDE.md)"),
  model: z.string().max(100).optional().describe("Claude model id; empty = global default"),
  effort: effortSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  permissions: z
    .object({
      allowDelegation: z.boolean().optional(),
      delegateTo: z.array(z.string()).optional().describe("Agent ids it may delegate to; empty = any peer"),
      maxBudgetUsd: z.number().positive().nullable().optional().describe("Cost cap per run in USD"),
    })
    .optional(),
  browser: z
    .object({
      enabled: z.boolean().optional(),
      headless: z.boolean().nullable().optional(),
      profileId: z.string().nullable().optional().describe("Browser profile — human-only; leave unset"),
    })
    .optional(),
  mcpServerIds: z.array(z.string()).optional().describe("Extra MCP server ids; only global servers or ones of the agent's workspace"),
  inheritMcp: z.boolean().optional(),
  subagents: z
    .array(z.object({ name: z.string(), description: z.string(), prompt: z.string(), model: z.string().optional() }))
    .optional(),
};

const routineFields = {
  name: z.string().min(1).max(200),
  cron: z.string().min(1).describe('Cron expression (5 or 6 fields), e.g. "0 9 * * 1-5" = weekdays at 09:00'),
  prompt: z.string().min(1).describe("What the agent should do on every run"),
  timezone: z.string().optional().describe("IANA timezone, default: the human's local timezone"),
  enabled: z.boolean().optional(),
  reuseConversation: z.boolean().optional().describe("Keep one conversation for all runs (continuity). Default true."),
};

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const TOOLS: ToolDef[] = [
  defineTool({
    name: "vault_list_logins",
    description:
      'List the website logins saved in the Godmode vault that you may use (never includes passwords). Pass the site\'s domain or URL to filter: results match by domain first, then fall back to a best-effort guess by the login\'s name (marked "match": "name") — sanity-check a name guess before relying on it. Use the returned id with vault_fill_login / vault_fill_totp.',
    schema: z.object({ domain: z.string().optional().describe('Domain or URL of the site, e.g. "github.com"') }),
    run: ({ domain }, { agent }) => {
      const query = domain?.trim() ? hostnameOf(domain) : "";
      const creds = query ? findCredentialsForAgent(agent, domain!) : credentialsForAgent(agent);
      if (!creds.length) {
        return domain
          ? `No saved login for ${query || domain}. If the task needs one, call report_missing_login and continue with other work.`
          : "No saved logins are available to you.";
      }
      const matchedByDomain = (c: Credential) =>
        [...c.domains, ...(c.url ? [hostnameOf(c.url)] : [])].some((d) => d && domainMatches(query, d));
      return json(
        creds.map((c) => ({
          id: c.id,
          name: c.name,
          url: c.url,
          domains: c.domains,
          username: c.username,
          hasPassword: c.hasPassword,
          has2fa: c.totpId !== null,
          ...(query ? { match: matchedByDomain(c) ? "domain" : "name" } : {}),
        })),
      );
    },
  }),

  defineTool({
    name: "vault_fill_login",
    description:
      "Type the username or password of a saved login into the browser page — Godmode fills it directly, you never see the value. Only works on the login's own site (its domains/URL, https unless the saved URL is http) — the field's page or frame must belong to it, otherwise the fill is refused; the one exception is a login whose name matches the current site exactly (e.g. a login named \"Bitpanda\" on bitpanda.com), which is filled and remembers that site. Passwords only go into real password inputs (input[type=password]). The right input is found automatically (focused field, or the best username/password field on the page, incl. iframes); pass a CSS selector only if that picks the wrong field. Use submit:true on the last field to press Enter.",
    schema: z.object({
      credentialId: z.string().describe("Login id from vault_list_logins"),
      field: z.enum(["username", "password"]),
      selector: z.string().optional().describe("CSS selector of the input; default: the focused input or the best match"),
      submit: z.boolean().optional().describe("Press Enter after filling"),
    }),
    run: async ({ credentialId, field, selector, submit }, { agent, ctx }) => {
      const profile = requireBrowser(agent);
      const secret = revealForAgent(agent, credentialId);
      const value = field === "username" ? secret.username : secret.password;
      if (!value) {
        return fail(
          `This login has no ${field} saved. Call report_missing_login (kind "invalid_credential") so the human can complete it.`,
        );
      }
      const login = getCredential(credentialId);
      const { scope, guessHost } = await fillScopeFor(profile.id, login);
      const result = await fillIntoPage(profile.id, { text: value, kind: field, selector, submit, ...scope });
      audit(`agent:${agent.id}`, "credential.fill", credentialId, { field, runId: ctx.runId, ok: result.ok, ...(guessHost ? { guessedSite: guessHost } : {}) });
      if (!result.ok) return fail(`Could not fill the ${field}: ${scrub(result.detail, value)}`);
      markCredentialUsed(credentialId);
      const remembered = guessHost && addCredentialDomain(credentialId, guessHost);
      if (remembered) audit(`agent:${agent.id}`, "credential.autofix_domain", credentialId, { domain: guessHost, runId: ctx.runId });
      return `Filled ${field} for "${login.name}" into ${result.url}${submit ? " and submitted" : ""}.${remembered ? ` Added ${guessHost} to this login (its name matched the site).` : ""}`;
    },
  }),

  defineTool({
    name: "vault_fill_totp",
    description:
      "Type the current 2FA (TOTP / authenticator) code into the browser page — Godmode fills it, you never see it. Pass the login's credentialId (its linked 2FA is used) or a totpId. Only works on the site of the login the 2FA entry is linked to (an unlinked entry also needs the credentialId of the site's login). The code input is found automatically (incl. one-digit-per-box inputs); pass a selector only if needed.",
    schema: z.object({
      credentialId: z.string().optional().describe("Login id whose linked 2FA should be used"),
      totpId: z.string().optional().describe("2FA entry id (alternative to credentialId)"),
      selector: z.string().optional(),
      submit: z.boolean().optional().describe("Press Enter after filling"),
    }),
    run: async ({ credentialId, totpId, selector, submit }, { agent, ctx }) => {
      const profile = requireBrowser(agent);
      let id = totpId ?? null;
      let site: Credential | null = null;
      if (credentialId) {
        const cred = credentialsForAgent(agent).find((c) => c.id === credentialId);
        if (!cred) return fail(`Login ${credentialId} is not available to you.`);
        site = cred;
        id ??= cred.totpId ?? totpForAgent(agent).find((t) => t.credentialId === credentialId)?.id ?? null;
        if (!id) {
          return fail(
            `No 2FA code is linked to "${cred.name}". Call report_missing_login with kind "missing_totp" so the human can add it, then continue with other work.`,
          );
        }
      }
      if (!id) return fail("Pass credentialId or totpId.");
      const entry = totpForAgent(agent).find((t) => t.id === id);
      if (!entry) return fail(`2FA entry ${id} is not available to you.`);
      // The code may only be typed on the site of the login the entry is linked to — the issuer name proves nothing.
      if (entry.credentialId) site = getCredential(entry.credentialId);
      if (!site) {
        return fail(
          `The 2FA entry "${entry.issuer}" is not linked to a login, so Godmode cannot tell which site it belongs to. Pass the credentialId of this site's login, or ask the human to link the 2FA entry to its login in the vault.`,
        );
      }
      let code = codeForAgent(agent, id);
      if (code.remaining < 3) {
        // Too close to rollover — wait for the next period so the site doesn't reject a stale code.
        await sleep(code.remaining * 1000 + 300);
        code = codeForAgent(agent, id);
      }
      const { scope, guessHost } = await fillScopeFor(profile.id, site);
      const result = await fillIntoPage(profile.id, { text: code.code, kind: "totp", selector, submit, ...scope });
      audit(`agent:${agent.id}`, "totp.fill", id, { field: "totp", runId: ctx.runId, credentialId: credentialId ?? null, ok: result.ok, ...(guessHost ? { guessedSite: guessHost } : {}) });
      if (!result.ok) return fail(`Could not fill the 2FA code: ${scrub(result.detail, code.code)}`);
      const remembered = guessHost && addCredentialDomain(site.id, guessHost);
      if (remembered) audit(`agent:${agent.id}`, "credential.autofix_domain", site.id, { domain: guessHost, runId: ctx.runId });
      return `Filled the current 2FA code into ${result.url}${submit ? " and submitted" : ""}.${remembered ? ` Added ${guessHost} to "${site.name}" (its name matched the site).` : ""}`;
    },
  }),

  defineTool({
    name: "vault_get_login",
    description:
      "Reveal the username and password of a saved login. Only for secrets that must go to an API/CLI and cannot be filled in the browser — every call is audited. Never write the values into files, memory or your answer.",
    schema: z.object({ credentialId: z.string() }),
    when: canReveal,
    run: ({ credentialId }, { agent, ctx }) => {
      const secret = revealForAgent(agent, credentialId);
      audit(`agent:${agent.id}`, "credential.reveal", credentialId, { field: "username+password", runId: ctx.runId });
      markCredentialUsed(credentialId);
      return json({ username: secret.username, password: secret.password, url: secret.url });
    },
  }),

  defineTool({
    name: "vault_get_totp",
    description: "Reveal the current 2FA code of an entry (or of a login's linked 2FA). Audited. Prefer vault_fill_totp for websites.",
    schema: z.object({ totpId: z.string().optional(), credentialId: z.string().optional() }),
    when: canReveal,
    run: ({ totpId, credentialId }, { agent, ctx }) => {
      let id = totpId ?? null;
      if (!id && credentialId) {
        const cred = credentialsForAgent(agent).find((c) => c.id === credentialId);
        id = cred?.totpId ?? totpForAgent(agent).find((t) => t.credentialId === credentialId)?.id ?? null;
      }
      if (!id) return fail("No 2FA entry found. Pass a totpId or a credentialId with linked 2FA.");
      const code = codeForAgent(agent, id);
      audit(`agent:${agent.id}`, "totp.reveal", id, { field: "totp", runId: ctx.runId });
      return json({ code: code.code, secondsRemaining: code.remaining });
    },
  }),

  defineTool({
    name: "report_missing_login",
    description:
      "Tell the human that a login is missing or broken so they can fix it in the vault: no saved login for a site (missing_credential), the saved password is rejected (invalid_credential), a 2FA code is needed but none is linked (missing_totp), the account doesn't exist (missing_account), or other. Then continue with other work and mention it in your final summary.",
    schema: z.object({
      service: z.string().min(1).describe('Service name, e.g. "GitHub"'),
      url: z.string().optional().describe("Login page URL"),
      kind: missingKind.optional(),
      reason: z.string().min(1).describe("What happened, in one or two sentences"),
    }),
    run: ({ service, url, kind, reason }, { agent, ctx }) => {
      const item = reportMissingLogin({
        agentId: agent.id,
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        kind: (kind ?? "missing_credential") as MissingLoginKind,
        service,
        url: url ?? "",
        reason: redact(reason),
      });
      markMissingLoginReported(ctx.runId);
      return `Reported to the human (${item.kind} for ${item.service}). Continue with any other work you can do and mention this in your final summary.`;
    },
  }),

  defineTool({
    name: "notify_user",
    description: "Send the human a notification (desktop + Godmode inbox). Use for important results or blockers, not routine progress.",
    schema: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(4000).optional(),
      level: z.enum(["info", "success", "warning", "error"]).optional(),
    }),
    run: ({ title, body, level }, { agent, ctx }) => {
      notify(level ?? "info", `${agent.name}: ${redact(title)}`, redact(body ?? ""), `/chat/${ctx.conversationId}`);
      return "Notification sent.";
    },
  }),

  defineTool({
    name: "agents_list",
    description: "List the other Godmode agents you can work with (id, name, description, workspace, status).",
    schema: z.object({}),
    when: canDelegate,
    run: (_args, { agent }) => {
      const names = workspaceNames();
      const agents = reachableAgents(agent);
      return agents.length ? json(agents.map((a) => agentSummary(a, names))) : "There are no other agents you can work with.";
    },
  }),

  defineTool({
    name: "agent_get",
    description: "Details of one agent: description, instructions, model, permissions summary and its scheduled routines.",
    schema: z.object({ agentId: z.string() }),
    when: canDelegate,
    run: ({ agentId }, { agent }) => {
      const target = agentId === agent.id ? agent : requireReachable(agent, agentId);
      const names = workspaceNames();
      let routines: unknown[] = [];
      try {
        routines = listRoutines({ agentId: target.id }).map((r) => ({
          id: r.id,
          name: r.name,
          cron: r.cron,
          timezone: r.timezone,
          enabled: r.enabled,
          lastRunAt: r.lastRunAt,
          nextRunAt: r.nextRunAt,
          lastStatus: r.lastStatus,
          prompt: snippet(r.prompt, 300),
        }));
      } catch (err) {
        log.warn("could not list routines", err);
      }
      return json({
        ...agentSummary(target, names),
        instructions: snippet(target.instructions, 4000),
        model: target.model || "(default)",
        effort: target.effort,
        permissions: {
          allowDelegation: target.permissions.allowDelegation,
          canManageAgents: target.permissions.canManageAgents,
          secretAccess: target.permissions.secretAccess,
          maxBudgetUsd: target.permissions.maxBudgetUsd,
        },
        browserEnabled: target.browser.enabled,
        subagents: target.subagents.map((s) => s.name),
        routines,
      });
    },
  }),

  defineTool({
    name: "agent_delegate",
    description:
      "Hand a task to another agent. The task must be self-contained (goal, inputs, expected output). wait:true (default) waits for the result and returns it; wait:false returns immediately with a run id you can check with delegation_status.",
    schema: z.object({
      agentId: z.string(),
      task: z.string().min(1),
      wait: z.boolean().optional().describe("Wait for the result (default true)"),
      timeoutSeconds: z.number().int().min(10).max(3600).optional().describe("How long to wait (default 900)"),
    }),
    when: canDelegate,
    run: async ({ agentId, task, wait, timeoutSeconds }, { agent, ctx }) => {
      if (agentId === agent.id) return fail("You cannot delegate to yourself.");
      if (ctx.depth + 1 > MAX_DELEGATION_DEPTH) {
        return fail(`Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — do this part yourself.`);
      }
      const target = requireReachable(agent, agentId);
      if (!target.enabled) return fail(`${target.name} is disabled.`);
      // Orchestrators too: only peers (respects delegateTo), and reveal-mode agents only for reveal-mode callers.
      if (!peersFor(agent).some((p) => p.id === target.id)) {
        return fail(`Agent ${agentId} is not one of your peers (use agents_list to see who you can work with).`);
      }
      const refusal = revealTargetRefusal(agent, target, "hand it tasks");
      if (refusal) return fail(refusal);
      const conversation = createConversation({ agentId: target.id, title: `Task from ${agent.name}`, origin: "delegation" });
      const { run } = await sendMessage(conversation.id, {
        content: `[Delegated by ${agent.name}]\n\n${task}`,
        trigger: "delegation",
        parentRunId: ctx.runId,
        depth: ctx.depth + 1,
      });
      if (wait === false) {
        return `Delegated to ${target.name} (run ${run.id}, conversation ${conversation.id}). Check it later with delegation_status({ runId: "${run.id}" }).`;
      }
      const finished = await waitForRun(run.id, (timeoutSeconds ?? 900) * 1000);
      return delegationReport(target.name, finished);
    },
  }),

  defineTool({
    name: "delegation_status",
    description: "Status and result of a task you delegated with agent_delegate (optionally wait for it to finish).",
    schema: z.object({
      runId: z.string(),
      wait: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    }),
    when: canDelegate,
    run: async ({ runId, wait, timeoutSeconds }, { agent, ctx }) => {
      let r = getRun(runId);
      if (!isManager(agent) && !delegatedBy(r, agent, ctx)) return fail("That run was not delegated by you.");
      if (wait && !TERMINAL.has(r.status)) r = await waitForRun(runId, (timeoutSeconds ?? 300) * 1000);
      let name = r.agentId;
      try {
        name = getAgent(r.agentId).name;
      } catch {
        /* agent deleted */
      }
      return delegationReport(name, r);
    },
  }),

  /* ---------------- management (orchestrator only) ---------------- */

  defineTool({
    name: "agent_create",
    description:
      "Create a new agent (bot) with its own git repo, instructions and optional recurring routine. Give it a clear description and concrete instructions.",
    schema: z.object({
      name: z.string().min(1).max(100),
      ...agentFields,
      routine: z.object({ name: z.string().min(1), cron: routineFields.cron, prompt: z.string().min(1), timezone: z.string().optional() }).optional(),
    }),
    when: isManager,
    run: async ({ routine, ...input }, { agent }) => {
      assertAgentPatchAllowed(null, input);
      // Secret access, management rights and login allow-lists stay human-only (enforced by createAgent for agent actors).
      const created = await createAgent(input, `agent:${agent.id}`);
      audit(`agent:${agent.id}`, "agent.create", created.id, { name: created.name });
      let routineInfo: unknown = null;
      if (routine) {
        const r = createRoutine({ agentId: created.id, name: routine.name, cron: routine.cron, prompt: routine.prompt, timezone: routine.timezone ?? localTimezone() });
        routineInfo = { id: r.id, name: r.name, cron: r.cron, nextRunAt: r.nextRunAt };
      }
      return json({ created: agentSummary(created, workspaceNames()), routine: routineInfo });
    },
  }),

  defineTool({
    name: "agent_update",
    description:
      "Update an agent's name, description, instructions, model, delegation settings, browser on/off, MCP servers (within its scope) or subagents. Workspace, browser profile, secret access and login permissions can only be changed by the human in Settings.",
    schema: z.object({ agentId: z.string(), name: z.string().min(1).max(100).optional(), ...agentFields }),
    when: isManager,
    run: async ({ agentId, ...patch }, { agent }) => {
      const target = getAgent(agentId);
      const refusal = target.id === agent.id ? null : revealTargetRefusal(agent, target, "change its settings");
      if (refusal) return fail(refusal);
      assertAgentPatchAllowed(target, patch);
      const updated = await updateAgent(agentId, patch, `agent:${agent.id}`);
      audit(`agent:${agent.id}`, "agent.update", agentId, { fields: Object.keys(patch) });
      return json(agentSummary(updated, workspaceNames()));
    },
  }),

  defineTool({
    name: "agent_delete",
    description: "Delete an agent and its routines. Only do this when the human explicitly asked for it.",
    schema: z.object({ agentId: z.string() }),
    when: isManager,
    run: async ({ agentId }, { agent }) => {
      if (agentId === agent.id) return fail("You cannot delete yourself.");
      const target = getAgent(agentId);
      if (target.isDefault) return fail("The default Godmode agent cannot be deleted.");
      await deleteAgent(agentId);
      audit(`agent:${agent.id}`, "agent.delete", agentId, { name: target.name });
      return `Deleted agent "${target.name}".`;
    },
  }),

  defineTool({
    name: "routine_list",
    description: "List scheduled routines (cron tasks), optionally for one agent.",
    schema: z.object({ agentId: z.string().optional() }),
    when: isManager,
    run: ({ agentId }) =>
      json(
        listRoutines(agentId ? { agentId } : {}).map((r) => ({
          id: r.id,
          agentId: r.agentId,
          name: r.name,
          cron: r.cron,
          timezone: r.timezone,
          enabled: r.enabled,
          reuseConversation: r.reuseConversation,
          lastRunAt: r.lastRunAt,
          nextRunAt: r.nextRunAt,
          lastStatus: r.lastStatus,
          prompt: snippet(r.prompt, 500),
        })),
      ),
  }),

  defineTool({
    name: "routine_create",
    description: "Schedule a recurring task for an agent (cron).",
    schema: z.object({ agentId: z.string(), ...routineFields }),
    when: isManager,
    run: ({ timezone, ...input }, { agent }) => {
      const refusal = revealTargetRefusal(agent, getAgent(input.agentId), "schedule its tasks");
      if (refusal) return fail(refusal);
      const r = createRoutine({ ...input, timezone: timezone ?? localTimezone() });
      audit(`agent:${agent.id}`, "routine.create", r.id, { agentId: r.agentId });
      return json({ id: r.id, name: r.name, cron: r.cron, timezone: r.timezone, nextRunAt: r.nextRunAt });
    },
  }),

  defineTool({
    name: "routine_update",
    description: "Change a routine's schedule, prompt, name or enabled state.",
    schema: z.object({
      routineId: z.string(),
      name: routineFields.name.optional(),
      cron: routineFields.cron.optional(),
      prompt: routineFields.prompt.optional(),
      timezone: routineFields.timezone,
      enabled: routineFields.enabled,
      reuseConversation: routineFields.reuseConversation,
    }),
    when: isManager,
    run: ({ routineId, ...patch }, { agent }) => {
      const refusal = revealTargetRefusal(agent, getAgent(getRoutine(routineId).agentId), "schedule its tasks");
      if (refusal) return fail(refusal);
      const r = updateRoutine(routineId, patch);
      audit(`agent:${agent.id}`, "routine.update", routineId, { fields: Object.keys(patch) });
      return json({ id: r.id, name: r.name, cron: r.cron, enabled: r.enabled, nextRunAt: r.nextRunAt });
    },
  }),

  defineTool({
    name: "routine_delete",
    description: "Delete a routine.",
    schema: z.object({ routineId: z.string() }),
    when: isManager,
    run: ({ routineId }, { agent }) => {
      deleteRoutine(routineId);
      audit(`agent:${agent.id}`, "routine.delete", routineId, {});
      return "Routine deleted.";
    },
  }),

  defineTool({
    name: "runs_list",
    description:
      "Recent runs of all agents (or one agent) with status, result snippet and error — use it to check what every agent did and what failed.",
    schema: z.object({
      agentId: z.string().optional(),
      status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    when: isManager,
    run: ({ agentId, status, limit }) => {
      const names = new Map(listAgents({ workspaceId: "all" }).map((a) => [a.id, a.name]));
      const runs = listRuns({ agentId, status, limit: limit ?? 20 });
      return json(
        runs.map((r) => ({
          id: r.id,
          agent: names.get(r.agentId) ?? r.agentId,
          agentId: r.agentId,
          status: r.status,
          trigger: r.trigger,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          costUsd: r.costUsd,
          conversationId: r.conversationId,
          task: snippet(r.prompt, 200),
          result: snippet(r.result, 400),
          error: r.error,
        })),
      );
    },
  }),

  defineTool({
    name: "workspaces_list",
    description: "List workspaces (groups of agents, logins and integrations).",
    schema: z.object({}),
    when: isManager,
    run: () => json(listWorkspaces().map((w) => ({ id: w.id, name: w.name, description: w.description }))),
  }),

  defineTool({
    name: "logins_overview",
    description:
      "Overview of every saved login and 2FA entry in the vault (names, domains, scope, whether 2FA is linked — no secrets). Use it to tell the human what is missing.",
    schema: z.object({ domain: z.string().optional() }),
    when: isManager,
    run: ({ domain }) => {
      const names = workspaceNames();
      const creds = listCredentials({ workspaceId: "all" }).filter(
        (c) => !domain || c.domains.some((d) => domainMatches(domain, d)) || (c.url && domainMatches(domain, c.url)),
      );
      const totp = listTotp({ workspaceId: "all" });
      return json({
        logins: creds.map((c) => ({
          id: c.id,
          name: c.name,
          domains: c.domains,
          url: c.url,
          username: c.username,
          scope: scopeName(c.workspaceId, names),
          hasPassword: c.hasPassword,
          has2fa: c.totpId !== null || totp.some((t) => t.credentialId === c.id),
        })),
        twoFactor: totp.map((t) => ({
          id: t.id,
          issuer: t.issuer,
          accountName: t.accountName,
          scope: scopeName(t.workspaceId, names),
          linkedLoginId: t.credentialId,
        })),
      });
    },
  }),

  defineTool({
    name: "missing_logins_list",
    description: "Missing or broken logins reported by agents (default: open ones).",
    schema: z.object({ status: z.enum(["open", "resolved", "dismissed", "all"]).optional() }),
    when: isManager,
    run: ({ status }) => {
      const items = listMissingLogins(status === "all" ? {} : { status: status ?? "open" });
      return items.length ? json(items) : "No missing logins.";
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The run was delegated by this agent (in this run or an earlier one). */
function delegatedBy(r: Run, agent: Agent, ctx: RunContext): boolean {
  if (!r.parentRunId) return false;
  if (r.parentRunId === ctx.runId) return true;
  try {
    return getRun(r.parentRunId).agentId === agent.id;
  } catch {
    return false;
  }
}

function delegationReport(agentName: string, r: Run): ToolOutput {
  const ids = `(run ${r.id}, conversation ${r.conversationId})`;
  if (r.status === "succeeded") return `${agentName} finished the task ${ids}:\n\n${r.result ?? "(no answer)"}`;
  if (r.status === "failed") return fail(`${agentName} failed ${ids}: ${r.error ?? "unknown error"}${r.result ? `\n\n${r.result}` : ""}`);
  if (r.status === "cancelled") return fail(`The task for ${agentName} was cancelled ${ids}.`);
  return `${agentName} is still working (status: ${r.status}) ${ids}. Check again later with delegation_status({ runId: "${r.id}" }).`;
}

function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

const schemaCache = new Map<string, Record<string, unknown>>();

export function allToolNames(): string[] {
  return TOOLS.map((t) => t.name);
}

/** Tools listed for this agent (permission-filtered). */
export function listToolsFor(agent: Agent): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return TOOLS.filter((t) => !t.when || t.when(agent)).map((t) => {
    let schema = schemaCache.get(t.name);
    if (!schema) {
      schema = inputSchema(t.schema);
      schemaCache.set(t.name, schema);
    }
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

export function toolErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 423) return "The vault is locked; ask the human to unlock Godmode.";
    return err.message;
  }
  if (err instanceof z.ZodError) {
    return `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Run a tool as the run's agent. Throws UnknownToolError for names the gateway doesn't know. */
export async function callTool(ctx: RunContext, name: string, args: unknown): Promise<ToolCallResult> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new UnknownToolError(`Unknown tool: ${name}`);
  const result = (text: string, isError = false): ToolCallResult => ({
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  });
  try {
    const agent = getAgent(ctx.agentId);
    if (tool.when && !tool.when(agent)) return result(`The tool ${name} is not available to ${agent.name}.`, true);
    const parsed = tool.schema.parse(args ?? {});
    const out = await tool.run(parsed as never, { ctx, agent });
    return typeof out === "string" ? result(out) : result(out.text, out.isError === true);
  } catch (err) {
    if (!(err instanceof HttpError) && !(err instanceof z.ZodError)) log.warn(`tool ${name} failed (run ${ctx.runId})`, err);
    return result(toolErrorMessage(err), true);
  }
}
