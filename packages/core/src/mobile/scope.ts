/**
 * What a paired phone may call. The app controls Godmode — chats (with files from the phone, the model and the queue),
 * tasks, runs, automations, calls, the screens agents work on, and the setup: instructions, the defaults agents run with,
 * workspaces, projects and agents — and reads the vault, integrations and agents' folders without their secrets
 * (mobile/views.ts), but never reaches secrets, backups, security or this computer's other files (only the ones attached
 * to tasks, and what it uploads itself). It can't point an agent at a folder, a program or a
 * permission the computer didn't give it, and only controls screens the human shared in a chat, Android phones a chat
 * uses and Godmode's VMs.
 */
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import { computerView, type ComputerTarget } from "@godmode/shared";
import { all, get } from "../db";
import { getSettings } from "../services/settings";
import { NULLABLE_SETTINGS, sameSettingShape, settingInRange } from "../services/settingShape";
import { parseJson } from "../util";
import { isMachineFolder, isSecretFileName, phoneFilePathRefusal } from "./views";

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
  ["GET", /^\/api\/archive$/],
  ["POST", /^\/api\/archive$/],
  ["GET", /^\/api\/settings$/],
  ["PUT", /^\/api\/settings$/],
  ["GET", /^\/api\/notifications$/],
  ["POST", /^\/api\/notifications\/read$/],
  // Clearing the notifications list; the runs and results behind them stay.
  ["DELETE", /^\/api\/notifications$/],
  // What waits for the human (read-only), and the work the main agent offers to take on: started or declined.
  ["GET", /^\/api\/attention$/],
  ["GET", /^\/api\/offers$/],
  ["POST", /^\/api\/offers\/ofr_[^/]+\/(accept|dismiss)$/],
  // What the team did while the human was away (Home's card).
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
  // Calls agents made and took: read, and placed like the desktop's New call (see BODIES). The numbers they go out from,
  // the owner's PIN, the setup and test calls stay on the computer.
  ["GET", /^\/api\/calls$/],
  ["POST", /^\/api\/calls$/],
  ["GET", /^\/api\/calls\/call_[^/]+$/],
  ["GET", /^\/api\/calls\/call_[^/]+\/audio$/],

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
  // Its folder is read (folderPathRefusal); only its notes under memory/ are written (deviceBodyRefusal). Its history is
  // read, never rewound. Moving, deleting and the bin stay on the computer.
  ["GET", new RegExp(`^/api/agents/${ID}/files?$`)],
  ["GET", new RegExp(`^/api/agents/${ID}/files/(raw|search)$`)],
  ["GET", /^\/api\/files\/overview$/],
  ["PUT", new RegExp(`^/api/agents/${ID}/file$`)],
  ["GET", new RegExp(`^/api/agents/${ID}/commits$`)],
  // All its work paused or continued, run once, copied (not one that reads raw secrets) or deleted (never the built-in one).
  ["POST", new RegExp(`^/api/agents/${ID}/(pause|continue|run|duplicate)$`)],
  ["DELETE", new RegExp(`^/api/agents/${ID}$`)],
  // Whole teams, made like agents set up on the phone: no logins, no inherited tools, fill-only secrets and automations.
  ["GET", /^\/api\/team-templates$/],
  ["POST", new RegExp(`^/api/team-templates/${ID}/install$`)],
  ["GET", /^\/api\/models$/],

  ["GET", /^\/api\/conversations$/],
  ["POST", /^\/api\/conversations\/(read|unread)$/],
  ["GET", new RegExp(`^/api/conversations/${ID}$`)],
  ["GET", new RegExp(`^/api/conversations/${ID}/messages$`)],
  ["GET", new RegExp(`^/api/conversations/${ID}/messages/${ID}/images/${ID}$`)],
  // Pictures the human attached to a chat: only images from the agent's workspace/uploads (the core checks the path).
  ["GET", new RegExp(`^/api/conversations/${ID}/attachment$`)],
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
  // Whether a run that waits for Claude's usage limit continues by itself after the reset.
  ["PATCH", new RegExp(`^/api/conversations/${ID}/pause$`)],
  // Chats, messages and tickets by their words; agents' notes stay on the computer (`notes=0`, see deviceQueryRefusal).
  ["GET", /^\/api\/search$/],
  // Dictation: the computer transcribes with its own key or Hex; spoken replies and setting up Hex stay there.
  ["POST", /^\/api\/voice\/transcribe$/],

  ["GET", /^\/api\/tasks$/],
  ["POST", /^\/api\/tasks\/attachments$/],
  ["GET", new RegExp(`^/api/tasks/attachments/${ID}/${ID}$`)],
  ["GET", new RegExp(`^/api/tasks/${ID}$`)],
  ["GET", new RegExp(`^/api/tasks/${ID}/events$`)],
  ["POST", /^\/api\/tasks$/],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`)],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`)],
  ["POST", new RegExp(`^/api/tasks/${ID}/approve$`)],
  // Deleting a ticket removes its worktree; a pushed branch and pull request stay. Pushing uses the ticket's own remote.
  ["DELETE", /^\/api\/tasks\/tsk_[^/]+$/],
  ["POST", /^\/api\/tasks\/tsk_[^/]+\/(push|pull-request)$/],
  ["GET", /^\/api\/goals$/],
  ["POST", /^\/api\/goals$/],
  ["PATCH", new RegExp(`^/api/goals/${ID}$`)],
  ["DELETE", new RegExp(`^/api/goals/${ID}$`)],

  ["GET", /^\/api\/runs$/],
  ["GET", new RegExp(`^/api/runs/${ID}$`)],
  ["GET", new RegExp(`^/api/runs/${ID}/log$`)],
  ["POST", new RegExp(`^/api/runs/${ID}/cancel$`)],

  // Scheduled and condition automations are set up from the phone too; app events and webhooks only on the computer.
  ["GET", /^\/api\/routines$/],
  ["POST", /^\/api\/routines$/],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`)],
  ["DELETE", new RegExp(`^/api/routines/${ID}$`)],
  ["POST", new RegExp(`^/api/routines/${ID}/run$`)],
  ["GET", new RegExp(`^/api/routines/${ID}/events$`)],
  ["GET", /^\/api\/automation-events$/],

  // Artifacts: opened, used, changed through their chat, refreshed, restored, pinned and deleted. Their files open in the
  // sandbox page; opening or revealing one on the computer stays there.
  ["GET", /^\/api\/artifacts$/],
  ["POST", /^\/api\/artifacts\/start$/],
  ["GET", new RegExp(`^/api/artifacts/${ID}$`)],
  ["PATCH", new RegExp(`^/api/artifacts/${ID}$`)],
  ["DELETE", new RegExp(`^/api/artifacts/${ID}$`)],
  ["PUT", new RegExp(`^/api/artifacts/${ID}/data$`)],
  ["GET", new RegExp(`^/api/artifacts/${ID}/versions$`)],
  ["GET", new RegExp(`^/api/artifacts/${ID}/versions/${ID}$`)],
  ["POST", new RegExp(`^/api/artifacts/${ID}/(restore|message|refresh|review-done)$`)],

  ["GET", /^\/api\/browser\/profiles$/],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`)],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/input$`)],
  // Profiles: made empty, renamed, made the default, stopped, checked and deleted. Importing a Chrome profile stays on the computer.
  ["POST", /^\/api\/browser\/profiles$/],
  ["PATCH", new RegExp(`^/api/browser/profiles/${ID}$`)],
  ["DELETE", new RegExp(`^/api/browser/profiles/${ID}$`)],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/(stop|bot-check)$`)],
  ["POST", /^\/api\/computer\/input$/],
  ["GET", /^\/api\/computer\/status$/],
  ["POST", /^\/api\/computer\/cua\/stop$/],

  // Android phones agents use: seen and watched; controlled only while a chat uses them (deviceTargetRefusal). Connecting,
  // renaming, assigning, forgetting and shell commands stay on the computer.
  ["GET", /^\/api\/android\/devices$/],
  ["GET", new RegExp(`^/api/android/devices/${ID}/screenshot$`)],
  ["POST", new RegExp(`^/api/android/devices/${ID}/input$`)],

  ["GET", /^\/api\/vms$/],
  ["GET", new RegExp(`^/api/vms/${ID}/screenshot$`)],
  ["POST", new RegExp(`^/api/vms/${ID}/(start|stop|suspend|restart|input)$`)],

  // Passwords, read-only: lists without a password, 2FA code or seed, card number or private key (mobile/views.ts trims
  // the rest). Locking the vault only takes access away; unlocking, revealing and every change stay on the computer.
  ["GET", /^\/api\/vault\/status$/],
  ["POST", /^\/api\/vault\/lock$/],
  ["GET", /^\/api\/vault\/mac-password$/],
  ["GET", /^\/api\/credentials$/],
  ["GET", /^\/api\/totp$/],
  ["GET", /^\/api\/passkeys$/],
  ["GET", /^\/api\/cards$/],
  ["GET", /^\/api\/card-purchases$/],
  ["GET", /^\/api\/ssh\/key-manager$/],
  // Integrations, plugins, messaging and SSH servers as lists without commands, keys, code or secret paths. A plugin is
  // switched off from the phone, never on (that runs code); a server's test signs in and reads its OS, nothing else.
  ["GET", /^\/api\/mcp-servers$/],
  ["GET", /^\/api\/api-tools$/],
  ["GET", /^\/api\/composio\/(status|connections)$/],
  ["GET", /^\/api\/mods$/],
  ["PATCH", new RegExp(`^/api/mods/${ID}$`)],
  ["GET", /^\/api\/messaging$/],
  ["GET", /^\/api\/ssh\/servers$/],
  ["POST", new RegExp(`^/api/ssh/servers/${ID}/test$`)],

  // Settings on the phone. Auto review: read, run now, a change undone.
  ["GET", /^\/api\/reviews$/],
  ["POST", /^\/api\/reviews$/],
  ["GET", new RegExp(`^/api/reviews/${ID}$`)],
  ["POST", new RegExp(`^/api/reviews/${ID}/actions/\\d+/undo$`)],
  // Memory from another assistant (pasted text, starts a chat) and every agent dreaming now.
  ["POST", /^\/api\/memory\/import$/],
  ["POST", /^\/api\/dreams\/all$/],
  // Claude accounts: usage and the default. Signing in and removing stay on the computer.
  ["GET", /^\/api\/claude-accounts$/],
  ["POST", /^\/api\/claude-accounts\/refresh$/],
  ["POST", new RegExp(`^/api/claude-accounts/${ID}/default$`)],
  // Cleanup (only what is safe without a look, see PHONE_CLEANUP) and Optimize now.
  ["GET", /^\/api\/cleanup$/],
  ["POST", /^\/api\/cleanup$/],
  ["GET", /^\/api\/optimize$/],
  ["POST", /^\/api\/optimize$/],
  // Read-only status: health, power, licence, usage, cloud, the device group and logs. Installs, fixes, keys, links and
  // pairing stay on the computer; lid-closed mode switches from the phone only once macOS allowed it there.
  ["GET", /^\/api\/doctor$/],
  ["GET", /^\/api\/doctor\/(permissions|maintenance)$/],
  ["GET", /^\/api\/power$/],
  ["POST", /^\/api\/power\/lid$/],
  ["GET", /^\/api\/license$/],
  ["GET", /^\/api\/license\/usage$/],
  ["GET", /^\/api\/usage$/],
  ["GET", /^\/api\/cloud$/],
  ["GET", /^\/api\/cloud\/billing$/],
  ["GET", /^\/api\/devices$/],
  ["GET", /^\/api\/logs$/],
  ["GET", /^\/api\/logs\/entries$/],
  // Connected apps: seen and revoked; a new key is made on the computer.
  ["GET", /^\/api\/connectors$/],
  ["DELETE", new RegExp(`^/api/connectors/${ID}$`)],
];

