import type { SpendKind } from "./budget";
import type { AgentCharacter } from "./character";
import type { AgentComputerConfig, ComputerTarget } from "./computer";
import type {
  RoutineNotify,
  Agent,
  AgentBrowserConfig,
  AgentPermissions,
  AgentQuestion,
  Attachment,
  Conversation,
  Credential,
  Effort,
  ID,
  ISODate,
  Message,
  MissingLoginStatus,
  QueuedMessage,
  Routine,
  RoutineTrigger,
  Run,
  SubagentDefinition,
  TotpAlgorithm,
  TotpEntry,
  Workspace,
} from "./models";

/** Standard error body returned by the API with non-2xx status codes. */
export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export interface WorkspaceInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  instructions?: string;
  /** macOS VM for the workspace's agents; null = none. */
  vmId?: ID | null;
  /** Browser profile for the workspace's agents, moved into the workspace if needed; null = the global default. */
  browserProfileId?: ID | null;
  /** Every attached folder and repository, in order. One naming an existing source keeps it (and its clone). */
  sources?: WorkspaceSourceInput[];
}

export type WorkspaceSourceInput = { kind: "folder"; path: string } | { kind: "git"; url: string; branch?: string | null };

export interface AgentInput {
  workspaceId?: ID | null;
  name: string;
  avatar?: string;
  color?: string;
  /** Missing or unknown parts keep their current (or default) value. */
  character?: Partial<AgentCharacter>;
  /** PERSONALITY_PRESETS id or free text; "" = none. */
  personality?: string;
  description?: string;
  instructions?: string;
  /** Job title on the team; "" = none. */
  role?: string;
  /** Its lead; null = the built-in agent. */
  reportsTo?: ID | null;
  model?: string;
  effort?: Effort | null;
  /** null = the global default. */
  ultracode?: boolean | null;
  enabled?: boolean;
  permissions?: Partial<AgentPermissions>;
  browser?: Partial<AgentBrowserConfig>;
  computer?: Partial<AgentComputerConfig>;
  mcpServerIds?: ID[];
  inheritMcp?: boolean;
  subagents?: SubagentDefinition[];
  workingDirectory?: string | null;
  /** macOS VM the agent works in; null = the workspace's. */
  vmId?: ID | null;
  /** SSH servers the agent may use in every run. */
  sshServerIds?: ID[];
}

export interface AgentTemplate {
  id: string;
  name: string;
  avatar: string;
  color: string;
  character: AgentCharacter;
  personality: string;
  description: string;
  instructions: string;
  /** Its job title on the team. */
  role: string;
  routine?: { name: string; cron: string; prompt: string };
}

export interface RoutineInput {
  agentId: ID;
  name: string;
  /** Default: `{ type: "schedule" }`. */
  trigger?: RoutineTrigger;
  /** Required for schedule and condition triggers (for conditions: how often to check); ignored otherwise. */
  cron?: string;
  timezone?: string;
  prompt: string;
  /** App/webhook triggers: only act on matching events (plain language). */
  filter?: string;
  enabled?: boolean;
  reuseConversation?: boolean;
  notify?: RoutineNotify;
}

export interface WebhookRotateResult {
  /** The new secret path; the old one stops working. */
  webhookPath: string;
}

export interface TestEventInput {
  /** Sample event data; default: a small example. */
  payload?: unknown;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
  activeRunId: ID | null;
  /** Messages waiting for the agent, oldest first. */
  queue: QueuedMessage[];
}

export interface SendMessageInput {
  content: string;
  /** Uploaded attachments (base64) */
  attachments?: { name: string; mime: string; data: string }[];
  /** Voice-originated message (auto speak reply) */
  voice?: boolean;
  /** While the agent works in this chat, put the message in the chat's queue instead of starting a run of its own. */
  queue?: boolean;
  /** Id of the queued message, chosen by the client so the queue can show it before the answer arrives. */
  queueId?: ID;
}

