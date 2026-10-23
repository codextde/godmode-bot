/**
 * What a paired phone may call. The app controls Godmode — chats (with files from the phone, the model and the queue),
 * tasks, runs, automations, the screens agents work on, and the setup: instructions, the defaults agents run with,
 * workspaces, projects and agents — but never reaches secrets, backups, integrations, security or this computer's files
 * (only the ones attached to tasks, and what it uploads itself). It can't point an agent at a folder, a program or a
 * permission the computer didn't give it, and only controls screens the human shared in a chat and Godmode's VMs.
 */
import { computerView, type ComputerTarget } from "@godmode/shared";
import { all, get } from "../db";
import { getSettings } from "../services/settings";
import { sameSettingShape, settingInRange } from "../services/settingShape";
import { parseJson } from "../util";

const ID = "[^/]+";

const ROUTES: [method: string, path: RegExp][] = [
  ["GET", /^\/api\/bootstrap$/],
  ["GET", /^\/api\/mobile\/me$/],
  ["DELETE", /^\/api\/mobile\/me$/],
  ["GET", /^\/api\/workspaces$/],
  ["POST", /^\/api\/workspaces$/],
  ["PATCH", new RegExp(`^/api/workspaces/${ID}$`)],
  // Only an empty workspace: deleting one with everything in it (`force`) stays on the computer.
  ["DELETE", new RegExp(`^/api/workspaces/${ID}$`)],
  ["POST", new RegExp(`^/api/workspaces/${ID}/sources/${ID}/sync$`)],
  ["GET", /^\/api\/projects$/],
  ["POST", /^\/api\/projects$/],
  ["PATCH", new RegExp(`^/api/projects/${ID}$`)],
  ["DELETE", new RegExp(`^/api/projects/${ID}$`)],
  ["POST", new RegExp(`^/api/projects/${ID}/sources/${ID}/sync$`)],
  ["GET", /^\/api\/settings$/],
  ["PUT", /^\/api\/settings$/],
  ["GET", /^\/api\/notifications$/],
  ["POST", /^\/api\/notifications\/read$/],
  // What waits for the human and what the team did while they were away.
  ["GET", /^\/api\/attention$/],
  ["GET", /^\/api\/away$/],
  // Logins agents miss: seen, dismissed or opened again. Logins themselves are added on the computer.
  ["GET", /^\/api\/missing-logins$/],
  ["PATCH", new RegExp(`^/api/missing-logins/${ID}$`)],
  // Questions and approvals agents wait for: listed and answered (no files from the phone).
  ["GET", /^\/api\/questions$/],
  ["POST", new RegExp(`^/api/questions/${ID}/answer$`)],
  // Tasks agents gave the human, and the human's own: listed, added, edited, moved, closed and deleted (no files from the phone).
  ["GET", /^\/api\/human-tasks$/],
  ["POST", /^\/api\/human-tasks$/],
  ["PATCH", new RegExp(`^/api/human-tasks/${ID}$`)],
  ["DELETE", new RegExp(`^/api/human-tasks/${ID}$`)],
  ["POST", new RegExp(`^/api/human-tasks/${ID}/close$`)],
  // Calls agents made and took: read, never placed from the phone (nor their setup).
  ["GET", /^\/api\/calls$/],
  ["GET", /^\/api\/calls\/call_[^/]+$/],

  ["GET", /^\/api\/agent-templates$/],
  ["GET", /^\/api\/agents$/],
  ["POST", /^\/api\/agents$/],
  ["GET", new RegExp(`^/api/agents/${ID}$`)],
  ["PATCH", new RegExp(`^/api/agents/${ID}$`)],
  ["GET", new RegExp(`^/api/agents/${ID}/commands$`)],
  // A failed run the human has seen, the heartbeat (seen, woken now) and dreams (seen, started, read); a dream is undone on the computer.
  ["DELETE", new RegExp(`^/api/agents/${ID}/failed-run$`)],
  ["GET", new RegExp(`^/api/agents/${ID}/heartbeat$`)],
  ["POST", new RegExp(`^/api/agents/${ID}/heartbeat/beat$`)],
  ["GET", new RegExp(`^/api/agents/${ID}/dreams$`)],
  ["POST", new RegExp(`^/api/agents/${ID}/dreams$`)],
  ["GET", new RegExp(`^/api/dreams/${ID}$`)],
  // Only MEMORY.md, through the memory editor: the rest of the agent's repository stays on the computer.
  ["GET", new RegExp(`^/api/agents/${ID}/memory$`)],
  ["PUT", new RegExp(`^/api/agents/${ID}/memory$`)],
  ["GET", /^\/api\/models$/],

  ["GET", /^\/api\/conversations$/],
  ["POST", /^\/api\/conversations\/read$/],
  ["GET", new RegExp(`^/api/conversations/${ID}$`)],
  ["GET", new RegExp(`^/api/conversations/${ID}/messages$`)],
  ["GET", new RegExp(`^/api/conversations/${ID}/messages/${ID}/images/${ID}$`)],
  ["PATCH", new RegExp(`^/api/conversations/${ID}$`)],
  ["DELETE", new RegExp(`^/api/conversations/${ID}$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/messages$`)],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/queue/${ID}$`)],
  ["DELETE", new RegExp(`^/api/conversations/${ID}/queue/${ID}$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/queue/send$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/(pause|continue|retry)$`)],
  // A follow-up the agent set: moved, run now or cancelled.
  ["PATCH", new RegExp(`^/api/conversations/${ID}/followup$`)],
  ["DELETE", new RegExp(`^/api/conversations/${ID}/followup$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/followup/run$`)],
  ["POST", /^\/api\/chat$/],
  ["GET", /^\/api\/followups$/],

  ["GET", /^\/api\/tasks$/],
  ["POST", /^\/api\/tasks\/attachments$/],
  ["GET", new RegExp(`^/api/tasks/attachments/${ID}/${ID}$`)],
  ["GET", new RegExp(`^/api/tasks/${ID}$`)],
  ["GET", new RegExp(`^/api/tasks/${ID}/events$`)],
  ["POST", /^\/api\/tasks$/],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`)],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`)],
  ["POST", new RegExp(`^/api/tasks/${ID}/approve$`)],
  ["GET", /^\/api\/goals$/],
  ["POST", /^\/api\/goals$/],
  ["PATCH", new RegExp(`^/api/goals/${ID}$`)],
  ["DELETE", new RegExp(`^/api/goals/${ID}$`)],

  ["GET", /^\/api\/runs$/],
  ["GET", new RegExp(`^/api/runs/${ID}$`)],
  ["GET", new RegExp(`^/api/runs/${ID}/log$`)],
  ["POST", new RegExp(`^/api/runs/${ID}/cancel$`)],
  ["GET", /^\/api\/spend$/],

  // Scheduled and condition automations are set up from the phone too; app events and webhooks only on the computer.
  ["GET", /^\/api\/routines$/],
  ["POST", /^\/api\/routines$/],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`)],
  ["DELETE", new RegExp(`^/api/routines/${ID}$`)],
  ["POST", new RegExp(`^/api/routines/${ID}/run$`)],
  ["GET", new RegExp(`^/api/routines/${ID}/events$`)],

  ["GET", /^\/api\/browser\/profiles$/],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`)],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/input$`)],
  ["POST", /^\/api\/computer\/input$/],

  // Android phones agents use: seen and watched, never controlled, connected or changed from a phone.
  ["GET", /^\/api\/android\/devices$/],
  ["GET", new RegExp(`^/api/android/devices/${ID}/screenshot$`)],

  ["GET", /^\/api\/vms$/],
  ["GET", new RegExp(`^/api/vms/${ID}/screenshot$`)],
  ["POST", new RegExp(`^/api/vms/${ID}/(start|stop|input)$`)],
];

