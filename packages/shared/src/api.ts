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

export interface ComposioConnectInput {
  toolkit: string;
  workspaceId: ID | null;
  agentId: ID | null;
}

export interface ComposioConnectResult {
  redirectUrl: string | null;
  connectedAccountId: string;
  status: string;
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