export interface SendMessageResult {
  message: Message;
  run: Run;
  /**
   * The chat was waiting for the human's answer, so the message was taken as that answer: no message was added, `run` is
   * the run that asked (it continues) and `message` is the agent's message that shows the question.
   */
  question?: AgentQuestion;
}

/**
 * The human's answer to an AgentQuestion. Exactly one of `optionId` (questions: a suggested answer), `decision`
 * (approvals; `note` optional) or `text` (own words, for both kinds; may be "" when files are attached).
 */
export interface AnswerQuestionInput {
  optionId?: string;
  decision?: "approve" | "decline";
  /** A sentence for the agent that goes with the decision. */
  note?: string;
  text?: string;
  /** Files that go with `text`. */
  attachments?: SendMessageInput["attachments"];
}

/** `run` is the run that asked: it continues with the answer. */
export interface AnswerQuestionResult {
  question: AgentQuestion;
  run: Run;
}

/** `queued`: the agent was working, so the message waits in the chat's queue. */
export type SendMessageOutcome = SendMessageResult | { queued: QueuedMessage };

export interface StartChatInput {
  agentId?: ID;
  content: string;
  attachments?: SendMessageInput["attachments"];
  voice?: boolean;
  /** Model for this chat; omitted = the agent's. */
  model?: string | null;
  effort?: Effort | null;
  ultracode?: boolean | null;
  /** Work in this folder instead of the agent's default. */
  workingDirectory?: string | null;
  /** Share a screen, window or browser tab with the new chat. */
  computerTarget?: ComputerTarget | null;
  /** Work in this macOS VM instead of the agent's. */
  vmId?: ID | null;
  /** Browse in this profile instead of the agent's. */
  browserProfileId?: ID | null;
  /** Workspace selected in the sidebar: a global agent browses with its default profile. */
  workspaceId?: ID | null;
  /** SSH servers the chat may use, in addition to the agent's. */
  sshServerIds?: ID[];
  instructions?: string;
  /** Work on this runner instead of this computer. */
  runnerId?: ID | null;
}

/** Move a chat's follow-up to another time. */
export interface FollowupPatch {
  dueAt: ISODate;
}

export interface ConversationPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  /** null = back to the agent's model / effort / Ultracode. */
  model?: string | null;
  effort?: Effort | null;
  ultracode?: boolean | null;
  /** null = back to the agent's default folder. */
  workingDirectory?: string | null;
  /** Share a screen, window or browser tab with the agent; null = stop sharing. */
  computerTarget?: ComputerTarget | null;
  /** macOS VM for this chat; null = back to the agent's (or workspace's). */
  vmId?: ID | null;
  /** Browser profile for this chat; null = back to the agent's (or the default). */
  browserProfileId?: ID | null;
  /** SSH servers of this chat (the whole list); the agent's servers apply anyway. */
  sshServerIds?: ID[];
  /** "" = none. */
  instructions?: string;
}

export interface StartChatResult extends SendMessageResult {
  conversation: Conversation;
}

export interface CredentialInput {
  workspaceId?: ID | null;
  name: string;
  url?: string;
  domains?: string[];
  username?: string;
  /** undefined = keep existing */
  password?: string;
  notes?: string;
  totpId?: ID | null;
  tags?: string[];
}

export interface TotpInput {
  workspaceId?: ID | null;
  issuer: string;
  accountName?: string;
  /** base32 secret */
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
  credentialId?: ID | null;
}

export interface TotpImportInput {
  workspaceId?: ID | null;
  /** otpauth:// or otpauth-migration:// URIs decoded from QR codes in the UI */
  uris: string[];
}

export interface TotpImportResult {
  imported: TotpEntry[];
  /** `label` ("Issuer:account") identifies the account when known, e.g. one entry of a multi-account migration export. */
  skipped: { uri: string; reason: string; label?: string }[];
}

/** Password manager a login export came from, detected from its format and columns. */
export type PasswordImportSource =
  | "chrome"
  | "1password"
  | "bitwarden"
  | "apple"
  | "firefox"
  | "lastpass"
  | "dashlane"
  | "protonpass"
  | "keepass"
  | "csv";