/**
 * Settings a phone may change, by section. Program paths, extra CLI flags, permission bypass, security, the server, the
 * phone listener and the cloud link stay on the computer.
 */
const SETTINGS: Record<string, string[]> = {
  general: ["userName", "desktopNotifications", "theme", "mode"],
  runner: [
    "model",
    "fallbackModel",
    "effort",
    "ultracode",
    "maxConcurrentRuns",
    "runTimeoutMinutes",
    "autoContinueOnLimit",
    "resumeAfterRestart",
    "watchdog",
    "stallMinutes",
    "loopRepeats",
    "autoCompactPercent",
    "spendTracking",
    "defaultMaxBudgetUsd",
    "monthlyBudgetUsd",
    "appendSystemPrompt",
  ],
  browser: ["enabled", "headless", "keepAliveMinutes", "liveView", "stealth", "muteAudio"],
  computer: ["enabled", "allowForeground", "agentCursor", "liveView", "liveViewFps"],
  vm: ["enabled", "onQuit", "idleStopMinutes"],
  memory: ["autoCommit", "reflectAfterRun", "injectMemory", "dreaming"],
  maintenance: ["autoFix", "autoUpdate", "autoCleanup"],
};
const NULLABLE_SETTINGS = new Set(["defaultMaxBudgetUsd", "monthlyBudgetUsd"]);

