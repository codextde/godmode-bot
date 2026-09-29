import type {
  Agent,
  AgentFileEntry,
  AgentInput,
  AgentTemplate,
  ApiError,
  AppNotification,
  AuditEntry,
  AutomationEvent,
  BackupExportInput,
  BackupImportResult,
  Bootstrap,
  BrowserProfile,
  ChromeImportInput,
  ClientLogInput,
  ChromeImportResult,
  ClaudeUpdateResult,
  ClaudeUpdateStatus,
  ComposioConnectInput,
  ComposioConnectResult,
  ComposioConnection,
  ComposioStatus,
  ComposioToolkit,
  ComposioTriggerType,
  ComputerImage,
  ComputerInputEvent,
  ComputerSources,
  ComputerStatus,
  Conversation,
  ConversationPatch,
  ConversationWithMessages,
  Credential,
  CredentialInput,
  DependencyId,
  DoctorReport,
  Dream,
  DreamDetail,
  DreamOverview,
  FolderListing,
  GitCommit,
  LocalChromeProfile,
  LogEntry,
  LogLevel,
  LogOverview,
  McpServer,
  McpServerInput,
  MessagingChat,
  MessagingConnection,
  MessagingConnectionInput,
  MessagingConnectionPatch,
  MessagingCredentials,
  MessagingUser,
  MessagingUserStatus,
  MessagingVerifyResult,
  MissingLogin,
  MissingLoginPatch,
  ModelCatalog,
  Routine,
  RoutineInput,
  Run,
  SendMessageInput,
  SendMessageResult,
  Settings,
  SetupInput,
  SlashCommand,
  SshAssignInput,
  SshExecInput,
  SshExecResult,
  SshGeneratedKey,
  SshLocalKey,
  SshServer,
  SshServerInput,
  SshServerPatch,
  SshTestInput,
  SshTestResult,
  StartChatInput,
  StartChatResult,
  TotpCode,
  TotpEntry,
  TotpImportInput,
  TotpImportResult,
  PasswordImportPreview,
  PasswordImportResult,
  TestEventInput,
  TotpInput,
  VaultStatus,
  Vm,
  VmAssignInput,
  VmExecResult,
  VmInput,
  VmPatch,
  VmStatus,
  WebhookRotateResult,
  Workspace,
  WorkspaceInput,
  WorkspaceSource,
} from "@godmode/shared";
import { getCoreInfo } from "./core";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** Header for a reveal grant from `api.vault.grant` (see components/vault/grant.tsx). */
export const GRANT_HEADER = "x-godmode-grant";

export interface VaultGrant {
  grant: string;
  expiresAt: string;
}

let onGrantRejected: (() => void) | null = null;
/** Called when the core refuses a grant we sent (expired, or the core restarted): drop the cached one. */
export function setGrantRejectedHandler(fn: () => void) {
  onGrantRejected = fn;
}

const withGrant = (grant?: string): RequestInit => (grant ? { headers: { [GRANT_HEADER]: grant } } : {});

export async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const { baseUrl, token } = await getCoreInfo();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) {
    payload = body;
  } else if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, method, headers, body: payload, credentials: "same-origin" });
  if (!res.ok) {
    let err: ApiError = { error: res.statusText || `HTTP ${res.status}` };
    try {
      err = await res.json();
    } catch {
      /* not json */
    }
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    if (res.status === 403 && err.code === "grant_required" && headers.has(GRANT_HEADER)) onGrantRejected?.();
    throw new ApiRequestError(res.status, err.error, err.code, err.details);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await res.json()) as T;
  if (type.startsWith("text/")) return (await res.text()) as T;
  return (await res.blob()) as T;
}

const get = <T>(path: string, query?: Query) => request<T>("GET", path + qs(query));
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {});
const patch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {});
const del = <T>(path: string, query?: Query) => request<T>("DELETE", path + qs(query));

function importForm(file: File, workspaceId: string | null): FormData {
  const form = new FormData();
  form.set("file", file);
  form.set("workspaceId", workspaceId ?? "");
  return form;
}

/** Workspace filter: "all" (default), "global" (only global), or a workspace id. */
export type ScopeFilter = "all" | "global" | string;

/** What `api.vms.open` shows on this Mac: the VM's screen (Screen Sharing), a Terminal (SSH) or its shared folder (Finder). */
export type VmOpenTarget = "screen" | "terminal" | "folder";