export type PasswordImportAction = "new" | "update" | "unchanged";

/** One login of an export, after merging rows for the same site + username + password. Never carries secrets. */
export interface PasswordImportRow {
  id: number;
  name: string;
  url: string;
  domains: string[];
  username: string;
  action: PasswordImportAction;
  /** The saved login this row updates or already equals */
  existingId: ID | null;
  existingName: string | null;
  /** What an update changes: "password", "username", "website", "login URL", "notes", "2FA" */
  changes: string[];
  /** The update replaces a password the saved login already has */
  replacesPassword: boolean;
  hasTotp: boolean;
  /** Export rows merged into this login */
  rows: number;
  /** Rows sharing a key have different passwords for the same site + username; import at most one of them. */
  conflictKey: string | null;
  /** Masked password ("a••••••4"), only on rows that share a conflictKey so they can be told apart */
  passwordHint?: string;
  warning?: string;
}

export interface PasswordImportSkipped {
  name: string;
  url: string;
  username: string;
  reason: string;
}

export interface PasswordImportPreview {
  source: PasswordImportSource;
  /** Entries in the file */
  total: number;
  rows: PasswordImportRow[];
  skipped: PasswordImportSkipped[];
}

export interface PasswordImportResult {
  created: number;
  updated: number;
  /** 2FA codes created or linked */
  totp: number;
}

export interface MissingLoginPatch {
  status?: MissingLoginStatus;
  credentialId?: ID | null;
}

export interface RunWithEvents extends Run {
  logPath: string | null;
}

/** GET /api/folders — subfolders of a directory on the machine running the core. */
export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  /** Filesystem roots ("/" or the available drive letters on Windows). */
  roots: string[];
  /** Why this folder can't be used as a working folder (it overlaps Godmode's data directory), or null. */
  blocked: string | null;
  entries: { name: string; path: string; git: boolean; blocked: boolean }[];
  /** More subfolders exist than were returned. */
  truncated: boolean;
}

export interface AgentFileEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: string;
}

export interface GitCommit {
  oid: string;
  message: string;
  author: string;
  timestamp: string;
}

export interface BackupExportInput {
  passphrase: string;
  includeAgentRepos?: boolean;
  includeBrowserProfiles?: boolean;
}

export interface BackupManifest {
  format: "godmode-backup";
  version: 1;
  appVersion: string;
  createdAt: string;
  counts: Record<string, number>;
}

export interface BackupImportResult {
  ok: true;
  counts: Record<string, number>;
  /** Things the import changed or skipped for safety (reset settings, disabled MCP servers, renamed agents). */
  warnings?: string[];
}

export interface ComposioConnectInput {
  toolkit: string;
  workspaceId: ID | null;
  agentId: ID | null;
}

export interface ComposioConnectResult {
  redirectUrl: string | null;
  connectedAccountId: string;
  status: string;
  /** Godmode connection id (`ComposioConnection.id`) — use it with `/api/composio/connections/:id/refresh`. */
  connectionId?: ID;
}

export interface ChromeImportInput {
  /** Local Chrome profile path (from GET /api/browser/chrome-profiles) */
  sourcePath?: string;
  /** Raw cookie JSON exported by profile-use (or a Playwright storage_state) */
  cookiesJson?: string;
  /** Only import cookies for these domains (optional) */
  domains?: string[];
}

export interface ChromeImportResult {
  imported: number;
  skipped: number;
  domains: string[];
  method: "profile-use" | "json" | "cdp";
}

/** Human takeover in the browser live view. x/y are in the coordinate space of the last `browser.frame` (width × height). */
export type BrowserInputEvent =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

export type BotCheckStatus = "pass" | "warn" | "fail";

export interface BotCheckItem {
  id: "webdriver" | "userAgent" | "clientHints" | "worker" | "window" | "webgl" | "plugins" | "languages" | "permissions" | "chrome";
  label: string;
  status: BotCheckStatus;
  detail: string;
}