/**
 * Settings a phone may change, by section. Program paths, extra CLI flags, permission bypass, security, the server, the
 * phone listener and the cloud link stay on the computer.
 */
const SETTINGS: Record<string, string[]> = {
  general: ["userName", "desktopNotifications", "theme", "mode", "language", "timeFormat", "aiChatTitles", "aiNotificationSummaries"],
  runner: [
    "model",
    "fallbackModel",
    "effort",
    "ultracode",
    "runTimeoutMinutes",
    "autoContinueOnLimit",
    "resumeAfterRestart",
    "watchdog",
    "stallMinutes",
    "loopRepeats",
    "autoCompactPercent",
    "appendSystemPrompt",
    "accountAutoSwitch",
    "accountSwitchPercent",
  ],
  browser: ["enabled", "headless", "keepAliveMinutes", "liveView", "stealth", "muteAudio", "passkeys"],
  computer: ["enabled", "allowForeground", "agentCursor", "liveView", "liveViewFps", "screenshotMaxSize"],
  vm: ["enabled", "onQuit", "idleStopMinutes"],
  memory: ["autoCommit", "reflectAfterRun", "injectMemory", "dreaming"],
  maintenance: ["autoFix", "autoUpdate", "autoCleanup"],
  review: ["enabled", "cron", "model", "autoFix", "team"],
  // Not the OpenAI address (where the vault's key goes) nor Hex's program and model (a download).
  voice: ["enabled", "dictation", "sttProvider", "ttsProvider", "autoSpeak", "language", "sttModel", "ttsModel", "ttsVoice", "elevenlabsVoiceId", "browserVoice", "rate"],
  // The calls' persona and limits; numbers, the owner's phone, the PIN and inbound answering stay on the computer.
  phone: ["enabled", "callerName", "language", "maxMinutes", "quietFrom", "quietTo", "inboundGreeting"],
  activity: ["enabled"],
  artifacts: ["enabled"],
  integrations: ["enabled"],
  messaging: ["enabled"],
  plugins: ["enabled"],
  cards: ["enabled"],
  ssh: ["enabled"],
  sshKeys: ["enabled"],
  android: ["enabled"],
};

