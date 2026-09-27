import type {
  Agent,
  AgentBrowserConfig,
  AgentPermissions,
  Attachment,
  Conversation,
  Credential,
  Effort,
  ID,
  Message,
  MissingLoginStatus,
  Routine,
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
}

export interface AgentInput {
  workspaceId?: ID | null;
  name: string;
  avatar?: string;
  color?: string;
  description?: string;
  instructions?: string;
  model?: string;
  effort?: Effort | null;
  enabled?: boolean;
  permissions?: Partial<AgentPermissions>;
  browser?: Partial<AgentBrowserConfig>;
  mcpServerIds?: ID[];
  inheritMcp?: boolean;
  subagents?: SubagentDefinition[];
}

export interface AgentTemplate {
  id: string;
  name: string;
  avatar: string;
  color: string;
  description: string;
  instructions: string;
  routine?: { name: string; cron: string; prompt: string };
}

export interface RoutineInput {
  agentId: ID;
  name: string;
  cron: string;
  timezone?: string;
  prompt: string;
  enabled?: boolean;
  reuseConversation?: boolean;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
  activeRunId: ID | null;
}

export interface SendMessageInput {
  content: string;
  /** Uploaded attachments (base64) */
  attachments?: { name: string; mime: string; data: string }[];
  /** Voice-originated message (auto speak reply) */
  voice?: boolean;
}

export interface SendMessageResult {
  message: Message;
  run: Run;
}

export interface StartChatInput {
  agentId?: ID;
  content: string;
  attachments?: SendMessageInput["attachments"];
  voice?: boolean;
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

export interface MissingLoginPatch {
  status?: MissingLoginStatus;
  credentialId?: ID | null;
}

export interface RunWithEvents extends Run {
  logPath: string | null;
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

export type { Agent, Attachment, Conversation, Credential, Message, Routine, Run, TotpEntry, Workspace };
