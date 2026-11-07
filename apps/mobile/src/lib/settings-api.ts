import type {
  BotCheckReport,
  BrowserProfile,
  ClaudeAccount,
  ClaudeAccountsState,
  CleanupId,
  CleanupReport,
  CleanupRun,
  CloudBilling,
  CloudStatus,
  ComputerStatus,
  ConnectStatus,
  DeviceGroup,
  DoctorReport,
  DreamAllResult,
  LicenseState,
  LicenseUsage,
  LogEntry,
  LogLevel,
  LogOverview,
  MaintenanceStatus,
  MemorySource,
  OptimizeReport,
  OptimizeRun,
  PermissionReport,
  PowerStatus,
  Review,
  ReviewOverview,
  StartChatResult,
  UsageSummary,
} from "@godmode/shared";
import { request } from "./api";

type Query = Record<string, string | number | undefined>;

function qs(query?: Query): string {
  const parts = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

const get = <T>(path: string, query?: Query) => request<T>("GET", path + qs(query));
const post = <T>(path: string, body: unknown = {}, minTimeoutMs = 0) => request<T>("POST", path, body, minTimeoutMs);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

/** What Settings on the phone reads and changes beyond the settings document. An older Godmode refuses these (403 `device_forbidden`). */
export const settingsApi = {
  reviews: {
    overview: () => get<ReviewOverview>("/api/reviews"),
    /** Review now (409 while one runs). */
    start: () => post<Review>("/api/reviews"),
    get: (id: string) => get<Review>(`/api/reviews/${id}`),
    undo: (id: string, index: number) => post<Review>(`/api/reviews/${id}/actions/${index}/undo`),
  },

  browser: {
    create: (name: string) => post<BrowserProfile>("/api/browser/profiles", { name }),
    rename: (id: string, name: string) => patch<BrowserProfile>(`/api/browser/profiles/${id}`, { name }),
    makeDefault: (id: string) => patch<BrowserProfile>(`/api/browser/profiles/${id}`, { isDefault: true }),
    remove: (id: string) => del<{ ok: true }>(`/api/browser/profiles/${id}`),
    stop: (id: string) => post<{ ok: true }>(`/api/browser/profiles/${id}/stop`),
    /** Opens the bot-detection pages in the profile's browser and reads what they found. */
    botCheck: (id: string) => post<BotCheckReport>(`/api/browser/profiles/${id}/bot-check`, {}, 120_000),
  },

  computer: {
    status: () => get<ComputerStatus>("/api/computer/status"),
    stopHelper: () => post<{ ok: true }>("/api/computer/cua/stop"),
  },

  claudeAccounts: {
    list: () => get<ClaudeAccountsState>("/api/claude-accounts"),
    refresh: () => post<ClaudeAccountsState>("/api/claude-accounts/refresh", {}, 30_000),
    setDefault: (id: string) => post<ClaudeAccount[]>(`/api/claude-accounts/${encodeURIComponent(id)}/default`),
  },

  memory: {
    /** Starts a chat with the main agent that sorts the pasted memory in. */
    import: (source: MemorySource, text: string) => post<StartChatResult>("/api/memory/import", { source, text }, 30_000),
    dreamAll: () => post<DreamAllResult>("/api/dreams/all", {}, 30_000),
  },

  cleanup: {
    /** Looking through the data folder can take a while. */
    report: (refresh = false) => request<CleanupReport>("GET", `/api/cleanup${refresh ? "?refresh=1" : ""}`, undefined, 90_000),
    /** Only what Godmode would remove by itself; the rest is cleaned up on the computer. */
    run: (ids: CleanupId[]) => post<CleanupRun>("/api/cleanup", { ids }, 120_000),
  },

  optimize: {
    report: () => get<OptimizeReport>("/api/optimize"),
    run: () => post<OptimizeRun>("/api/optimize", {}, 120_000),
  },

  doctor: {
    get: (refresh = false) => get<DoctorReport>("/api/doctor", { refresh: refresh ? 1 : undefined }),
    permissions: () => get<PermissionReport>("/api/doctor/permissions"),
    maintenance: () => get<MaintenanceStatus>("/api/doctor/maintenance"),
  },

  power: {
    get: () => get<PowerStatus>("/api/power"),
    /** Only once macOS allowed it on the computer (409 `power_needs_computer` before). */
    setLid: (enabled: boolean) => post<PowerStatus>("/api/power/lid", { enabled }, 30_000),
  },

  license: {
    get: () => get<LicenseState>("/api/license"),
    usage: () => get<LicenseUsage>("/api/license/usage"),
    /** Asks the licence server again; nothing to buy or enter. */
    refresh: () => post<LicenseState>("/api/license/refresh", {}, 30_000),
  },

  usage: (days = 30) => get<UsageSummary>("/api/usage", { days }),

  cloud: {
    status: () => get<CloudStatus>("/api/cloud"),
    billing: () => get<CloudBilling>("/api/cloud/billing"),
  },

  devices: () => get<DeviceGroup>("/api/devices"),

  connectors: {
    status: () => get<ConnectStatus>("/api/connectors"),
    revoke: (id: string) => del<{ ok: true }>(`/api/connectors/${id}`),
  },

  logs: {
    overview: () => get<LogOverview>("/api/logs"),
    entries: (q: { level?: LogLevel; search?: string; limit?: number } = {}) => get<LogEntry[]>("/api/logs/entries", q),
  },
};

/** Query keys of the Settings screens. */
export const sq = {
  reviews: ["reviews"],
  review: (id: string) => ["reviews", id],
  computerStatus: ["computer-status"],
  claudeAccounts: ["claude-accounts"],
  cleanup: ["cleanup"],
  optimize: ["optimize"],
  doctor: ["doctor"],
  permissions: ["doctor", "permissions"],
  maintenance: ["doctor", "maintenance"],
  power: ["power"],
  license: ["license"],
  licenseUsage: ["license", "usage"],
  usage: (days: number) => ["usage", days],
  cloud: ["cloud"],
  cloudBilling: ["cloud", "billing"],
  devices: ["devices"],
  connectors: ["connectors"],
  logOverview: ["logs"],
  logEntries: (level: string, search: string) => ["logs", "entries", level, search],
} as const;