/**
 * Optional features a phone may switch off but only the computer switches on: each widens what agents reach — app
 * connections and keys, outside people messaging them, code that runs in every turn, payment cards, servers, ~/.ssh,
 * Android phones, VMs and phone calls. Activity and artifacts may also go back on from the phone.
 */
const ENABLED_ON_COMPUTER = new Set(["integrations", "messaging", "plugins", "cards", "ssh", "sshKeys", "android", "vm", "phone"]);

/** Switches of a section a phone may turn off but not on: auto review fixing things itself and settling the team's questions. */
const ON_AT_COMPUTER: Record<string, string[]> = { review: ["autoFix", "team"] };

/** What a phone may clean up: what Godmode removes by itself too. Trash, VM images and downloads go on the computer. */
export const PHONE_CLEANUP = [
  "temp-files",
  "browser-cache",
  "task-worktrees",
  "task-clones",
  "agent-scratch",
  "build-folders",
  "agent-run-logs",
  "agent-history",
  "deleted-files",
  "chat-pictures",
  "database",
  "old-logs",
];

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
  ["POST", /^\/api\/archive$/, ["kind", "id", "archived"]],
  // A chat's project, browser profile and instructions; never its folder, screen, VM, servers or phones.
  ["PATCH", new RegExp(`^/api/conversations/${ID}$`), ["title", "pinned", "archived", "model", "effort", "ultracode", "projectId", "browserProfileId", "instructions"]],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/pause$`), ["auto"]],
  ["POST", new RegExp(`^/api/conversations/${ID}/messages$`), ["content", "attachments", "queue", "queueId"]],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/queue/${ID}$`), ["content"]],
  ["POST", /^\/api\/chat$/, ["agentId", "content", "attachments", "workspaceId", "projectId", "model", "effort", "ultracode", "private", "browserProfileId", "instructions"]],
  // A task's repository and branch are picked on the computer: the phone never points an agent at another repository.
  ["POST", /^\/api\/tasks$/, ["workspaceId", "projectId", "title", "description", "type", "status", "agentId"]],
  ["PATCH", new RegExp(`^/api/tasks/${ID}$`), ["title", "description", "status", "agentId", "archived", "projectId", "priority", "dueDate", "labels", "goalId", "waitsFor", "blockedReason"]],
  ["POST", new RegExp(`^/api/tasks/${ID}/messages$`), ["content", "attachments"]],
  ["POST", new RegExp(`^/api/tasks/${ID}/approve$`), []],
  ["POST", /^\/api\/tasks\/tsk_[^/]+\/(push|pull-request)$/, []],
  ["PATCH", new RegExp(`^/api/conversations/${ID}/followup$`), ["dueAt"]],
  ["POST", new RegExp(`^/api/conversations/${ID}/followup/run$`), []],
  ["POST", /^\/api\/routines$/, ROUTINE_KEYS],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`), ROUTINE_KEYS],
  ["POST", /^\/api\/goals$/, GOAL_KEYS],
  ["PATCH", new RegExp(`^/api/goals/${ID}$`), GOAL_KEYS],
  ["POST", /^\/api\/conversations\/read$/, ["ids"]],
  ["POST", new RegExp(`^/api/agents/${ID}/heartbeat/beat$`), []],
  ["POST", new RegExp(`^/api/agents/${ID}/dreams$`), []],
  ["POST", new RegExp(`^/api/agents/${ID}/(pause|continue|duplicate)$`), []],
  ["POST", new RegExp(`^/api/agents/${ID}/run$`), ["prompt", "workspaceId"]],
  ["PUT", new RegExp(`^/api/agents/${ID}/file$`), ["path", "content", "create"]],
  ["POST", new RegExp(`^/api/team-templates/${ID}/install$`), ["workspaceId", "newWorkspace", "automations", "timezone", "skip"]],
  ["POST", new RegExp(`^/api/questions/${ID}/answer$`), ["optionId", "decision", "note", "text"]],
  ["POST", /^\/api\/human-tasks$/, ["title", "body", "url", "priority", "workspaceId", "status"]],
  ["PATCH", new RegExp(`^/api/human-tasks/${ID}$`), ["status", "beforeId", "priority", "title", "body"]],
  ["POST", new RegExp(`^/api/human-tasks/${ID}/close$`), ["outcome", "note", "optionId"]],
  ["POST", /^\/api\/notifications\/read$/, ["ids"]],
  ["POST", /^\/api\/offers\/ofr_[^/]+\/(accept|dismiss)$/, []],
  // A login is linked to a request on the computer, where the vault is.
  ["PATCH", new RegExp(`^/api/missing-logins/${ID}$`), ["status"]],
  ["POST", /^\/api\/artifacts\/start$/, ["prompt", "agentId", "workspaceId"]],
  ["PATCH", new RegExp(`^/api/artifacts/${ID}$`), ["title", "description", "pinned", "refreshPrompt"]],
  ["PUT", new RegExp(`^/api/artifacts/${ID}/data$`), ["data", "version"]],
  ["POST", new RegExp(`^/api/artifacts/${ID}/restore$`), ["version"]],
  ["POST", new RegExp(`^/api/artifacts/${ID}/message$`), ["content", "source"]],
  ["POST", new RegExp(`^/api/artifacts/${ID}/(refresh|review-done)$`), []],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/launch$`), []],
  ["POST", /^\/api\/computer\/input$/, ["view", "event", "frame"]],
  ["POST", new RegExp(`^/api/vms/${ID}/input$`), ["event", "frame"]],
  ["POST", new RegExp(`^/api/android/devices/${ID}/input$`), ["event", "frame"]],
  // What the desktop's New call sends: never the number it goes out from, a mailbox message or who it is for.
  ["POST", /^\/api\/calls$/, ["to", "goal", "context", "contactName", "language"]],
  ["POST", new RegExp(`^/api/vms/${ID}/(start|stop|suspend|restart)$`), []],
  ["POST", /^\/api\/vault\/lock$/, []],
  ["PATCH", new RegExp(`^/api/mods/${ID}$`), ["enabled"]],
  ["POST", new RegExp(`^/api/ssh/servers/${ID}/test$`), []],
  ["POST", /^\/api\/browser\/profiles$/, ["name"]],
  ["PATCH", new RegExp(`^/api/browser/profiles/${ID}$`), ["name", "isDefault"]],
  ["POST", new RegExp(`^/api/browser/profiles/${ID}/(stop|bot-check)$`), []],
  ["POST", /^\/api\/computer\/cua\/stop$/, []],
  ["POST", /^\/api\/reviews$/, []],
  ["POST", new RegExp(`^/api/reviews/${ID}/actions/\\d+/undo$`), []],
  ["POST", /^\/api\/memory\/import$/, ["source", "text"]],
  ["POST", /^\/api\/dreams\/all$/, []],
  ["POST", /^\/api\/claude-accounts\/refresh$/, []],
  ["POST", new RegExp(`^/api/claude-accounts/${ID}/default$`), []],
  ["POST", /^\/api\/cleanup$/, ["ids"]],
  ["POST", /^\/api\/optimize$/, []],
  ["POST", /^\/api\/power\/lid$/, ["enabled"]],
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
  // HEAD runs the GET route too: its status alone would tell whether a file is there.
  const reading = method === "GET" || method === "HEAD";
  if (reading && path === "/api/search" && query.get("notes") !== "0") return "Search agents' notes in Godmode on your computer.";
  const files = reading ? AGENT_FOLDER.exec(path) : null;
  // One path: the check and the route must read the same one.
  if (files) return query.getAll("path").length > 1 ? "Only files in the agent's folder open on the phone." : deviceFolderRefusal(files[1]!, query.get("path") ?? "");
  // Searching the full address or the holder would spell out what the list leaves out, one letter at a time.
  if (reading && (path === "/api/credentials" || path === "/api/cards") && query.has("search")) return "Search on the phone filters the list it has.";
  return null;
}