/** POST /api/browser/profiles/:id/bot-check — what a website's bot detection sees in the profile's browser. */
export interface BotCheckReport {
  profileId: string;
  /** e.g. "Chrome/154.0.8037.59" */
  browser: string;
  headless: boolean;
  stealth: boolean;
  checks: BotCheckItem[];
  checkedAt: string;
}

/** GET /api/browser/profile-use — browser-use's `profile-use` CLI (sync local Chrome cookies to browser-use Cloud). */
export interface ProfileUseStatus {
  installed: boolean;
  path: string | null;
  /** A browser-use Cloud API key is stored in the vault (app secret `browser_use_api_key`) or set in the environment. */
  hasApiKey: boolean;
  /** Last successful sync (ISO date), if any. */
  lastSyncAt: string | null;
  /** Human-readable next step / state, e.g. how to install or that the API key is missing. */
  detail: string;
}

/** POST /api/browser/profile-use/sync */
export interface ProfileUseSyncInput {
  /** A `LocalChromeProfile.path` from GET /api/browser/chrome-profiles (sets browser + profile). */
  sourcePath?: string;
  /** Browser name as shown by `profile-use list`, e.g. "Google Chrome". */
  browser?: string;
  /** Profile name, e.g. "Default" or "Profile 1". Omitted = every profile (of `browser`, if given). */
  profile?: string;
  /** Only sync cookies for these domains (and subdomains). */
  domains?: string[];
  /** Sync into an existing browser-use Cloud profile instead of creating a new one. */
  cloudProfileId?: string;
}

export interface ProfileUseSyncResult {
  ok: boolean;
  output: string;
  /** browser-use Cloud profile id reported by profile-use, when it printed one. */
  cloudProfileId: string | null;
}

export interface DashboardLoginInput {
  password: string;
}

export interface SetupInput {
  passphrase: string;
  rememberDevice: boolean;
  userName?: string;
  dashboardPassword?: string;
}

/** Errors the app UI ran into, recorded in the diagnostic log (`POST /api/logs/client`). */
export interface ClientLogInput {
  entries: {
    level: "info" | "warn" | "error";
    msg: string;
    stack?: string;
    data?: Record<string, unknown>;
  }[];
}

export type { Agent, Attachment, Conversation, Credential, Message, Routine, Run, TotpEntry, Workspace };

/* ------------------------------------------------------------------ */
/* Spend and budgets                                                    */
/* ------------------------------------------------------------------ */

export type SpendPeriod = "today" | "week" | "month" | "all";

export interface SpendTotals {
  /** Runs that worked in the period (a run that went on after a pause counts in each period it worked in). */
  runs: number;
  failed: number;
  costUsd: number;
  durationMs: number;
}

/**
 * What the team cost, booked when the money was spent (each stretch of a run when it ended). `periods` holds the four
 * totals; the breakdowns are for `period`.
 */
export interface SpendReport {
  period: SpendPeriod;
  /** IANA zone days and months are counted in (the computer Godmode runs on). */
  timeZone: string;
  periods: Record<SpendPeriod, SpendTotals>;
  byAgent: (SpendTotals & { agentId: ID; name: string; deleted: boolean })[];
  byKind: (SpendTotals & { kind: SpendKind })[];
  /** Runs queued, working or standing still right now: what they cost so far is in, the rest comes. */
  active: number;
}

export interface BudgetStatus {
  /** null = the team's budget. */
  agentId: ID | null;
  budgetUsd: number | null;
  spentUsd: number;
  /** Runs held for this budget. */
  held: number;
  state: "none" | "ok" | "warning" | "exhausted";
}

export interface BudgetOverview {
  /** "2026-10" */
  month: string;
  /** When the month's budgets start over. */
  resetsAt: ISODate;
  team: BudgetStatus;
  /** Agents with a budget of their own, or held runs. */
  agents: BudgetStatus[];
}

export type BudgetReleaseInput = { scope: "team" } | { scope: "agent"; agentId: ID };
