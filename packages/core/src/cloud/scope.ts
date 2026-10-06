/**
 * What a cloud user may do on this computer through Godmode Cloud (channel "cloud"). Every /api route is classified
 * here; a route in none of the lists is refused, so a new route stays closed to the cloud until someone decides
 * (test/cloud-scope.test.ts walks the app's routes).
 *
 * - "allowed": owners and operators. Viewers only read (GET/HEAD, and POST /api/conversations/:id/files).
 * - "secrets": only while `settings.cloud.allowSecrets` is on, and never for viewers.
 * - "owner": reads for the computer's owner only (cloud status and billing).
 * - refused: linking, sign-in, phone management, local-only actions and machine settings stay on the computer.
 *
 * Sign-in routes and phone pairing never reach `requireAuth`, so `hostGuard` refuses them with `cloudPathRefusal`.
 */
import type { CloudAccessRole } from "@godmode/shared";
import { getSettings } from "../services/settings";
import { deviceMayUseView } from "../mobile/scope";

type Decision = "allowed" | "secrets" | "owner" | { refused: string };
type Rule = Decision | ((body: Record<string, unknown>) => Decision);

const COMPUTER_ONLY = "This can only be done in Godmode on the computer itself, not through Godmode Cloud.";
const LINK_ONLY = "Linking and access switches are managed on the computer itself.";
const PHONES_ONLY = "Phones are paired and managed in Godmode on the computer itself.";
const SIGN_IN = "Signing in to this computer's own dashboard isn't available through Godmode Cloud.";
const SETTINGS_ONLY = "These settings can only be changed in Godmode on the computer itself.";
const OWNER_ONLY = "Only the owner of this computer can see this.";
const VIEWER = "You can look, but not change anything on this computer.";
const VIEWER_HIDDEN = "Viewers can't see this computer's screen or secrets.";
export const SECRETS_OFF = "Turned off for cloud access. Allow it on the computer under Settings → Cloud.";

const A: Rule = "allowed";
const S: Rule = "secrets";
const refused = (message: string): Rule => ({ refused: message });

/** Settings groups a cloud user may change. Machine, access and security settings stay on the computer; a new group is refused until it is added here. */
const CLOUD_SETTINGS_GROUPS = new Set(["general", "runner", "browser", "computer", "vm", "voice", "memory", "diagnostics", "onboardingComplete"]);

/** The voice provider's address is where the vault's OpenAI key is sent: pointing it elsewhere needs allowSecrets. */
const settingsGroups: Rule = (body) => {
  if (!Object.keys(body).every((k) => CLOUD_SETTINGS_GROUPS.has(k))) return { refused: SETTINGS_ONLY };
  const baseUrl = asObject(body.voice).openaiBaseUrl;
  return baseUrl !== undefined && baseUrl !== getSettings().voice.openaiBaseUrl ? "secrets" : "allowed";
};
/** What an agent may do (its permissions) widens what reaches secrets: that needs allowSecrets. */
const agentPermissions: Rule = (body) => (body.permissions !== undefined ? "secrets" : "allowed");
/** Testing a saved server sends its stored password or key to whatever host the body names. */
const sshTest: Rule = (body) => (body.id !== undefined ? "secrets" : "allowed");