const AGENT_FOLDER = new RegExp(`^/api/agents/(${ID})/(file|files|files/raw)$`);

const NO_AGENT = "There is no such agent.";

/** The agent's folder, found as the routes find the agent: by id, else by slug. */
function agentRepo(idOrSlug: string): string | null {
  const row = get<{ repo_path: string }>("SELECT repo_path FROM agents WHERE id = ?", idOrSlug) ?? get<{ repo_path: string }>("SELECT repo_path FROM agents WHERE slug = ?", idOrSlug);
  return row?.repo_path ?? null;
}

/**
 * A phone reads inside the agent's folder only: nothing that tries to leave it, no .git, no file that usually holds keys
 * (mobile/views.ts), and no symlink on the way (one could lead to such a file under another name). The name on disk
 * decides, not the phone's spelling of it (case and Unicode variants open the same file on macOS). Also run by the
 * primary of a device group for what a secondary forwards from its phones (`x-godmode-phone`).
 */
export function deviceFolderRefusal(agentId: string, value: string): string | null {
  const refusal = phoneFilePathRefusal(value);
  if (refusal) return refusal;
  const repo = agentRepo(agentId);
  if (!repo) return NO_AGENT;
  const parts = value.split("/").filter((p) => p && p !== ".");
  const kept = "Open this file in Godmode on your computer.";
  for (let i = 1; i <= parts.length; i++) {
    let info: Stats;
    try {
      info = lstatSync(join(repo, ...parts.slice(0, i)));
    } catch {
      return null;
    }
    if (info.isSymbolicLink()) return kept;
  }
  try {
    const real = relative(realpathSync.native(repo), realpathSync.native(join(repo, ...parts))).split(sep);
    if (isMachineFolder(real[0] ?? "") || real.some((p) => p.toLowerCase() === ".git" || isSecretFileName(p))) return kept;
  } catch {
    return null;
  }
  return null;
}

