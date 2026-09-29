/**
 * Core domain models shared between the Godmode core daemon and the UI.
 *
 * Scoping rules:
 *  - `workspaceId: null` means the item is GLOBAL (visible to every workspace).
 *  - An item with a `workspaceId` is only visible to agents inside that workspace.
 *  - Some items (MCP servers, Composio connections, credentials) can additionally be
 *    pinned to a single agent via `agentId`.
 */
import type { AgentComputerConfig, ComputerTarget } from "./computer";

export type ID = string;
export type ISODate = string;

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: ID;
  name: string;
  slug: string;
  description: string;
  color: string; // tailwind-ish color token e.g. "violet" | hex
  icon: string; // emoji or lucide icon name
  /** Agent context: standing instructions for every agent in this workspace, on every run. */
  instructions: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Agents (a.k.a. Bots)                                                */
/* ------------------------------------------------------------------ */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentStatus = "idle" | "running" | "error" | "disabled";
export type SecretAccessMode = "fill" | "reveal";

export interface SubagentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
}

export interface AgentPermissions {
  /** Agent may create/update/delete other agents and routines (the "Godmode" orchestrator). */
  canManageAgents: boolean;
  /** Agent may delegate tasks to peer agents. */
  allowDelegation: boolean;
  /** Peer agent ids this agent may delegate to. Empty = any agent in reach. */
  delegateTo: ID[];
  /**
   * How the agent gets secrets:
   *  - "fill": secrets are typed straight into the browser by Godmode, the model never sees them (default, safest)
   *  - "reveal": the model may read raw usernames/passwords/TOTP codes
   */
  secretAccess: SecretAccessMode;
  /** Credential ids the agent may use. `null` = every credential in its scope (global + workspace). */
  credentialIds: ID[] | null;
  /** TOTP ids the agent may use. `null` = every TOTP in its scope. */
  totpIds: ID[] | null;
  /** Hard cost cap per run in USD (passed to claude --max-budget-usd). null = unlimited */
  maxBudgetUsd: number | null;
}

export interface AgentBrowserConfig {
  /** Browser profile to use. null = the workspace/global default profile. */
  profileId: ID | null;
  /** Enable browser tools for this agent at all. */
  enabled: boolean;
  headless: boolean | null; // null = use global setting
}