const RULES: [methods: string, path: string, rule: Rule][] = [
  ["GET", "/api/health", A],
  ["GET", "/api/auth/status", A],
  ["POST", "/api/auth/login", refused(SIGN_IN)],
  ["POST", "/api/auth/token", refused(SIGN_IN)],
  ["POST", "/api/auth/logout", refused(SIGN_IN)],
  ["POST", "/api/auth/password", refused(SIGN_IN)],

  ["GET", "/api/bootstrap", A],
  ["GET", "/api/settings", A],
  ["PUT", "/api/settings", settingsGroups],
  ["GET|DELETE", "/api/notifications", A],
  ["POST", "/api/notifications/read", A],
  ["GET", "/api/audit", A],
  ["GET", "/api/doctor", A],
  ["GET", "/api/models", A],
  ["POST", "/api/doctor/install", A],
  ["GET|POST", "/api/doctor/claude-update", A],
  // Settings → System: reading the state is fine from anywhere; changing macOS permissions or the machine's tools
  // happens on the computer itself.
  ["GET", "/api/doctor/permissions", A],
  ["GET", "/api/doctor/updates", A],
  ["GET", "/api/doctor/maintenance", A],
  ["POST", "/api/doctor/permissions/fix", refused(COMPUTER_ONLY)],
  ["POST", "/api/doctor/fix", refused(COMPUTER_ONLY)],
  ["POST", "/api/doctor/updates", refused(COMPUTER_ONLY)],
  ["GET", "/api/cleanup", A],
  ["POST", "/api/cleanup", refused(COMPUTER_ONLY)],

  ["GET", "/api/vault/status", A],
  ["POST", "/api/vault/lock", A],
  ["POST", "/api/vault/setup", refused(COMPUTER_ONLY)],
  ["POST", "/api/vault/remember", refused(COMPUTER_ONLY)],
  ["POST", "/api/vault/unlock", S],
  ["POST", "/api/vault/passphrase", S],
  ["POST", "/api/vault/grant", S],
  ["GET", "/api/vault/secrets", S],
  ["PUT|DELETE", "/api/vault/secrets/:key", S],

  ["POST", "/api/credentials/import/preview", S],
  ["POST", "/api/credentials/import", S],
  ["GET", "/api/credentials", A],
  ["POST", "/api/credentials", S],
  ["GET|DELETE", "/api/credentials/:id", A],
  ["PATCH", "/api/credentials/:id", S],
  ["POST", "/api/credentials/:id/reveal", S],
  ["GET", "/api/totp", A],
  ["POST", "/api/totp", S],
  ["GET", "/api/totp/codes", S],
  ["POST", "/api/totp/import", S],
  ["PATCH", "/api/totp/:id", S],
  ["DELETE", "/api/totp/:id", A],

  ["GET|POST", "/api/workspaces", A],
  ["PATCH|DELETE", "/api/workspaces/:id", A],
  ["POST", "/api/workspaces/:id/sources/:sourceId/sync", A],
  ["GET", "/api/agents", A],
  ["POST", "/api/agents", agentPermissions],
  ["GET", "/api/agent-templates", A],
  ["GET", "/api/team-templates", A],
  ["POST", "/api/team-templates/:id/install", A],
  ["GET|DELETE", "/api/agents/:id", A],
  ["PATCH", "/api/agents/:id", agentPermissions],
  ["POST", "/api/agents/:id/run", agentPermissions],
  ["POST", "/api/agents/:id/duplicate", A],
  ["DELETE", "/api/agents/:id/failed-run", A],
  ["POST", "/api/agents/:id/pause", agentPermissions],
  ["POST", "/api/agents/:id/continue", agentPermissions],
  ["GET", "/api/agents/:id/commands", A],
  ["GET", "/api/agents/:id/files", A],
  ["GET|PUT", "/api/agents/:id/file", A],
  ["GET", "/api/agents/:id/commits", A],
  ["GET", "/api/agents/:id/dreams", A],
  ["POST", "/api/agents/:id/dreams", agentPermissions],
  ["GET", "/api/dreams/:id", A],
  ["POST", "/api/dreams/:id/revert", A],

  ["GET|POST", "/api/routines", A],
  ["PATCH|DELETE", "/api/routines/:id", A],
  ["POST", "/api/routines/:id/run", A],
  ["GET", "/api/routines/:id/events", A],
  ["POST", "/api/routines/:id/test-event", A],
  ["POST", "/api/routines/:id/webhook/rotate", A],
  ["GET", "/api/automation-events", A],

  ["GET|POST", "/api/conversations", A],
  ["GET|PATCH|DELETE", "/api/conversations/:id", A],
  ["POST", "/api/conversations/read", A],
  ["POST", "/api/conversations/:id/retry", A],
  ["GET", "/api/attention", A],
  ["GET", "/api/away", A],
  ["POST", "/api/conversations/:id/messages", A],
  ["PATCH|DELETE", "/api/conversations/:id/queue/:messageId", A],
  ["POST", "/api/conversations/:id/queue/send", A],
  ["POST|PATCH", "/api/conversations/:id/pause", A],
  ["POST", "/api/conversations/:id/continue", A],
  ["PATCH|DELETE", "/api/conversations/:id/followup", A],
  ["POST", "/api/conversations/:id/followup/run", A],
  ["POST", "/api/conversations/:id/files", A],
  ["GET", "/api/followups", A],
  ["POST", "/api/chat", A],
  ["GET", "/api/runs", A],
  ["GET", "/api/runs/:id", A],
  ["POST", "/api/runs/:id/cancel", A],
  ["GET", "/api/runs/:id/log", A],
  ["GET", "/api/missing-logins", A],
  ["PATCH", "/api/missing-logins/:id", A],
  ["GET", "/api/files/image", A],
  ["POST", "/api/files/reveal", refused(COMPUTER_ONLY)],

  ["GET", "/api/mcp-servers", A],
  ["POST", "/api/mcp-servers", S],
  ["PATCH", "/api/mcp-servers/:id", S],
  ["DELETE", "/api/mcp-servers/:id", A],
  ["POST", "/api/mcp-servers/:id/test", S],
  ["GET", "/api/api-tools", A],
  ["POST", "/api/api-tools", S],
  ["PATCH", "/api/api-tools/:id", S],
  ["DELETE", "/api/api-tools/:id", A],
  ["POST", "/api/api-tools/:id/test", S],
  ["GET", "/api/composio/status", A],
  ["PUT", "/api/composio/key", S],
  ["GET", "/api/composio/toolkits", A],
  ["GET", "/api/composio/connections", A],
  ["GET", "/api/composio/trigger-types", A],
  ["GET", "/api/composio/trigger-types/:slug", A],
  ["POST", "/api/composio/connect", A],
  ["POST", "/api/composio/connections/:id/refresh", A],
  ["DELETE", "/api/composio/connections/:id", A],
  ["GET", "/api/messaging", A],
  ["POST", "/api/messaging", S],
  ["POST", "/api/messaging/verify", S],
  ["GET", "/api/messaging/:id", A],
  ["PATCH|DELETE", "/api/messaging/:id", S],
  ["GET", "/api/messaging/:id/users", A],
  ["PATCH|DELETE", "/api/messaging/:id/users/:userId", S],
  ["GET", "/api/messaging/:id/chats", A],
  ["GET", "/api/messaging/:id/teams-app", A],

  ["GET|POST", "/api/browser/profiles", A],
  ["GET|PATCH|DELETE", "/api/browser/profiles/:id", A],
  ["POST", "/api/browser/profiles/:id/launch", A],
  ["POST", "/api/browser/profiles/:id/stop", A],
  ["POST", "/api/browser/profiles/:id/navigate", A],
  ["POST", "/api/browser/profiles/:id/bot-check", A],
  ["POST", "/api/browser/profiles/:id/input", A],
  ["POST", "/api/browser/profiles/:id/import", S],
  ["GET", "/api/browser/chrome-profiles", A],
  ["GET", "/api/browser/profile-use", A],
  ["POST", "/api/browser/profile-use/install", A],
  ["POST", "/api/browser/profile-use/sync", S],
  ["GET", "/api/computer/status", A],
  ["GET", "/api/computer/sources", A],
  ["GET", "/api/computer/thumbnail", A],
  ["POST", "/api/computer/permissions", refused(COMPUTER_ONLY)],
  ["POST", "/api/computer/cua/install", A],
  ["POST", "/api/computer/cua/stop", A],
  ["POST", "/api/computer/input", A],
  ["GET", "/api/vms/status", A],
  ["POST", "/api/vms/install", A],
  ["GET|POST", "/api/vms", A],
  ["DELETE", "/api/vms/images/:image", A],
  ["GET|PATCH|DELETE", "/api/vms/:id", A],
  ["POST", "/api/vms/:id/start", A],
  ["POST", "/api/vms/:id/stop", A],
  ["POST", "/api/vms/:id/suspend", A],
  ["POST", "/api/vms/:id/restart", A],
  ["POST", "/api/vms/:id/reset", A],
  ["POST", "/api/vms/:id/duplicate", A],
  ["POST", "/api/vms/:id/exec", A],
  ["POST", "/api/vms/:id/input", A],
  ["POST", "/api/vms/:id/assign", A],
  ["POST", "/api/vms/:id/open", refused(COMPUTER_ONLY)],
  ["GET", "/api/vms/:id/screenshot", A],

  ["GET|POST", "/api/tasks", A],
  ["GET|POST", "/api/goals", A],
  ["PATCH|DELETE", "/api/goals/:id", A],
  ["GET", "/api/tasks/:id/events", A],
  // Questions agents ask before they act: reading and answering them is ordinary use of the dashboard.
  // Runners: seeing them is fine from anywhere. Pairing, copying the setup (logins, 2FA, sessions) to them, fixing
  // and removing them, and the runner's own link API (/api/link/*, which includes running commands) stay on the
  // computer. The proxy to a runner (/api/runners/:id/proxy/…) matches no entry, so it is refused as well.
  ["GET", "/api/runners", A],
  ["GET", "/api/runners/:id", A],
  ["GET", "/api/runners/:id/health", A],
  ["POST", "/api/runners/:id/connect", A],
  ["POST|DELETE", "/api/runners/pairing", refused(COMPUTER_ONLY)],
  ["POST", "/api/runners", refused(COMPUTER_ONLY)],
  ["PATCH|DELETE", "/api/runners/:id", refused(COMPUTER_ONLY)],
  ["POST", "/api/runners/:id/sync", refused(COMPUTER_ONLY)],
  ["POST", "/api/runners/:id/health/fix", refused(COMPUTER_ONLY)],
  ["POST", "/api/runners/:id/autofix", refused(COMPUTER_ONLY)],
  ["GET", "/api/link/info", refused(COMPUTER_ONLY)],
  ["POST", "/api/link/sync", refused(COMPUTER_ONLY)],
  ["GET", "/api/link/health", refused(COMPUTER_ONLY)],
  ["POST", "/api/link/health/fix", refused(COMPUTER_ONLY)],
  ["GET|PUT", "/api/link/agents/:id/memory", refused(COMPUTER_ONLY)],
  ["POST", "/api/link/browser/:profileId/cookies", refused(COMPUTER_ONLY)],
  ["POST", "/api/link/exec", refused(COMPUTER_ONLY)],
  ["POST", "/api/link/forget", refused(COMPUTER_ONLY)],
  ["GET", "/api/questions", A],
  ["GET", "/api/questions/:id", A],
  ["POST", "/api/questions/:id/answer", A],
  ["POST", "/api/tasks/archive", A],
  ["POST", "/api/tasks/attachments", A],
  ["GET", "/api/tasks/attachments/:id/:name", A],
  ["GET|PATCH|DELETE", "/api/tasks/:id", A],
  ["POST", "/api/tasks/:id/messages", A],
  ["POST", "/api/tasks/:id/approve", A],
  ["POST", "/api/tasks/:id/push", A],
  ["POST", "/api/tasks/:id/pull-request", A],

  ["GET", "/api/ssh/servers", A],
  ["POST", "/api/ssh/servers", S],
  ["GET", "/api/ssh/servers/:id", A],
  ["PATCH|DELETE", "/api/ssh/servers/:id", S],
  ["POST", "/api/ssh/servers/:id/test", S],
  ["POST", "/api/ssh/servers/:id/exec", S],
  ["POST", "/api/ssh/servers/:id/assign", S],
  ["POST", "/api/ssh/test", sshTest],
  ["GET", "/api/ssh/local-keys", S],
  ["POST", "/api/ssh/keys", S],

  // A mod is code that runs inside every turn and reaches whatever the run reaches. Deleting one is a change like any
  // other: a guard that is gone restricts nothing.
  ["GET", "/api/mods", A],
  ["GET", "/api/mods/templates", A],
  ["POST", "/api/mods", S],
  ["POST", "/api/mods/check", S],
  ["POST", "/api/mods/import", refused(COMPUTER_ONLY)],
  ["GET", "/api/mods/:id", A],
  ["PATCH|DELETE", "/api/mods/:id", S],
  ["POST", "/api/mods/:id/check", A],

  ["POST", "/api/backup/export", S],
  ["POST", "/api/backup/import", S],
  ["POST", "/api/voice/transcribe", A],
  ["POST", "/api/voice/speak", A],
  ["GET", "/api/folders", A],
  ["GET", "/api/folders/recent", A],
  ["GET|DELETE", "/api/logs", A],
  ["GET", "/api/logs/entries", A],
  ["GET", "/api/logs/report", A],
  ["POST", "/api/logs/client", A],

  ["POST", "/api/mobile/pair", refused(PHONES_ONLY)],
  ["GET|PUT", "/api/mobile", refused(PHONES_ONLY)],
  ["POST|DELETE", "/api/mobile/pairing", refused(PHONES_ONLY)],
  ["PATCH|DELETE", "/api/mobile/devices/:id", refused(PHONES_ONLY)],
  ["GET|DELETE", "/api/mobile/me", refused(PHONES_ONLY)],

  // Keys for apps on this computer are made and taken away there.
  ["GET|POST", "/api/connectors", refused(COMPUTER_ONLY)],
  ["DELETE", "/api/connectors/:id", refused(COMPUTER_ONLY)],

  ["GET", "/api/cloud", "owner"],
  ["PUT", "/api/cloud", refused(LINK_ONLY)],
  ["POST|DELETE", "/api/cloud/link", refused(LINK_ONLY)],
  ["GET", "/api/cloud/billing", "owner"],
  ["POST", "/api/cloud/billing/cancel", refused(LINK_ONLY)],
  ["POST", "/api/cloud/billing/resume", refused(LINK_ONLY)],
  ["GET", "/api/usage", A],
  // The licence key is entered and removed on the computer; its owner may see the state and ask the server again.
  ["GET", "/api/license", "owner"],
  ["POST", "/api/license/refresh", "owner"],
  ["PUT|DELETE", "/api/license", refused(COMPUTER_ONLY)],
  // What the team spent and its monthly budgets; letting held work run is like continuing a paused chat.
  ["GET", "/api/spend", A],
  ["GET", "/api/budgets", A],
  ["POST", "/api/budgets/release", A],
];