const WORKSPACE_KEYS = ["name", "description", "color", "icon", "instructions", "autoMerge", "browserProfileId", "sources"];
const PROJECT_KEYS = ["name", "description", "color", "icon", "instructions", "browserProfileId", "sources"];
/** What an agent is, looks like and how it thinks; its permissions, tools, folders and machines are set on the computer. */
/** Never `fillOnly`: only the human on the computer lets an automation's runs read raw secrets. */
const ROUTINE_KEYS = ["agentId", "name", "trigger", "cron", "timezone", "prompt", "filter", "enabled", "reuseConversation", "notify"];
const GOAL_KEYS = ["title", "why", "workspaceId", "targetDate", "status"];
const AGENT_KEYS = ["name", "role", "description", "instructions", "personality", "avatar", "color", "character", "model", "effort", "ultracode", "enabled", "projectId", "heartbeat"];

/** Requests whose JSON body may only carry these fields when a phone sends them. */
const BODIES: [method: string, path: RegExp, keys: string[]][] = [
  ["PUT", /^\/api\/settings$/, Object.keys(SETTINGS)],
  ["POST", /^\/api\/workspaces$/, WORKSPACE_KEYS],
  ["PATCH", new RegExp(`^/api/workspaces/${ID}$`), WORKSPACE_KEYS],
  ["POST", /^\/api\/projects$/, ["workspaceId", ...PROJECT_KEYS]],
  ["PATCH", new RegExp(`^/api/projects/${ID}$`), PROJECT_KEYS],
  ["POST", /^\/api\/agents$/, ["workspaceId", ...AGENT_KEYS]],
  ["PATCH", new RegExp(`^/api/agents/${ID}$`), AGENT_KEYS],
  ["POST", new RegExp(`^/api/(workspaces|projects)/${ID}/sources/${ID}/sync$`), []],
  ["PATCH", new RegExp(`^/api/conversations/${ID}$`), ["title", "pinned", "archived", "model", "effort", "ultracode"]],
  ["POST", new RegExp(`^/api/conversations/${ID}/messages$`), ["content", "attachments", "queue", "queueId"]],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/queue/${ID}$`), ["content"]],
  ["POST", /^\/api\/chat$/, ["agentId", "content", "attachments", "workspaceId", "projectId", "model", "effort", "ultracode"]],
  // A task's repository and branch are picked on the computer: the phone never points an agent at another repository.
  ["POST", /^\/api\/tasks$/, ["workspaceId", "projectId", "title", "description", "type", "status", "agentId"]],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`), ["title", "description", "status", "agentId", "archived", "projectId"]],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`), ["content", "attachments"]],
  ["POST", new RegExp(`^/api/tasks/${ID}/approve$`), []],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/followup$`), ["dueAt"]],
  ["POST", new RegExp(`^/api/conversations/${ID}/followup/run$`), []],
  ["POST", /^\/api\/routines$/, ROUTINE_KEYS],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`), ROUTINE_KEYS],
  ["POST", /^\/api\/goals$/, GOAL_KEYS],
  ["PATCH", new RegExp(`^/api/goals/${ID}$`), GOAL_KEYS],
  ["POST", /^\/api\/conversations\/read$/, ["ids"]],
  ["POST", new RegExp(`^/api/agents/${ID}/heartbeat/beat$`), []],
  ["POST", new RegExp(`^/api/agents/${ID}/dreams$`), []],
  ["POST", new RegExp(`^/api/questions/${ID}/answer$`), ["optionId", "decision", "note", "text"]],
  ["POST", /^\/api\/human-tasks$/, ["title", "body", "url", "priority", "workspaceId", "status"]],
  ["PATCH", new RegExp(`^/api/human-tasks/${ID}$`), ["status", "beforeId", "priority", "title", "body"]],
  ["POST", new RegExp(`^/api/human-tasks/${ID}/close$`), ["outcome", "note", "optionId"]],
  ["POST", /^\/api\/notifications\/read$/, ["ids"]],
  // A login is linked to a request on the computer, where the vault is.
  ["PATCH", new RegExp(`^/api/missing-logins/${ID}$`), ["status"]],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`), []],
  ["POST", /^\/api\/computer\/input$/, ["view", "event", "frame"]],
  ["POST", new RegExp(`^/api/vms/${ID}/input$`), ["event", "frame"]],
];