export const api = {
  auth: {
    status: () => get<{ authenticated: boolean; mode: "desktop" | "server"; hasDashboardPassword: boolean; vaultInitialized: boolean }>("/api/auth/status"),
    login: (password: string) => post<{ ok: true }>("/api/auth/login", { password }),
    token: (token: string) => post<{ ok: true }>("/api/auth/token", { token }),
    logout: () => post<{ ok: true }>("/api/auth/logout"),
    setPassword: (password: string) => post<{ ok: true }>("/api/auth/password", { password }),
  },

  bootstrap: () => get<Bootstrap>("/api/bootstrap"),

  settings: {
    get: () => get<Settings>("/api/settings"),
    update: (p: DeepPartial<Settings>, grant?: string) => request<Settings>("PUT", "/api/settings", p, withGrant(grant)),
  },

  notifications: {
    list: () => get<AppNotification[]>("/api/notifications"),
    read: (ids: string[] | "all") => post<{ ok: true }>("/api/notifications/read", { ids }),
    clear: () => del<{ ok: true }>("/api/notifications"),
  },

  audit: {
    list: (q: { limit?: number; action?: string } = {}) => get<AuditEntry[]>("/api/audit", q),
  },

  logs: {
    overview: () => get<LogOverview>("/api/logs"),
    entries: (q: { level?: LogLevel; search?: string; limit?: number } = {}) => get<LogEntry[]>("/api/logs/entries", q),
    /** Markdown for an AI to analyze; `full` includes every entry instead of the newest that fit in a chat. */
    report: (full = false) => get<string>("/api/logs/report", { full: full ? 1 : undefined }),
    clear: () => del<{ ok: true }>("/api/logs"),
    client: (input: ClientLogInput) => post<{ ok: true }>("/api/logs/client", input),
  },

  models: {
    get: (refresh = false) => get<ModelCatalog>("/api/models", { refresh: refresh ? 1 : undefined }),
  },

  doctor: {
    get: (refresh = false) => get<DoctorReport>("/api/doctor", { refresh: refresh ? 1 : undefined }),
    install: (id: DependencyId) => post<{ ok: boolean; output: string }>("/api/doctor/install", { id }),
    claudeUpdate: (refresh = false) => get<ClaudeUpdateStatus>("/api/doctor/claude-update", { refresh: refresh ? 1 : undefined }),
    updateClaude: () => post<ClaudeUpdateResult>("/api/doctor/claude-update"),
  },

  vault: {
    status: () => get<VaultStatus>("/api/vault/status"),
    setup: (input: SetupInput) => post<VaultStatus>("/api/vault/setup", input),
    unlock: (passphrase: string) => post<VaultStatus>("/api/vault/unlock", { passphrase }),
    lock: () => post<VaultStatus>("/api/vault/lock"),
    changePassphrase: (current: string, next: string) => post<{ ok: true }>("/api/vault/passphrase", { current, next }),
    remember: (remember: boolean, grant?: string) => request<VaultStatus>("POST", "/api/vault/remember", { remember }, withGrant(grant)),
    /** Re-enter the passphrase → short-lived grant for revealing secrets (the lock state doesn't change). */
    grant: (passphrase: string) => post<VaultGrant>("/api/vault/grant", { passphrase }),
    /** App-level secrets (API keys): composio_api_key, openai_api_key, elevenlabs_api_key, anthropic_api_key, browser_use_api_key */
    secrets: {
      list: () => get<{ key: string; set: boolean; updatedAt: string | null }[]>("/api/vault/secrets"),
      set: (key: string, value: string) => put<{ ok: true }>(`/api/vault/secrets/${encodeURIComponent(key)}`, { value }),
      delete: (key: string) => del<{ ok: true }>(`/api/vault/secrets/${encodeURIComponent(key)}`),
    },
  },

  credentials: {
    list: (q: { workspaceId?: ScopeFilter; search?: string } = {}) => get<Credential[]>("/api/credentials", q),
    get: (id: string) => get<Credential>(`/api/credentials/${id}`),
    reveal: (id: string, grant?: string) =>
      request<{ password: string | null; notes: string | null }>("POST", `/api/credentials/${id}/reveal`, {}, withGrant(grant)),
    create: (input: CredentialInput) => post<Credential>("/api/credentials", input),
    update: (id: string, input: Partial<CredentialInput>) => patch<Credential>(`/api/credentials/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/credentials/${id}`),
    importPreview: (file: File, workspaceId: string | null, grant?: string) =>
      request<PasswordImportPreview>("POST", "/api/credentials/import/preview", importForm(file, workspaceId), withGrant(grant)),
    import: (file: File, workspaceId: string | null, ids: number[], grant?: string) => {
      const form = importForm(file, workspaceId);
      form.set("ids", JSON.stringify(ids));
      return request<PasswordImportResult>("POST", "/api/credentials/import", form, withGrant(grant));
    },
  },

  totp: {
    list: (q: { workspaceId?: ScopeFilter; search?: string } = {}) => get<TotpEntry[]>("/api/totp", q),
    codes: (ids?: string[]) => get<TotpCode[]>("/api/totp/codes", { ids: ids?.join(",") }),
    create: (input: TotpInput) => post<TotpEntry>("/api/totp", input),
    update: (id: string, input: Partial<TotpInput>) => patch<TotpEntry>(`/api/totp/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/totp/${id}`),
    import: (input: TotpImportInput) => post<TotpImportResult>("/api/totp/import", input),
  },

  workspaces: {
    list: () => get<Workspace[]>("/api/workspaces"),
    create: (input: WorkspaceInput) => post<Workspace>("/api/workspaces", input),
    update: (id: string, input: Partial<WorkspaceInput>) => patch<Workspace>(`/api/workspaces/${id}`, input),
    delete: (id: string, force = false) => del<{ ok: true }>(`/api/workspaces/${id}`, { force: force ? 1 : undefined }),
    syncSource: (id: string, sourceId: string) => post<WorkspaceSource>(`/api/workspaces/${id}/sources/${sourceId}/sync`),
  },

  agents: {
    list: (q: { workspaceId?: ScopeFilter } = {}) => get<Agent[]>("/api/agents", q),
    get: (id: string) => get<Agent>(`/api/agents/${id}`),
    create: (input: AgentInput, grant?: string) => request<Agent>("POST", "/api/agents", input, withGrant(grant)),
    update: (id: string, input: Partial<AgentInput>, grant?: string) => request<Agent>("PATCH", `/api/agents/${id}`, input, withGrant(grant)),
    delete: (id: string) => del<{ ok: true }>(`/api/agents/${id}`),
    templates: () => get<AgentTemplate[]>("/api/agent-templates"),
    /** Start a fresh task conversation for the agent */
    run: (id: string, prompt?: string) => post<StartChatResult>(`/api/agents/${id}/run`, { prompt }),
    files: (id: string, path = "") => get<AgentFileEntry[]>(`/api/agents/${id}/files`, { path }),
    readFile: (id: string, path: string) => get<{ path: string; content: string }>(`/api/agents/${id}/file`, { path }),
    writeFile: (id: string, path: string, content: string) => put<{ ok: true }>(`/api/agents/${id}/file`, { path, content }),
    commits: (id: string) => get<GitCommit[]>(`/api/agents/${id}/commits`),
    /** Slash commands of the installed Claude Code CLI, as this agent's runs see them */
    commands: (id: string) => get<SlashCommand[]>(`/api/agents/${id}/commands`),
  },

  dreams: {
    /** Dreaming status of an agent: schedule, waiting activity, the active dream and the journal. */
    overview: (agentId: string) => get<DreamOverview>(`/api/agents/${agentId}/dreams`),
    /** Dream now (409 when the agent is disabled or already dreaming). Cancel via `runs.cancel(dream.runId)`. */
    start: (agentId: string) => post<Dream>(`/api/agents/${agentId}/dreams`),
    get: (id: string) => get<DreamDetail>(`/api/dreams/${id}`),
    /** Put the memory files back the way they were before the dream (409 when they were edited since). */
    revert: (id: string) => post<Dream>(`/api/dreams/${id}/revert`),
  },

  routines: {
    list: (q: { agentId?: string } = {}) => get<Routine[]>("/api/routines", q),
    create: (input: RoutineInput) => post<Routine>("/api/routines", input),
    update: (id: string, input: Partial<RoutineInput>) => patch<Routine>(`/api/routines/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/routines/${id}`),
    /** Schedule: run now · condition: check now (trigger "check") · app/webhook: run with a test event. */
    run: (id: string) => post<Run>(`/api/routines/${id}/run`),
    /** What started this automation, newest first. */
    events: (id: string, q: { limit?: number } = {}) => get<AutomationEvent[]>(`/api/routines/${id}/events`, q),
    /** App/webhook automations only: queue a sample event (goes through the filter like a real one). */
    testEvent: (id: string, input: TestEventInput = {}) => post<AutomationEvent>(`/api/routines/${id}/test-event`, input),
    /** Webhook automations: issue a new secret URL; the old one stops working. */
    rotateWebhook: (id: string) => post<WebhookRotateResult>(`/api/routines/${id}/webhook/rotate`),
  },

  automationEvents: {
    list: (q: { limit?: number; routineId?: string } = {}) => get<AutomationEvent[]>("/api/automation-events", q),
  },

  conversations: {
    list: (q: { agentId?: string; search?: string; limit?: number; archived?: boolean } = {}) =>
      get<Conversation[]>("/api/conversations", q),
    get: (id: string) => get<ConversationWithMessages>(`/api/conversations/${id}`),
    create: (input: { agentId: string; title?: string }) => post<Conversation>("/api/conversations", input),
    update: (id: string, input: ConversationPatch) => patch<Conversation>(`/api/conversations/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/conversations/${id}`),
    send: (id: string, input: SendMessageInput) => post<SendMessageResult>(`/api/conversations/${id}/messages`, input),
  },

  computer: {
    status: () => get<ComputerStatus>("/api/computer/status"),
    /** Displays, windows and Godmode browser tabs that can be shared. */
    sources: () => get<ComputerSources>("/api/computer/sources"),
    thumbnail: (view: string, size = 480) => get<ComputerImage>("/api/computer/thumbnail", { view, size }),
    /** macOS: ask for Accessibility + Screen Recording. */
    requestPermissions: () => post<ComputerStatus>("/api/computer/permissions"),
    installCua: () => post<{ ok: boolean; output: string }>("/api/computer/cua/install"),
    stopCua: () => post<{ ok: true }>("/api/computer/cua/stop"),
    /** Human takeover in a computer live view; coordinates are in the frame the human saw (`frame`). */
    input: (view: string, event: ComputerInputEvent, frame?: { width: number; height: number }) =>
      post<{ ok: true }>("/api/computer/input", { view, event, frame }),
  },

  vms: {
    /** Support, Tart install state, image presets, host resources and the running count. */
    status: () => get<VmStatus>("/api/vms/status"),
    /** Download Godmode's own copy of Tart. */
    install: () => post<{ ok: boolean; output: string }>("/api/vms/install"),
    list: () => get<Vm[]>("/api/vms"),
    get: (id: string) => get<Vm>(`/api/vms/${id}`),
    /** Answers right away with state "creating"; progress arrives as `vm.updated` events. */
    create: (input: VmInput) => post<Vm>("/api/vms", input),
    /** CPU, memory and display apply on the next start; the disk can only grow (while stopped). */
    update: (id: string, input: VmPatch) => patch<Vm>(`/api/vms/${id}`, input),
    delete: (id: string, opts: { keepFiles?: boolean } = {}) => del<{ ok: true }>(`/api/vms/${id}`, { keepFiles: opts.keepFiles ? 1 : undefined }),
    /** Remove a downloaded image (preset id) to free space; VMs made from it keep working. */
    removeImage: (image: string) => del<{ ok: true }>(`/api/vms/images/${encodeURIComponent(image)}`),
    /** Boots in the background; fails right away when two VMs already run or the disk is missing. */
    start: (id: string) => post<Vm>(`/api/vms/${id}/start`),
    stop: (id: string) => post<Vm>(`/api/vms/${id}/stop`),
    suspend: (id: string) => post<Vm>(`/api/vms/${id}/suspend`),
    restart: (id: string) => post<Vm>(`/api/vms/${id}/restart`),
    /** Recreate the disk from the VM's image (keeps the shared folder and assignments). */
    reset: (id: string, input: { start?: boolean } = {}) => post<Vm>(`/api/vms/${id}/reset`, input),
    /** Copy of a stopped VM. */
    duplicate: (id: string, name?: string) => post<Vm>(`/api/vms/${id}/duplicate`, name ? { name } : {}),
    exec: (id: string, input: { command: string; cwd?: string; timeoutSeconds?: number }) => post<VmExecResult>(`/api/vms/${id}/exec`, input),
    /** Screen and Terminal boot the VM first when needed. */
    open: (id: string, what: VmOpenTarget) => post<{ ok: true }>(`/api/vms/${id}/open`, { what }),
    /** A picture of a running VM's screen (never boots it). */
    screenshot: (id: string, size = 640) => get<{ data: string; mime: string; width: number; height: number }>(`/api/vms/${id}/screenshot`, { size }),
    assign: (id: string, input: VmAssignInput) => post<Vm>(`/api/vms/${id}/assign`, input),
  },

  ssh: {
    list: () => get<SshServer[]>("/api/ssh/servers"),
    get: (id: string) => get<SshServer>(`/api/ssh/servers/${id}`),
    create: (input: SshServerInput) => post<SshServer>("/api/ssh/servers", input),
    update: (id: string, input: SshServerPatch) => patch<SshServer>(`/api/ssh/servers/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/ssh/servers/${id}`),
    /** Sign in to a saved server; pins its host key when none is pinned yet. */
    test: (id: string) => post<SshTestResult>(`/api/ssh/servers/${id}/test`),
    /** Try an unsaved (or edited) server; `id` fills in the saved secrets the input leaves out. */
    try: (input: SshTestInput) => post<SshTestResult>("/api/ssh/test", input),
    exec: (id: string, input: SshExecInput) => post<SshExecResult>(`/api/ssh/servers/${id}/exec`, input),
    assign: (id: string, input: SshAssignInput) => post<SshServer>(`/api/ssh/servers/${id}/assign`, input),
    /** Private keys in ~/.ssh on the computer running Godmode. */
    localKeys: () => get<SshLocalKey[]>("/api/ssh/local-keys"),
    generateKey: (comment?: string) => post<SshGeneratedKey>("/api/ssh/keys", comment ? { comment } : {}),
  },

  chat: {
    /** Create a conversation and send the first message in one call. */
    start: (input: StartChatInput) => post<StartChatResult>("/api/chat", input),
  },

  folders: {
    /** Subfolders on the machine running the core; no path = home. */
    list: (path?: string, hidden = false) => get<FolderListing>("/api/folders", { path, hidden: hidden ? 1 : undefined }),
    recent: () => get<string[]>("/api/folders/recent"),
  },

  runs: {
    list: (q: { agentId?: string; status?: string; limit?: number } = {}) => get<Run[]>("/api/runs", q),
    get: (id: string) => get<Run>(`/api/runs/${id}`),
    cancel: (id: string) => post<{ ok: true }>(`/api/runs/${id}/cancel`),
    log: (id: string) => get<string>(`/api/runs/${id}/log`),
  },

  missingLogins: {
    list: (q: { status?: string } = {}) => get<MissingLogin[]>("/api/missing-logins", q),
    update: (id: string, input: MissingLoginPatch) => patch<MissingLogin>(`/api/missing-logins/${id}`, input),
  },

  mcpServers: {
    list: (q: { workspaceId?: ScopeFilter; agentId?: string } = {}) => get<McpServer[]>("/api/mcp-servers", q),
    create: (input: McpServerInput) => post<McpServer>("/api/mcp-servers", input),
    update: (id: string, input: Partial<McpServerInput>) => patch<McpServer>(`/api/mcp-servers/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/mcp-servers/${id}`),
    test: (id: string) => post<{ ok: boolean; tools?: string[]; error?: string }>(`/api/mcp-servers/${id}/test`),
  },

  messaging: {
    list: () => get<MessagingConnection[]>("/api/messaging"),
    /** Check tokens without saving them: who the bot is, and anything to know before connecting. */
    verify: (credentials: MessagingCredentials) => post<MessagingVerifyResult>("/api/messaging/verify", { credentials }),
    /** Open access ("anyone") needs a vault grant. */
    create: (input: MessagingConnectionInput, grant?: string) => request<MessagingConnection>("POST", "/api/messaging", input, withGrant(grant)),
    update: (id: string, input: MessagingConnectionPatch, grant?: string) => request<MessagingConnection>("PATCH", `/api/messaging/${id}`, input, withGrant(grant)),
    delete: (id: string) => del<{ ok: true }>(`/api/messaging/${id}`),
    users: (id: string) => get<MessagingUser[]>(`/api/messaging/${id}/users`),
    setUser: (id: string, userId: string, status: MessagingUserStatus) => patch<MessagingUser>(`/api/messaging/${id}/users/${userId}`, { status }),
    removeUser: (id: string, userId: string) => del<{ ok: true }>(`/api/messaging/${id}/users/${userId}`),
    chats: (id: string) => get<MessagingChat[]>(`/api/messaging/${id}/chats`),
    /** Teams app package (zip) to upload in Teams. */
    teamsApp: (id: string) => request<Blob>("GET", `/api/messaging/${id}/teams-app`),
  },

  composio: {
    status: () => get<ComposioStatus>("/api/composio/status"),
    /** Force the core to re-validate the stored key */
    recheck: () => get<ComposioStatus>("/api/composio/status", { refresh: 1 }),
    setKey: (apiKey: string | null) => put<ComposioStatus>("/api/composio/key", { apiKey }),
    toolkits: (q: { search?: string; category?: string; cursor?: string } = {}) =>
      get<{ items: ComposioToolkit[]; nextCursor: string | null }>("/api/composio/toolkits", q),
    connections: () => get<ComposioConnection[]>("/api/composio/connections"),
    connect: (input: ComposioConnectInput) => post<ComposioConnectResult>("/api/composio/connect", input),
    refresh: (id: string) => post<ComposioConnection>(`/api/composio/connections/${id}/refresh`),
    disconnect: (id: string) => del<{ ok: true }>(`/api/composio/connections/${id}`),
    /** Events a toolkit can emit (new email, new Slack message…), with their config schema. */
    triggerTypes: (toolkit: string) => get<ComposioTriggerType[]>("/api/composio/trigger-types", { toolkit }),
    triggerType: (slug: string) => get<ComposioTriggerType>(`/api/composio/trigger-types/${encodeURIComponent(slug)}`),
  },

  browser: {
    profiles: () => get<BrowserProfile[]>("/api/browser/profiles"),
    createProfile: (input: { name: string; workspaceId: string | null }) => post<BrowserProfile>("/api/browser/profiles", input),
    updateProfile: (id: string, input: { name?: string; isDefault?: boolean; workspaceId?: string | null }) => patch<BrowserProfile>(`/api/browser/profiles/${id}`, input),
    deleteProfile: (id: string) => del<{ ok: true }>(`/api/browser/profiles/${id}`),
    launch: (id: string, headless?: boolean) => post<{ cdpUrl: string; port: number }>(`/api/browser/profiles/${id}/launch`, { headless }),
    stop: (id: string) => post<{ ok: true }>(`/api/browser/profiles/${id}/stop`),
    chromeProfiles: () => get<LocalChromeProfile[]>("/api/browser/chrome-profiles"),
    import: (id: string, input: ChromeImportInput) => post<ChromeImportResult>(`/api/browser/profiles/${id}/import`, input),
    navigate: (id: string, url: string) => post<{ ok: true }>(`/api/browser/profiles/${id}/navigate`, { url }),
    /** Human takeover in live view: forward a click / key / text to the page */
    input: (
      id: string,
      event:
        | { type: "click"; x: number; y: number }
        | { type: "scroll"; x: number; y: number; deltaY: number }
        | { type: "key"; key: string }
        | { type: "text"; text: string },
    ) => post<{ ok: true }>(`/api/browser/profiles/${id}/input`, event),
    /** browser-use `profile-use` (sync local Chrome cookies to a browser-use Cloud profile) */
    profileUse: () => get<import("@godmode/shared").ProfileUseStatus>("/api/browser/profile-use"),
    /** Downloads the profile-use binary into <dataDir>/bin */
    profileUseInstall: () => post<import("@godmode/shared").ProfileUseStatus>("/api/browser/profile-use/install"),
    /** Can take several minutes. No input = sync every detected local profile. */
    profileUseSync: (input: import("@godmode/shared").ProfileUseSyncInput = {}) =>
      post<import("@godmode/shared").ProfileUseSyncResult>("/api/browser/profile-use/sync", input),
  },

  backup: {
    export: (input: BackupExportInput) => request<Blob>("POST", "/api/backup/export", input),
    import: (file: File, passphrase: string) => {
      const form = new FormData();
      form.set("file", file);
      form.set("passphrase", passphrase);
      return request<BackupImportResult>("POST", "/api/backup/import", form);
    },
  },

  voice: {
    transcribe: (audio: Blob, language?: string) => {
      const form = new FormData();
      form.set("audio", audio, "speech.webm");
      if (language) form.set("language", language);
      return request<{ text: string }>("POST", "/api/voice/transcribe", form);
    },
    speak: (text: string) => request<Blob>("POST", "/api/voice/speak", { text }),
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