/** Writes a viewer may make: resolving a chat's files changes nothing. */
const VIEWER_WRITES: [string, string][] = [["POST", "/api/conversations/:id/files"]];
/** Reads a viewer may not make: pictures of the screen, codes and keys. */
const VIEWER_HIDDEN_READS = ["/api/computer/thumbnail", "/api/computer/sources", "/api/vms/:id/screenshot", "/api/totp/codes", "/api/ssh/local-keys"];

function pattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

const COMPILED = RULES.map(([methods, path, rule]) => ({ methods: methods.split("|"), re: pattern(path), rule }));
const VIEWER_WRITES_RE = VIEWER_WRITES.map(([method, path]) => ({ method, re: pattern(path) }));
const VIEWER_HIDDEN_RE = VIEWER_HIDDEN_READS.map(pattern);

function ruleFor(method: string, path: string): Rule | null {
  const m = method === "HEAD" ? "GET" : method;
  return COMPILED.find((r) => r.methods.includes(m) && r.re.test(path))?.rule ?? null;
}

/** Is this route (a concrete path or a route pattern like `/api/agents/:id`) in one of the lists? */
export function isCloudRouteClassified(method: string, path: string): boolean {
  return ruleFor(method, path) !== null;
}

/** Sign-in and pairing routes skip `requireAuth`; `hostGuard` refuses them on the cloud channel with this. */
export function cloudPathRefusal(method: string, path: string): string | null {
  if (path.startsWith("/api/auth/")) return (method === "GET" || method === "HEAD") && path === "/api/auth/status" ? null : SIGN_IN;
  if (path === "/api/mobile/pair") return PHONES_ONLY;
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Why a cloud user may not make this request (null = they may). `readBody` is only called for routes with body rules. */
export async function cloudRefusal(method: string, path: string, role: CloudAccessRole, readBody: () => Promise<unknown>): Promise<string | null> {
  const m = method === "HEAD" ? "GET" : method;
  const rule = ruleFor(m, path);
  if (!rule) return COMPUTER_ONLY;
  const viewer = role === "viewer";
  if (viewer) {
    if (m !== "GET" && !VIEWER_WRITES_RE.some((w) => w.method === m && w.re.test(path))) return VIEWER;
    if (VIEWER_HIDDEN_RE.some((re) => re.test(path))) return VIEWER_HIDDEN;
  }
  const decision = typeof rule === "function" ? rule(asObject(await readBody().catch(() => null))) : rule;
  if (typeof decision === "object") return decision.refused;
  if (decision === "owner") return role === "owner" ? null : OWNER_ONLY;
  if (decision === "secrets") {
    if (viewer) return VIEWER_HIDDEN;
    return getSettings().cloud.allowSecrets ? null : SECRETS_OFF;
  }
  return null;
}

/**
 * Messages a viewer's relayed socket may send: keep-alive, following chats, passive browser views and computer views
 * that are shared in a chat. Unsubscribing is always allowed.
 */
export function viewerMaySend(raw: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return false;
  }
  const m = asObject(msg);
  switch (m.type) {
    case "ping":
    case "conversation.subscribe":
    case "conversation.unsubscribe":
    case "browser.unsubscribe":
    case "computer.unsubscribe":
    // Delivery preferences of the live chat view; both only read.
    case "deltas.patch":
    case "run.resync":
      return true;
    case "browser.subscribe":
      return m.passive === true;
    case "computer.subscribe":
      return typeof m.view === "string" && deviceMayUseView(m.view);
    default:
      return false;
  }
}