export function deviceMayCall(method: string, path: string): boolean {
  const m = method === "HEAD" ? "GET" : method;
  return ROUTES.some(([rm, re]) => rm === m && re.test(path));
}

/** The fields a phone may send to this route; null = no body rules. */
export function deviceBodyKeys(method: string, path: string): string[] | null {
  return BODIES.find(([m, re]) => m === method && re.test(path))?.[2] ?? null;
}

/** Why a phone's query string is refused (null = fine): deleting a workspace with everything in it stays on the computer. */
export function deviceQueryRefusal(method: string, path: string, query: URLSearchParams): string | null {
  if (method === "DELETE" && path.startsWith("/api/workspaces/") && query.has("force")) {
    return "Delete a workspace with agents, chats or tasks in it on your computer.";
  }
  return null;
}

/**
 * Why a phone's body is refused beyond its fields (null = fine): settings keep their shape and the phone's sections, and
 * folders may only be kept where they already are — a phone adds repositories, never a folder of this computer.
 */
export function deviceBodyRefusal(method: string, path: string, body: Record<string, unknown>): string | null {
  if (path === "/api/settings") return settingsRefusal(body);
  if (path.startsWith("/api/routines")) return routineRefusal(body);
  if (!("sources" in body)) return null;
  const sources = body.sources;
  if (!Array.isArray(sources)) return null;
  const folders = sources.filter((s): s is { kind: "folder"; path?: unknown } => typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "folder");
  if (!folders.length) return null;
  const known = new Set(existingFolders(method, path));
  return folders.every((f) => typeof f.path === "string" && known.has(f.path)) ? null : "Add folders of your computer in Godmode there. From the phone you can add git repositories.";
}

/** A phone sets up schedules and conditions; app events and webhooks need connections and secret URLs that live on the computer. */
function routineRefusal(body: Record<string, unknown>): string | null {
  const trigger = body.trigger as { type?: unknown } | undefined;
  if (trigger === undefined || trigger === null) return null;
  return typeof trigger === "object" && (trigger.type === "schedule" || trigger.type === "condition")
    ? null
    : "Set up app and webhook automations in Godmode on your computer.";
}

function existingFolders(method: string, path: string): string[] {
  if (method !== "PATCH") return [];
  const [, , kind, id] = path.split("/");
  const owner =
    kind === "workspaces"
      ? { workspace: id, project: null }
      : { workspace: get<{ workspace_id: string }>("SELECT workspace_id FROM projects WHERE id = ?", id)?.workspace_id, project: id };
  if (!owner.workspace) return [];
  return all<{ path: string }>(
    "SELECT path FROM workspace_sources WHERE kind = 'folder' AND workspace_id = ? AND project_id IS ?",
    owner.workspace,
    owner.project,
  ).map((r) => r.path);
}

function settingsRefusal(body: Record<string, unknown>): string | null {
  const current = getSettings() as unknown as Record<string, Record<string, unknown>>;
  for (const [section, patch] of Object.entries(body)) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return `Invalid ${section} settings.`;
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTINGS[section]?.includes(key)) return "Change this setting in Godmode on your computer.";
      if (!sameSettingShape(value, current[section]?.[key], NULLABLE_SETTINGS.has(key)) || !settingInRange(`${section}.${key}`, value)) return `Invalid value for ${section}.${key}.`;
    }
  }
  return null;
}

/** A phone may watch and control a screen only while it is shared in a chat. */
export function deviceMayUseView(view: string): boolean {
  for (const row of all<{ computer_target: string }>("SELECT computer_target FROM conversations WHERE computer_target IS NOT NULL")) {
    const target = parseJson<ComputerTarget | null>(row.computer_target, null);
    if (!target) continue;
    if (target.kind === "desktop" ? view.startsWith("display:") : computerView(target) === view) return true;
  }
  return false;
}
