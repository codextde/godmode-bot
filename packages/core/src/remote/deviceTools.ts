/**
 * Godmode tools of agents that work on a secondary (owner: remote). What they change or read about the shared setup —
 * the board, automations, agents, workspaces, settings, My tasks, saved logins — lives on the primary, so those calls
 * run there, in the run's name: the primary has the run and its chat as copies. Everything about the computer the
 * agent works on (its browser, screen, phones, VMs, the vault fill, follow-ups of its chat) stays on the secondary.
 */
import type { RunContext } from "../types";
import { get } from "../db";
import { logger } from "../log";
import { sleep } from "../util";
import { HttpError } from "../util";
import { callTool, type ToolCallResult } from "../mcp/tools";
import { isSecondary } from "./group";

const log = logger("devices");

export const SHARED_TOOLS: ReadonlySet<string> = new Set([
  "vault_save_login",
  "human_task_create",
  "human_tasks_list",
  "human_task_cancel",
  "phone_call",
  "phone_calls",
  "agents_list",
  "agent_get",
  "agent_create",
  "templates_list",
  "team_install",
  "agent_update",
  "agent_delete",
  "browser_profile_create",
  "browser_profiles_list",
  "browser_profile_create_own",
  "routine_list",
  "automation_triggers_list",
  "routine_create",
  "routine_update",
  "routine_run",
  "routine_delete",
  "my_routines",
  "my_routine_set_enabled",
  "automation_events_list",
  "task_report_blocked",
  "tasks_list",
  "goals_list",
  "task_create",
  "task_split",
  "task_update",
  "task_get",
  "task_message",
  "task_note",
  "spend_overview",
  "runs_list",
  "workspaces_list",
  "workspace_create",
  "workspace_update",
  "project_create",
  "project_update",
  "plugins_list",
  "plugin_install",
  "plugin_update",
  "plugin_save",
  "settings_get",
  "settings_update",
  "logins_overview",
  "missing_logins_list",
  "self_repair",
]);

const TOOL_TIMEOUT_MS = 10 * 60_000;
const RUN_WAIT_MS = 5_000;

/** On a secondary: does this call run on the primary? Connected apps call this computer's own tools. */
export function runsOnPrimary(ctx: RunContext, name: string): boolean {
  return !ctx.connector && isSecondary() && SHARED_TOOLS.has(name);
}

export async function callOnPrimary(ctx: RunContext, name: string, args: unknown): Promise<ToolCallResult> {
  try {
    const { primaryLink } = await import("./devices");
    return await primaryLink().json<ToolCallResult>(
      "POST",
      "/api/link/devices/tool",
      { name, args: args ?? {}, runId: ctx.runId, agentId: ctx.agentId, conversationId: ctx.conversationId, depth: ctx.depth },
      { timeoutMs: TOOL_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`tool ${name} couldn't reach the primary`, { error: msg });
    return { content: [{ type: "text", text: `${name} works on the primary computer of this device group, which can't be reached right now: ${msg}` }], isError: true };
  }
}

/**
 * On the primary: a tool call of a run on the secondary at the other end of the link. The run must be one of that
 * computer's (its copy here says so); a run that just started may still be on its way.
 */
export async function callForDevice(
  controllerId: string,
  input: { name: string; args: unknown; runId: string; agentId: string; conversationId: string; depth: number },
): Promise<ToolCallResult> {
  const { deviceIdOf } = await import("./devices");
  const deviceId = deviceIdOf(controllerId);
  if (!deviceId) throw new HttpError(403, "Only computers of this device group call tools here.", "not_in_group");
  const end = Date.now() + RUN_WAIT_MS;
  let run = null as { agent_id: string; conversation_id: string; workspace_id: string | null } | null;
  for (;;) {
    run = get<{ agent_id: string; conversation_id: string; workspace_id: string | null }>(
      `SELECT r.agent_id, r.conversation_id, a.workspace_id FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN agents a ON a.id = r.agent_id
        WHERE r.id = ? AND c.runner_id = ?`,
      input.runId,
      deviceId,
    );
    if (run || Date.now() > end) break;
    await sleep(200);
  }
  if (!run || run.conversation_id !== input.conversationId || run.agent_id !== input.agentId) {
    return { content: [{ type: "text", text: "The primary doesn't know this run yet. Try again in a moment." }], isError: true };
  }
  const ctx: RunContext = { runId: input.runId, agentId: run.agent_id, conversationId: run.conversation_id, workspaceId: run.workspace_id, depth: input.depth };
  return callTool(ctx, input.name, input.args);
}
