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
  ["GET", /^\/api\/missing-logins$/],
  // Questions and approvals agents wait for: listed and answered (no files from the phone).
  ["GET", /^\/api\/questions$/],
  ["POST", new RegExp(`^/api/questions/${ID}/answer$`)],
  // Tasks agents gave the human: listed, moved and closed (no files from the phone).
  ["GET", /^\/api\/human-tasks$/],
  ["PATCH", new RegExp(`^/api/human-tasks/${ID}$`)],
  ["POST", new RegExp(`^/api/human-tasks/${ID}/close$`)],

  ["GET", /^\/api\/agents$/],
  ["POST", /^\/api\/agents$/],
  ["GET", new RegExp(`^/api/agents/${ID}$`)],
  ["PATCH", new RegExp(`^/api/agents/${ID}$`)],
  ["GET", new RegExp(`^/api/agents/${ID}/commands$`)],
  ["GET", /^\/api\/models$/],

  ["GET", /^\/api\/conversations$/],
  ["GET", new RegExp(`^/api/conversations/${ID}$`)],
  ["PATCH", new RegExp(`^/api/conversations/${ID}$`)],
  ["DELETE", new RegExp(`^/api/conversations/${ID}$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/messages$`)],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/queue/${ID}$`)],
  ["DELETE", new RegExp(`^/api/conversations/${ID}/queue/${ID}$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/queue/send$`)],
  ["POST", new RegExp(`^/api/conversations/${ID}/(pause|continue|retry)$`)],
  ["POST", /^\/api\/chat$/],

  ["GET", /^\/api\/tasks$/],
  ["POST", /^\/api\/tasks\/attachments$/],
  ["GET", new RegExp(`^/api/tasks/attachments/${ID}/${ID}$`)],
  ["GET", new RegExp(`^/api/tasks/${ID}$`)],
  ["GET", new RegExp(`^/api/tasks/${ID}/events$`)],
  ["POST", /^\/api\/tasks$/],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`)],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`)],

  ["GET", /^\/api\/runs$/],
  ["POST", new RegExp(`^/api/runs/${ID}/cancel$`)],

  ["GET", /^\/api\/routines$/],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`)],
  ["POST", new RegExp(`^/api/routines/${ID}/run$`)],

  ["GET", /^\/api\/browser\/profiles$/],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`)],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/input$`)],
  ["POST", /^\/api\/computer\/input$/],

  ["GET", /^\/api\/vms$/],
  ["GET", new RegExp(`^/api/vms/${ID}/screenshot$`)],
  ["POST", new RegExp(`^/api/vms/${ID}/(start|stop|input)$`)],
];

/**
 * Settings a phone may change, by section. Program paths, extra CLI flags, permission bypass, security, the server, the
 * phone listener and the cloud link stay on the computer.
 */
const SETTINGS: Record<string, string[]> = {
  general: ["userName", "desktopNotifications"],
  runner: [
    "model",
    "fallbackModel",
    "effort",
    "ultracode",
    "maxConcurrentRuns",
    "runTimeoutMinutes",
    "autoContinueOnLimit",
    "watchdog",
    "stallMinutes",
    "loopRepeats",
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
/** Ranges for the numbers a phone may set (as on the computer); text length limits. */
const LIMITS: Record<string, [min: number, max: number]> = {
  "runner.maxConcurrentRuns": [1, 32],
  "runner.runTimeoutMinutes": [0, 1440],
  "runner.stallMinutes": [3, 240],
  "runner.loopRepeats": [3, 50],
  "runner.defaultMaxBudgetUsd": [0.01, 10_000],
  "runner.monthlyBudgetUsd": [0.01, 1_000_000],
  "browser.keepAliveMinutes": [0, 1440],
  "computer.liveViewFps": [1, 10],
  "vm.idleStopMinutes": [0, 1440],
  "general.userName": [0, 80],
};

const WORKSPACE_KEYS = ["name", "description", "color", "icon", "instructions", "autoMerge", "browserProfileId", "sources"];
const PROJECT_KEYS = ["name", "description", "color", "icon", "instructions", "browserProfileId", "sources"];
/** What an agent is and how it thinks; its permissions, tools, folders and machines are set on the computer. */
const AGENT_KEYS = ["name", "role", "description", "instructions", "personality", "model", "effort", "ultracode", "enabled", "projectId", "heartbeat"];

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
  ["POST", /^\/api\/chat$/, ["agentId", "content", "attachments", "workspaceId", "model", "effort", "ultracode"]],
  // A task's repository and branch are picked on the computer: the phone never points an agent at another repository.
  ["POST", /^\/api\/tasks$/, ["workspaceId", "title", "description", "type", "status", "agentId"]],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`), ["title", "description", "status", "agentId", "archived"]],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`), ["content", "attachments"]],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`), ["enabled"]],
  ["POST", new RegExp(`^/api/questions/${ID}/answer$`), ["optionId", "decision", "note", "text"]],
  ["PATCH", new RegExp(`^/api/human-tasks/${ID}$`), ["status", "beforeId"]],
  ["POST", new RegExp(`^/api/human-tasks/${ID}/close$`), ["outcome", "note"]],
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
  if (!("sources" in body)) return null;
  const sources = body.sources;
  if (!Array.isArray(sources)) return null;
  const folders = sources.filter((s): s is { kind: "folder"; path?: unknown } => typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "folder");
  if (!folders.length) return null;
  const known = new Set(existingFolders(method, path));
  return folders.every((f) => typeof f.path === "string" && known.has(f.path)) ? null : "Add folders of your computer in Godmode there. From the phone you can add git repositories.";
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
      if (!sameShape(value, current[section]?.[key], NULLABLE_SETTINGS.has(key)) || !inRange(`${section}.${key}`, value)) return `Invalid value for ${section}.${key}.`;
    }
  }
  return null;
}

function inRange(key: string, value: unknown): boolean {
  const limit = LIMITS[key];
  if (!limit || value === null) return true;
  const [min, max] = limit;
  if (typeof value === "string") return value.length <= max;
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function sameShape(value: unknown, current: unknown, nullable: boolean): boolean {
  if (value === null) return nullable || current === null;
  if (current === null || current === undefined) return nullable && typeof value === "number";
  if (typeof current !== "object" || Array.isArray(current)) return typeof value === typeof current;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const shape = current as Record<string, unknown>;
  return Object.entries(value as Record<string, unknown>).every(([k, v]) => Object.hasOwn(shape, k) && sameShape(v, shape[k], false));
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