const AGENT_FILES = new RegExp(`^/api/agents/(${ID})/files?$`);
const NOTES_ONLY = "From the phone you can open the agent's notes in memory/. Its other files stay on your computer.";

/**
 * A phone reaches an agent's notes and nothing else of its repository: the path has to stay under memory/ the way the
 * repository helpers resolve it, and no part of it may be a symlink (one could lead to CLAUDE.md or out of memory/).
 */
function notesPathRefusal(agentId: string, value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return NOTES_ONLY;
  const cleaned = value.replace(/\\/g, "/").trim();
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return NOTES_ONLY;
  const parts = cleaned.split("/").filter((p) => p && p !== ".");
  if (parts[0] !== "memory" || parts.includes("..")) return NOTES_ONLY;
  const repo = agentRepo(agentId);
  if (!repo) return NO_AGENT;
  for (let i = 1; i <= parts.length; i++) {
    let info: Stats;
    try {
      info = lstatSync(join(repo, ...parts.slice(0, i)));
    } catch {
      break;
    }
    if (info.isSymbolicLink()) return NOTES_ONLY;
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
  if (path === "/api/cleanup") return cleanupRefusal(body);
  if (method === "PATCH" && path.startsWith("/api/mods/")) return body.enabled === false ? null : "Switch plugins on in Godmode on your computer.";
  const file = method === "PUT" ? AGENT_FILES.exec(path) : null;
  if (file) return notesPathRefusal(file[1]!, body.path);
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
      if (!sameSettingShape(value, current[section]?.[key], NULLABLE_SETTINGS.has(`${section}.${key}`)) || !settingInRange(`${section}.${key}`, value)) return `Invalid value for ${section}.${key}.`;
      if (key === "enabled" && value === true && ENABLED_ON_COMPUTER.has(section) && current[section]?.enabled !== true) return "Turn this on in Godmode on your computer.";
      if (value === true && ON_AT_COMPUTER[section]?.includes(key) && current[section]?.[key] !== true) return "Turn this on in Godmode on your computer.";
      // Hex is a program and a model download: it is set up on the computer.
      if (section === "voice" && key === "sttProvider" && value === "hex" && current.voice?.sttProvider !== "hex") return "Set up Hex in Godmode on your computer.";
    }
  }
  return null;
}

function cleanupRefusal(body: Record<string, unknown>): string | null {
  const ids = body.ids;
  if (!Array.isArray(ids)) return null;
  return ids.every((id) => typeof id === "string" && PHONE_CLEANUP.includes(id)) ? null : "Clean this up in Godmode on your computer.";
}

const ANDROID_INPUT = new RegExp(`^/api/android/devices/(${ID})/input$`);

/** Why a phone may not control what the path names (null = it may): an Android phone only while a chat uses it. */
export function deviceTargetRefusal(method: string, path: string): string | null {
  const android = method === "POST" ? ANDROID_INPUT.exec(path) : null;
  if (android && !deviceMayUseAndroid(android[1]!)) return "Only Android phones a chat uses can be controlled from the phone.";
  return null;
}

/** Like a shared screen: an Android phone is the phone's to control while a chat (not archived) uses it. */
export function deviceMayUseAndroid(deviceId: string): boolean {
  return !!get<{ id: string }>("SELECT id FROM conversations WHERE archived = 0 AND EXISTS (SELECT 1 FROM json_each(android_device_ids) WHERE value = ?) LIMIT 1", deviceId);
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