export interface Agent {
  id: ID;
  workspaceId: ID | null;
  name: string;
  slug: string;
  /** Emoji avatar */
  avatar: string;
  color: string;
  description: string;
  /** The agent's role / standing instructions (goes into its CLAUDE.md). */
  instructions: string;
  /** Claude model id or alias. Empty string = use global default. */
  model: string;
  effort: Effort | null;
  /** The built-in main assistant ("Godmode"). Cannot be deleted. */
  isDefault: boolean;
  enabled: boolean;
  status: AgentStatus;
  permissions: AgentPermissions;
  browser: AgentBrowserConfig;
  /** Computer use without a screen shared in the chat (routines, delegated tasks). */
  computer: AgentComputerConfig;
  /** MCP server ids (custom + composio) explicitly attached to this agent (in addition to scope-inherited ones). */
  mcpServerIds: ID[];
  /** Whether to inherit global/workspace MCP servers. */
  inheritMcp: boolean;
  subagents: SubagentDefinition[];
  /** Folder the agent works in by default (Claude's cwd). null = its own repository. */
  workingDirectory: string | null;
  /** Absolute path of the agent's git repository. */
  repoPath: string;
  lastRunAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Routines = automations: a prompt an agent runs when its trigger fires */
/* ------------------------------------------------------------------ */

/**
 * What starts an automation:
 *  - `schedule`: the cron expression fires.
 *  - `app`: an event in a connected app (Composio trigger: new email, Slack message, Notion update…).
 *  - `condition`: the agent checks a condition in plain language on the cron schedule and acts once it holds.
 *  - `webhook`: an HTTP POST to the automation's secret URL.
 */
export type RoutineTriggerType = "schedule" | "app" | "condition" | "webhook";

export type RoutineTrigger =
  | { type: "schedule" }
  | {
      type: "app";
      /** Godmode Composio connection (`ComposioConnection.id`) whose account is watched. */
      connectionId: ID;
      /** Composio toolkit slug, e.g. "gmail". */
      toolkit: string;
      /** Composio trigger type slug, e.g. "GMAIL_NEW_GMAIL_MESSAGE". */
      triggerSlug: string;
      /** Display name of the trigger type, e.g. "New Gmail message". */
      triggerName: string;
      /** Trigger configuration (fields of the trigger type's config schema). */
      config: Record<string, unknown>;
    }
  | {
      type: "condition";
      /** Plain-language condition, e.g. "a competitor changes their pricing page". */
      condition: string;
      /** Model for the periodic checks; null = the agent's model. */
      checkModel: string | null;
    }
  | { type: "webhook" };

/** Health of the trigger (listening for app events, last check, webhook calls…). */
export interface RoutineTriggerStatus {
  state: "ok" | "pending" | "error" | "off";
  /** Why it is pending / failing, human readable. */
  message: string | null;
  /** Last time the trigger fired (event received, condition met). */
  lastEventAt: ISODate | null;
  /** Condition triggers: last check and what the agent observed then. */
  lastCheckAt: ISODate | null;
  observation: string | null;
}

export interface Routine {
  id: ID;
  agentId: ID;
  name: string;
  trigger: RoutineTrigger;
  /** Cron expression (5 or 6 fields): the schedule, or how often a condition is checked. "" for app/webhook triggers. */
  cron: string;
  timezone: string;
  prompt: string;
  /** Event triggers (app, webhook): only act on events that match this, in plain language. "" = every event. */
  filter: string;
  enabled: boolean;
  /** Keep a single conversation for every run of this routine (continuity) vs. new conversation per run. */
  reuseConversation: boolean;
  conversationId: ID | null;
  lastRunAt: ISODate | null;
  /** Next scheduled run (schedule) or check (condition). */
  nextRunAt: ISODate | null;
  lastStatus: RunStatus | null;
  triggerStatus: RoutineTriggerStatus;
  /**
   * Webhook triggers: the secret path to POST to, e.g. "/hooks/whk_…" (relative to the core's address).
   * null for other triggers, and while the vault is locked (the token is stored encrypted).
   */
  webhookPath: string | null;
  /** Events waiting for the automation to finish its current run. */
  pendingEvents: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** schedule: the cron fired · app / webhook: an event arrived · condition: a check found the condition met · manual: Run now / test event. */
export type AutomationEventSource = "schedule" | "app" | "webhook" | "condition" | "manual";
/**
 * pending: waiting for the automation's current run · running: handed to a run · done / failed: that run's outcome ·
 * skipped: not run (automation paused, duplicate, dropped from a full queue).
 */
export type AutomationEventStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** Something that happened and started (or will start) an automation. */
export interface AutomationEvent {
  id: ID;
  routineId: ID;
  source: AutomationEventSource;
  /** One line, e.g. "New Gmail message · Invoice #1042 from ACME". */
  title: string;
  /** Event data as received (JSON, truncated). Untrusted. */
  payload: unknown;
  status: AutomationEventStatus;
  runId: ID | null;
  /** Why it was skipped or failed. */
  note: string | null;
  createdAt: ISODate;
}

/** A Composio trigger type (event a connected app can emit). */
export interface ComposioTriggerType {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  toolkit: string;
  toolkitLogo: string | null;
  /** "poll" triggers are checked by Composio every few minutes; "webhook" ones arrive instantly. */
  kind: "poll" | "webhook" | null;
  /** JSON schema of the trigger configuration. */
  config: Record<string, unknown>;
  /** Setup in the upstream app is needed before events arrive (e.g. a Slack/Notion webhook subscription). */
  requiresWebhookSetup: boolean;
}

/* ------------------------------------------------------------------ */
/* Conversations, messages, runs                                        */
/* ------------------------------------------------------------------ */

export type ConversationOrigin = "chat" | "routine" | "delegation" | "api";

export interface Conversation {
  id: ID;
  agentId: ID;
  title: string;
  origin: ConversationOrigin;
  /** Claude CLI session id used with --resume. */
  claudeSessionId: string | null;
  /** Per-chat override from the model picker or /model. null = the agent's model. */
  model: string | null;
  /** Per-chat override from the effort control or /effort. null = the agent's effort. */
  effort: Effort | null;
  /** Folder this conversation works in, overriding the agent's. null = the agent's default. */
  workingDirectory: string | null;
  /** What the human shared with the agent in this chat (screen, window or browser tab). null = nothing. */
  computerTarget: ComputerTarget | null;
  /** Standing instructions for this chat only; they take precedence over the agent's, workspace and global ones. */
  instructions: string;
  pinned: boolean;
  archived: boolean;
  lastMessageAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Denormalized for lists */
  preview?: string;
  running?: boolean;
}

export type MessageRole = "user" | "assistant" | "system";

/** Structured content blocks for rich rendering of assistant turns. */
export type MessageBlock =
  | {
      type: "text";
      text: string;
      /** Set when the text was produced by a subagent (Task tool) — nest it under that tool_use block. */
      parentToolUseId?: string | null;
    }
  | {
      type: "thinking";
      /** May be empty when the model's thinking is redacted — still shown as a "thinking" indicator. */
      text: string;
      parentToolUseId?: string | null;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      /** Filled when the matching tool_result arrives. */
      result?: string;
      isError?: boolean;
      /** Optional base64 image result (e.g. browser screenshot). */
      image?: string;
      parentToolUseId?: string | null;
    }
  | { type: "error"; text: string }
  | { type: "notice"; level: "info" | "warning" | "success"; text: string }
  /** Output of a Claude Code slash command that ran locally (e.g. /context, /usage, /model). */
  | { type: "command"; name: string; args: string; output: string };

/** A slash command offered by the installed Claude Code CLI for an agent. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  /** Shipped with Claude Code (false = project command or skill in the agent repo). */
  builtin: boolean;
}

export interface Attachment {
  name: string;
  mime: string;
  /** Path inside the agent repo (attachments/…) */
  path: string;
  size: number;
}

export interface Message {
  id: ID;
  conversationId: ID;
  role: MessageRole;
  /** Plain-text version (final text for assistant). */
  content: string;
  blocks: MessageBlock[];
  runId: ID | null;
  attachments: Attachment[];
  createdAt: ISODate;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** `routine`: an automation ran (schedule, app event, condition met, webhook) · `check`: an automation checked its condition. */
export type RunTrigger = "chat" | "routine" | "check" | "delegation" | "manual" | "api";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Run {
  id: ID;
  agentId: ID;
  conversationId: ID;
  routineId: ID | null;
  parentRunId: ID | null;
  trigger: RunTrigger;
  status: RunStatus;
  prompt: string;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: RunUsage | null;
  model: string | null;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
  createdAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Vault: credentials (logins) and TOTP (2FA)                          */
/* ------------------------------------------------------------------ */

export interface Credential {
  id: ID;
  workspaceId: ID | null;
  name: string;
  /** Primary login URL */
  url: string;
  /** Domains this login applies to, e.g. ["github.com"] */
  domains: string[];
  username: string;
  /** Present only when explicitly revealed */
  password?: string;
  hasPassword: boolean;
  notes?: string;
  /** Linked TOTP entry */
  totpId: ID | null;
  tags: string[];
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpEntry {
  id: ID;
  workspaceId: ID | null;
  issuer: string;
  accountName: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  credentialId: ID | null;
  icon: string | null;
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface TotpCode {
  id: ID;
  code: string;
  /** seconds remaining in the current period */
  remaining: number;
  period: number;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  /** DEK stored in OS keychain for auto-unlock */
  rememberDevice: boolean;
  autoLockMinutes: number;
}

/* ------------------------------------------------------------------ */
/* Missing logins                                                       */
/* ------------------------------------------------------------------ */

export type MissingLoginStatus = "open" | "resolved" | "dismissed";
export type MissingLoginKind = "missing_credential" | "invalid_credential" | "missing_totp" | "missing_account" | "other";

export interface MissingLogin {
  id: ID;
  agentId: ID | null;
  runId: ID | null;
  workspaceId: ID | null;
  kind: MissingLoginKind;
  service: string;
  url: string;
  reason: string;
  status: MissingLoginStatus;
  credentialId: ID | null;
  occurrences: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Integrations: MCP servers + Composio                                 */
/* ------------------------------------------------------------------ */

export type McpTransport = "stdio" | "http" | "sse";
export type McpSource = "custom" | "composio";

export interface McpServer {
  id: ID;
  workspaceId: ID | null;
  /** Pinned to a single agent (optional) */
  agentId: ID | null;
  name: string;
  description: string;
  source: McpSource;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  /** Names only; values are encrypted server side. */
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  /** For composio servers */
  composio?: { toolkits: string[]; userId: string } | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface McpServerInput {
  workspaceId: ID | null;
  agentId: ID | null;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Plain values; a value of "********" keeps the stored one. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  logo: string | null;
  description: string;
  categories: string[];
  authSchemes: string[];
  noAuth: boolean;
}

export interface ComposioConnection {
  id: ID;
  /** Composio connected account id */
  connectedAccountId: string;
  toolkit: string;
  workspaceId: ID | null;
  agentId: ID | null;
  userId: string;
  status: string;
  createdAt: ISODate;
}

export interface ComposioStatus {
  configured: boolean;
  valid: boolean | null;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Browser                                                              */
/* ------------------------------------------------------------------ */

export interface BrowserProfile {
  id: ID;
  workspaceId: ID | null;
  name: string;
  /** Directory of the Chromium user-data-dir managed by Godmode */
  userDataDir: string;
  isDefault: boolean;
  /** Source of last cookie import e.g. "Chrome — Profile 1" */
  importedFrom: string | null;
  importedAt: ISODate | null;
  cookieCount: number;
  running: boolean;
  cdpUrl: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface LocalChromeProfile {
  browser: string; // "Google Chrome", "Chromium", "Microsoft Edge", "Brave"
  profileDir: string; // "Default", "Profile 1"
  name: string;
  email: string | null;
  path: string;
}

/* ------------------------------------------------------------------ */
/* Notifications, audit, settings                                       */
/* ------------------------------------------------------------------ */

export type NotificationKind = "info" | "success" | "warning" | "error" | "missing_login" | "run";

export interface AppNotification {
  id: ID;
  kind: NotificationKind;
  title: string;
  body: string;
  /** In-app route, e.g. /agents/abc */
  link: string | null;
  read: boolean;
  createdAt: ISODate;
}

export interface AuditEntry {
  id: ID;
  ts: ISODate;
  actor: string; // "user" | "agent:<id>" | "system"
  action: string; // e.g. "credential.fill", "credential.reveal", "vault.unlock"
  target: string | null;
  details: Record<string, unknown>;
}

export interface GeneralSettings {
  theme: "dark" | "light" | "system";
  accent: string;
  /** User display name for greetings */
  userName: string;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  desktopNotifications: boolean;
  language: string;
}

export interface RunnerSettings {
  /** Path to claude CLI; empty = auto-detect */
  claudePath: string;
  model: string;
  fallbackModel: string;
  effort: Effort;
  /** --dangerously-skip-permissions (full bypass). */
  bypassPermissions: boolean;
  maxConcurrentRuns: number;
  /** Timeout per run in minutes */
  runTimeoutMinutes: number;
  defaultMaxBudgetUsd: number | null;
  extraArgs: string[];
  /** Global instructions: included in every run of every agent. */
  appendSystemPrompt: string;
}

export interface BrowserSettings {
  enabled: boolean;
  /** Path to Chrome/Chromium; empty = auto-detect */
  chromePath: string;
  headless: boolean;
  /** browser-use MCP command; empty = default uvx command */
  browserUseCommand: string;
  keepAliveMinutes: number;
  liveView: boolean;
}

export interface ComputerSettings {
  /** Agents may see and control the computer when a screen, window or tab is shared with them. */
  enabled: boolean;
  /** Use Cua Driver (trycua/cua) for background control of single windows. Off = Godmode's built-in helper (macOS). */
  useCuaDriver: boolean;
  /** Custom cua-driver command; empty = the pinned version via uvx. */
  cuaDriverCommand: string;
  /** A shared window may be brought to the front briefly when a background action doesn't land. */
  allowForeground: boolean;
  /** Show Cua Driver's agent cursor on the window an agent controls. */
  agentCursor: boolean;
  /** Stream what agents see while you watch. */
  liveView: boolean;
  /** Live view frames per second (1–10). */
  liveViewFps: number;
  /** Long edge of screenshots sent to the model, in pixels (the model sees at most ~1.15 megapixels). */
  screenshotMaxSize: number;
}

export type SttProvider = "browser" | "openai";
export type TtsProvider = "browser" | "openai" | "elevenlabs";

export interface VoiceSettings {
  enabled: boolean;
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  /** Auto-speak assistant replies when message was dictated */
  autoSpeak: boolean;
  language: string;
  openaiBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  elevenlabsVoiceId: string;
  /** Web speech voice name */
  browserVoice: string;
  rate: number;
}

export interface SecuritySettings {
  autoLockMinutes: number;
  /** Default secret access for new agents */
  defaultSecretAccess: SecretAccessMode;
  /** Redact known secret values from transcripts and logs */
  redactSecrets: boolean;
  /** Load website icons for logins from Google's favicon service (reveals the domains to Google). */
  fetchSiteIcons: boolean;
  /** Require confirmation in UI before an agent reveals a secret */
  auditRetentionDays: number;
}

export interface ServerSettings {
  host: string;
  port: number;
  /** Allow remote dashboard access (binding to non-loopback host) */
  remoteAccess: boolean;
  /** Password hash for dashboard login (never sent to UI) */
  hasDashboardPassword: boolean;
  allowedOrigins: string[];
}

export interface MemorySettings {
  /** "files" = MEMORY.md in agent repo (default); "claude-mem" = thedotmack/claude-mem plugin */
  backend: "files" | "claude-mem";
  autoCommit: boolean;
  /** Summarize and store learnings after each run */
  reflectAfterRun: boolean;
}

export interface Settings {
  general: GeneralSettings;
  runner: RunnerSettings;
  browser: BrowserSettings;
  computer: ComputerSettings;
  voice: VoiceSettings;
  security: SecuritySettings;
  server: ServerSettings;
  memory: MemorySettings;
  onboardingComplete: boolean;
}

/* ------------------------------------------------------------------ */
/* Models (as offered by the installed Claude Code CLI)                 */
/* ------------------------------------------------------------------ */

export interface ClaudeModel {
  /** Value for `claude --model`: an alias ("opus") or a full model id. */
  id: string;
  /** Model id the value currently resolves to, e.g. "claude-opus-5-5". */
  resolvedModel: string;
  label: string;
  description: string;
  /** Effort levels the model accepts, low → high. Empty = no effort control. */
  efforts: Effort[];
  /** Newest model of its family; the others are older versions. */
  latest: boolean;
}

export interface ModelCatalog {
  models: ClaudeModel[];
  /** "claude" = reported by the installed Claude Code CLI, "builtin" = static list (CLI missing or unreachable). */
  source: "claude" | "builtin";
  claudeVersion: string | null;
  fetchedAt: ISODate;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Doctor (dependency checks)                                           */
/* ------------------------------------------------------------------ */

export type DependencyId = "claude" | "claude-auth" | "uv" | "browser-use" | "chrome" | "git" | "claude-mem" | "cua-driver";

export interface DependencyStatus {
  id: DependencyId;
  name: string;
  ok: boolean;
  version: string | null;
  path: string | null;
  detail: string;
  required: boolean;
  installable: boolean;
  installHint: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  checkedAt: ISODate;
  dependencies: DependencyStatus[];
}

/** Claude Code's release channel (`autoUpdatesChannel` in ~/.claude/settings.json). */
export type ClaudeReleaseChannel = "latest" | "stable";

export interface ClaudeUpdateStatus {
  current: string | null;
  latest: string | null;
  channel: ClaudeReleaseChannel;
  updateAvailable: boolean;
  checkedAt: ISODate;
}

export interface ClaudeUpdateResult {
  ok: boolean;
  previous: string | null;
  version: string | null;
  output: string;
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                            */
/* ------------------------------------------------------------------ */

export interface Bootstrap {
  version: string;
  mode: "desktop" | "server";
  dataDir: string;
  /** Home directory of the machine running the core (paths in the UI are shown relative to it). */
  homeDir: string;
  platform: string;
  vault: VaultStatus;
  settings: Settings;
  defaultAgentId: ID | null;
  counts: {
    agents: number;
    workspaces: number;
    credentials: number;
    totp: number;
    openMissingLogins: number;
    runningRuns: number;
    unreadNotifications: number;
  };
}
