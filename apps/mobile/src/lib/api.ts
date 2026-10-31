import * as Device from "expo-device";
import Constants from "expo-constants";
import { File } from "expo-file-system";
import type {
  Agent,
  AgentCharacter,
  AgentMemory,
  AgentTemplate,
  AnswerQuestionInput,
  AnswerQuestionResult,
  AgentQuestion,
  AndroidDevice,
  AndroidScreenshot,
  AppNotification,
  Bootstrap,
  BrowserProfile,
  ComputerInputEvent,
  Effort,
  AgentHeartbeatInput,
  Conversation,
  HumanTask,
  HumanTaskCloseResult,
  HumanTaskInput,
  HumanTaskLane,
  HumanTaskPatch,
  ConversationWithMessages,
  MessagePage,
  MissingLogin,
  MissingLoginStatus,
  MobilePairResult,
  MobilePairingPayload,
  MobileSession,
  ModelCatalog,
  PhoneCall,
  Project,
  QueuedMessage,
  RetryMode,
  Routine,
  Run,
  SendMessageResult,
  Settings,
  SendMessageOutcome,
  SlashCommand,
  StartChatResult,
  Task,
  TaskAttachment,
  TaskEvent,
  TaskStatus,
  TaskType,
  Vm,
  Workspace,
  AgentHeartbeatState,
  AutomationEvent,
  AwaySummary,
  Dream,
  DreamDetail,
  DreamOverview,
  Followup,
  Goal,
  GoalInput,
  HeartbeatBeat,
  RoutineInput,
} from "@godmode/shared";
import { CloudErrorCode, LICENSE_REQUIRED, isPhoneUrlAllowed } from "@godmode/shared";
import type { PendingFile, UploadFile } from "./attachments";
import { t } from "./i18n";
import { useLive } from "./live";
import { withPending } from "./pending-queue";
import { accepts, baseUrl, candidateOrder, computerOf, removedBy, type Candidate } from "./peers";
import { useSession, type Connection } from "./session";

const TIMEOUT_MS = 12_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** New work is refused until the computer has an active licence; it is added there, not on the phone. */
const licenseMessage = () => t("system:api.license");

/** An older Godmode on the computer refuses what the phone asked for (`device_forbidden`). */

export const updateDesktopMessage = () => t("system:api.updateDesktop");

const offlineMessage = () => t("system:api.offline");
const noAnswerMessage = () => t("system:api.noAnswer");

async function send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The `{ error, code }` body the computer and the cloud gateway answer errors with; empty when there is none. */
async function failure(res: Response): Promise<{ error?: string; code?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown } | null;
    return { error: typeof body?.error === "string" ? body.error : undefined, code: typeof body?.code === "string" ? body.code : undefined };
  } catch {
    return {};
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const { error, code } = await failure(res);
  return new ApiError(res.status, error ?? t("system:api.requestFailed", { status: res.status }), code);
}

/** Only Godmode on the computer answers this; it means the phone's key is no longer accepted. */
const isRemoved = (status: number, code?: string) => status === 401 && code === "unauthorized";

const GATEWAY_CODES = new Set<string>([
  CloudErrorCode.DeviceOffline,
  CloudErrorCode.DeviceNotFound,
  CloudErrorCode.LinkLost,
  CloudErrorCode.BadResponse,
  CloudErrorCode.PlanLimit,
  CloudErrorCode.RateLimited,
]);

/**
 * The address couldn't pass the request on: the cloud gateway's own answers (computer offline, link lost, plan limit,
 * rate limit), a proxy's error without a code, or any other 401. The computer is out of reach there; the phone stays
 * paired.
 */
function isUnreachable(status: number, code?: string): boolean {
  if (status === 401) return !isRemoved(status, code);
  if (code) return GATEWAY_CODES.has(code);
  return status === 402 || status === 429 || (status >= 502 && status <= 504);
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(query?: Query): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Files take a while over a slow connection: about 100 KB/s at least before giving up. */
function timeoutFor(bytes: number): number {
  return TIMEOUT_MS + Math.round(bytes / 100);
}

/** Addresses and the computer that answered there. */
const verified = new Map<string, string>();
/** Probes on their way, shared by the requests that wait for the same address. */
const probing = new Map<string, Promise<string | ApiError | null>>();
/**
 * Addresses whose probe didn't answer lately. They are skipped for a while — but only while another address is known to
 * answer, so a hiccup never makes the phone give up on the only way to the computer.
 */
const unreachable = new Map<string, number>();
const UNREACHABLE_FOR_MS = 20_000;

type Takes = (instanceId: string | undefined) => boolean;

/** One of the addresses after `index` answered as a computer that takes the key and still counts as reachable. */
function laterAnswers(candidates: Candidate[], index: number, takes: Takes): boolean {
  return candidates.slice(index + 1).some(({ base }) => takes(verified.get(base)));
}

/**
 * Which computer answers at this address? Asked (without the key) before the key goes to an address, so an address
 * that isn't a computer that `takes` it can't collect it. That computer's id when it does; else the cloud gateway's own
 * sentence on why the computer is out of reach there (offline, plan limit), when it gave one.
 */
async function isInstance(base: string, takes: Takes, skipIfDown = false): Promise<string | ApiError | null> {
  const known = verified.get(base);
  if (known && takes(known)) return known;
  if (!isPhoneUrlAllowed(base)) return null;
  if (skipIfDown && (unreachable.get(base) ?? 0) > Date.now()) return null;
  let probe = probing.get(base);
  if (!probe) {
    probe = probeInstance(base).then((found) => {
      if (typeof found === "string") verified.set(base, found);
      else unreachable.set(base, Date.now() + UNREACHABLE_FOR_MS);
      return found;
    });
    probing.set(base, probe);
    void probe.finally(() => probing.delete(base));
  }
  const found = await probe;
  if (typeof found !== "string" || takes(found)) return found;
  unreachable.set(base, Date.now() + UNREACHABLE_FOR_MS);
  return null;
}

/** The instance id Godmode answers with at this address. */
async function probeInstance(base: string): Promise<string | ApiError | null> {
  try {
    const res = await send(`${base}/api/health`, { method: "GET" }, PROBE_TIMEOUT_MS);
    if (!res.ok) {
      const { error, code } = await failure(res);
      return error && isUnreachable(res.status, code) ? new ApiError(res.status, error, code) : null;
    }
    const { instance } = (await res.json()) as { instance?: unknown };
    return typeof instance === "string" && instance ? instance : null;
  } catch {
    return null;
  }
}

/**
 * The address to use right now and the computer there: the one that worked last, else the first other address that
 * answers as a computer of the group (`onTry` hears whose address is next; the addresses in `last` come after the
 * others). Otherwise the cloud gateway's reason when it gave one, else null.
 */
export async function reachableBase(
  connection: Connection,
  onTry?: (instanceId: string) => void,
  last?: Set<string>,
): Promise<{ base: string; instanceId: string } | ApiError | null> {
  let refused: ApiError | null = null;
  const takes: Takes = (id) => accepts(connection, id);
  const order = candidateOrder(connection);
  const candidates = last?.size ? [...order.filter((c) => !last.has(c.base)), ...order.filter((c) => last.has(c.base))] : order;
  for (const [i, { base, instanceId }] of candidates.entries()) {
    onTry?.(instanceId);
    const found = await isInstance(base, takes, laterAnswers(candidates, i, takes));
    if (typeof found === "string") return { base, instanceId: found };
    refused ??= found;
  }
  return refused;
}

/**
 * This computer of the group's best address that answers now and takes this phone's key, asked afresh; null when none
 * does. The key goes only to an address that first answered as that computer.
 */
export async function answeringBase(connection: Connection, instanceId: string): Promise<string | null> {
  const bases = [...new Set(computerOf(connection, instanceId).urls.map(baseUrl))].filter(isPhoneUrlAllowed);
  const base = bases[(await Promise.all(bases.map(probeInstance))).indexOf(instanceId)];
  if (!base) return null;
  try {
    const res = await send(`${base}/api/mobile/me`, { method: "GET", headers: { authorization: `Bearer ${connection.token}`, accept: "application/json" } }, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
  } catch {
    return null;
  }
  verified.set(base, instanceId);
  unreachable.delete(base);
  return base;
}

/**
 * Where pictures load from with the key, in the order to try them: the paired computer's addresses, another computer's
 * once it answered there as one of the group.
 */
export function pictureBases(connection: Connection): string[] {
  return candidateOrder(connection)
    .filter(({ base, instanceId }) => instanceId === connection.instance.id || accepts(connection, verified.get(base)))
    .map(({ base }) => base);
}

/**
 * Asks this address for the computer again before its next use. `down`: and skips it for a while, while another
 * address answers.
 */
export function forget(base: string, down = false) {
  verified.delete(base);
  if (down) unreachable.set(base, Date.now() + UNREACHABLE_FOR_MS);
}

/** Every address gets a fresh chance (the app came back, the network changed, the human pulled to refresh). */
export function retryAddresses() {
  unreachable.clear();
}

/**
 * Calls the paired computer, or another computer of its group. Reads fall through to the other addresses; writes are
 * sent once, so a slow answer never turns into a second message or run. A write moves on only when the answer shows it
 * never reached the computer.
 */
export async function request<T>(method: string, path: string, body?: unknown, minTimeoutMs = 0): Promise<T> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  const headers: Record<string, string> = { authorization: `Bearer ${connection.token}`, accept: "application/json" };
  const form = body instanceof FormData;
  if (body !== undefined && !form) headers["content-type"] = "application/json";
  const payload = body === undefined ? undefined : form ? body : JSON.stringify(body);
  const timeout = Math.max(minTimeoutMs, typeof payload === "string" ? timeoutFor(payload.length) : form ? timeoutFor(MAX_UPLOAD_BYTES) : TIMEOUT_MS);
  let refused: ApiError | null = null;
  const takes: Takes = (id) => accepts(connection, id);
  const candidates = candidateOrder(connection);
  for (const [i, { base }] of candidates.entries()) {
    const found = await isInstance(base, takes, laterAnswers(candidates, i, takes));
    if (typeof found !== "string") {
      refused ??= found;
      continue;
    }
    let res: Response;
    try {
      res = await send(base + path, { method, headers, body: payload }, timeout);
    } catch {
      forget(base);
      if (method === "GET") continue;
      throw new ApiError(0, noAnswerMessage(), "timeout");
    }
    if (res.ok) {
      useSession.getState().setActive(base, found);
      const type = res.headers.get("content-type") ?? "";
      return (type.includes("application/json") ? await res.json() : await res.text()) as T;
    }
    const { error, code } = await failure(res);
    if (isRemoved(res.status, code)) {
      if (removedBy(connection, found)) {
        await useSession.getState().disconnect("removed");
        throw new ApiError(401, t("system:api.removed"), "unauthorized");
      }
      // Another computer of the group that doesn't have this phone's key yet; it refused before doing anything.
      forget(base, true);
      continue;
    }
    if (!isUnreachable(res.status, code)) {
      useSession.getState().setActive(base, found);
      if (code === LICENSE_REQUIRED) throw new ApiError(res.status, licenseMessage(), code);
      throw new ApiError(res.status, error ?? t("system:api.requestFailed", { status: res.status }), code);
    }
    forget(base);
    // 502/504: the request may have reached the computer (the link dropped on the way back, or it answered oddly).
    if (method !== "GET" && (res.status === 502 || res.status === 504)) throw new ApiError(res.status, error ?? noAnswerMessage(), code ?? "timeout");
    if (error) refused ??= new ApiError(res.status, error, code);
  }
  throw refused ?? new ApiError(0, offlineMessage(), "offline");
}

const get = <T>(path: string, query?: Query) => request<T>("GET", path + qs(query));
const post = <T>(path: string, body: unknown = {}, minTimeoutMs = 0) => request<T>("POST", path, body, minTimeoutMs);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

/**
 * A computer on an older Godmode refuses `projectId` from the phone (403, before anything runs): send it again without,
 * so the chat or task still starts, in the workspace.
 */
async function withProject<I extends { projectId?: string | null }, T>(input: I, call: (input: I) => Promise<T>): Promise<T> {
  try {
    return await call(input);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "device_forbidden" && input.projectId !== undefined)) throw err;
    const { projectId: _dropped, ...rest } = input;
    return call(rest as I);
  }
}

export function deviceName(): string {
  return Device.deviceName || Device.modelName || (process.env.EXPO_OS === "ios" ? "iPhone" : "Android phone");
}

/** Trade the scanned code for this phone's own token, trying each address in the code. */
export async function pairWith(payload: MobilePairingPayload): Promise<Connection> {
  if (payload.exp * 1000 < Date.now()) throw new ApiError(401, t("system:api.codeExpired"), "pairing_invalid");
  const body = JSON.stringify({
    code: payload.code,
    name: deviceName(),
    platform: process.env.EXPO_OS === "android" ? "android" : "ios",
    model: Device.modelName ?? null,
    appVersion: Constants.expoConfig?.version ?? null,
  });
  const urls = [...new Set(payload.urls.filter(isPhoneUrlAllowed).map(baseUrl))];
  if (!urls.length) throw new ApiError(400, t("system:api.codeUntrusted"), "pairing_invalid");
  let offline = true;
  let refused: ApiError | null = null;
  for (const base of urls) {
    const found = await isInstance(base, (id) => id === payload.id);
    if (typeof found !== "string") {
      refused ??= found;
      continue;
    }
    let res: Response;
    try {
      res = await send(`${base}/api/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch {
      continue;
    }
    offline = false;
    if (!res.ok) throw await errorFrom(res);
    const result = (await res.json()) as MobilePairResult;
    if (result.instance.id !== payload.id) throw new ApiError(409, t("system:api.differentComputer"), "instance_mismatch");
    return {
      token: result.token,
      deviceId: result.device.id,
      deviceName: result.device.name,
      instance: result.instance,
      urls,
      activeUrl: base,
      peers: [],
      activeInstanceId: result.instance.id,
      preferredInstanceId: null,
      pairedAt: result.device.createdAt,
    };
  }
  if (refused) throw refused;
  throw new ApiError(
    0,
    offline ? t("system:api.offlinePairing") : offlineMessage(),
    "offline",
  );
}

/** What the phone may change of the settings, by section (the computer refuses the rest). */
export type SettingsPatch = {
  general?: Partial<Pick<Settings["general"], "userName" | "desktopNotifications" | "theme" | "mode" | "language" | "timeFormat">>;
  runner?: Partial<Omit<Settings["runner"], "claudePath" | "extraArgs" | "bypassPermissions">>;
  browser?: Partial<Pick<Settings["browser"], "enabled" | "headless" | "keepAliveMinutes" | "liveView" | "stealth" | "muteAudio">>;
  computer?: Partial<Pick<Settings["computer"], "enabled" | "allowForeground" | "agentCursor" | "liveView" | "liveViewFps">>;
  vm?: Partial<Pick<Settings["vm"], "enabled" | "onQuit" | "idleStopMinutes">>;
  memory?: Partial<Pick<Settings["memory"], "autoCommit" | "reflectAfterRun" | "injectMemory">> & { dreaming?: Partial<Settings["memory"]["dreaming"]> };
  maintenance?: Partial<Settings["maintenance"]>;
};

/** Folders are kept as they are (`path`); repositories are added by their clone URL. */
export type SourceInput = { kind: "folder"; path: string } | { kind: "git"; url: string; branch?: string | null };

export type WorkspacePatch = {
  name?: string;
  description?: string;
  icon?: string;
  instructions?: string;
  autoMerge?: boolean;
  browserProfileId?: string | null;
  sources?: SourceInput[];
};

export type ProjectPatch = Omit<WorkspacePatch, "autoMerge">;

export type AgentPatch = {
  name?: string;
  role?: string;
  description?: string;
  instructions?: string;
  personality?: string;
  avatar?: string;
  color?: string;
  character?: Partial<AgentCharacter>;
  model?: string;
  effort?: Effort | null;
  ultracode?: boolean | null;
  enabled?: boolean;
  projectId?: string | null;
  heartbeat?: AgentHeartbeatInput;
};

export type ModelChoicePatch = { model?: string | null; effort?: Effort | null; ultracode?: boolean | null };

export type BrowserInput =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

export const api = {
  me: () => get<MobileSession>("/api/mobile/me"),
  unpair: () => del<{ ok: true }>("/api/mobile/me"),
  bootstrap: () => get<Bootstrap>("/api/bootstrap"),
  workspaces: () => get<Workspace[]>("/api/workspaces"),

  settings: {
    get: () => get<Settings>("/api/settings"),
    update: (patch: SettingsPatch) => put<Settings>("/api/settings", patch),
  },

  workspace: {
    create: (input: WorkspacePatch & { name: string }) => post<Workspace>("/api/workspaces", input),
    update: (id: string, input: WorkspacePatch) => patch<Workspace>(`/api/workspaces/${id}`, input),
    /** Only an empty workspace; one with agents, chats or tasks is deleted on the computer. */
    delete: (id: string) => del<{ ok: true }>(`/api/workspaces/${id}`),
    sync: (id: string, sourceId: string) => post<unknown>(`/api/workspaces/${id}/sources/${sourceId}/sync`),
  },

  projects: {
    create: (input: ProjectPatch & { workspaceId: string; name: string }) => post<Project>("/api/projects", input),
    update: (id: string, input: ProjectPatch) => patch<Project>(`/api/projects/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/projects/${id}`),
    sync: (id: string, sourceId: string) => post<unknown>(`/api/projects/${id}/sources/${sourceId}/sync`),
  },

  agents: {
    list: () => get<Agent[]>("/api/agents"),
    get: (id: string) => get<Agent>(`/api/agents/${id}`),
    create: (input: AgentPatch & { name: string; workspaceId: string | null }) => post<Agent>("/api/agents", input),
    update: (id: string, input: AgentPatch) => patch<Agent>(`/api/agents/${id}`, input),
    /** Slash commands of the installed Claude Code CLI, as this agent's runs see them */
    commands: (id: string) => get<SlashCommand[]>(`/api/agents/${id}/commands`),
    /** MEMORY.md only. `digest` = the version the edit started from (409 `memory_changed` when it changed); an older Godmode refuses this (403). */
    memory: (id: string) => get<AgentMemory>(`/api/agents/${id}/memory`),
    saveMemory: (id: string, content: string, digest?: string) => put<AgentMemory>(`/api/agents/${id}/memory`, { content, ...(digest ? { digest } : {}) }),
    /** Roles to start a new agent from, by department. Their automations are set up on the computer. */
    templates: () => get<AgentTemplate[]>("/api/agent-templates"),
    /** The human has seen the agent's last failed run. */
    dismissFailure: (id: string) => del<Agent>(`/api/agents/${id}/failed-run`),
    heartbeat: (id: string) => get<AgentHeartbeatState>(`/api/agents/${id}/heartbeat`),
    /** "Wake now": one beat right away (400 when the agent is switched off). */
    beat: (id: string) => post<HeartbeatBeat>(`/api/agents/${id}/heartbeat/beat`, {}),
  },

  dreams: {
    overview: (agentId: string) => get<DreamOverview>(`/api/agents/${agentId}/dreams`),
    /** Dream now; a dream is undone on the computer. */
    start: (agentId: string) => post<Dream>(`/api/agents/${agentId}/dreams`, {}),
    get: (id: string) => get<DreamDetail>(`/api/dreams/${id}`),
  },

  /** What the team did between `since` and `until` (Home's "while you were away"). */
  away: (since: string, until?: string) => get<AwaySummary>("/api/away", until ? { since, until } : { since }),

  goals: {
    /** A workspace's goals with the global ones, or every goal (null). */
    list: (workspaceId: string | null) => get<Goal[]>("/api/goals", { workspaceId: workspaceId ?? "all" }),
    create: (input: GoalInput) => post<Goal>("/api/goals", input),
    update: (id: string, input: Partial<GoalInput>) => patch<Goal>(`/api/goals/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/goals/${id}`),
  },

  followups: {
    /** Every chat that continues by itself later, soonest first. */
    list: (q: { agentId?: string } = {}) => get<Followup[]>("/api/followups", q),
  },

  models: (refresh = false) => get<ModelCatalog>("/api/models", refresh ? { refresh: 1 } : {}),

  conversations: {
    /** With `workspaceId`: the workspace's chats. `archived`: the archive; with `ongoing` only its chats that still go on. */
    list: (q: { search?: string; limit?: number; agentId?: string; workspaceId?: string | null; archived?: boolean; ongoing?: boolean } = {}) =>
      get<Conversation[]>("/api/conversations", q),
    /**
     * The chat with its latest `limit` messages, light: screenshots come as their own requests (`imageUrl`). With the
     * queued messages this phone is still sending, so a refetch never drops them. An older Godmode answers with every
     * message (and no `hasMore`).
     */
    get: async (id: string, limit: number) => {
      const conversation = await get<ConversationWithMessages>(`/api/conversations/${id}`, { limit, lite: 1 });
      return { ...conversation, queue: withPending(id, conversation.queue) };
    },
    /** The page of messages before `before`. */
    messages: (id: string, before: string, limit: number) => get<MessagePage>(`/api/conversations/${id}/messages`, { before, limit, lite: 1 }),
    /** While the agent works in the chat the message joins its queue (`queued`) instead of starting a run. */
    send: (id: string, input: { content: string; attachments: UploadFile[]; queueId: string }) =>
      post<SendMessageOutcome | AnswerQuestionResult>(`/api/conversations/${id}/messages`, {
        content: input.content,
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
        queue: true,
        queueId: input.queueId,
      }),
    update: (id: string, input: { title?: string; pinned?: boolean; archived?: boolean } & ModelChoicePatch) => patch<Conversation>(`/api/conversations/${id}`, input),
    queue: {
      edit: (id: string, messageId: string, content: string) => patch<QueuedMessage>(`/api/conversations/${id}/queue/${messageId}`, { content }),
      remove: (id: string, messageId: string) => del<{ ok: true }>(`/api/conversations/${id}/queue/${messageId}`),
      /** Stop what the agent is doing and start on the queue (the core waits for the run to end first). */
      sendNow: (id: string) => post<{ ok: true }>(`/api/conversations/${id}/queue/send`, {}, 30_000),
    },
    delete: (id: string) => del<{ ok: true }>(`/api/conversations/${id}`),
    /** "Mark all read": every chat, or these. */
    read: (ids: string[] | "all") => post<{ read: number }>("/api/conversations/read", { ids }),
    /** Show these chats as new again until they are opened. */
    unread: (ids: string[]) => post<{ unread: number }>("/api/conversations/unread", { ids }),
    /** Continue the chat's paused run where it stopped. */
    continue: (id: string) => post<Run>(`/api/conversations/${id}/continue`),
    /** Make the chat's run stand still; it continues where it stopped. */
    pause: (id: string) => post<{ ok: true }>(`/api/conversations/${id}/pause`, {}, 30_000),
    /** The follow-up the agent set: moved, run now or cancelled. */
    followup: {
      move: (id: string, dueAt: string) => patch<unknown>(`/api/conversations/${id}/followup`, { dueAt }),
      runNow: (id: string) => post<Run>(`/api/conversations/${id}/followup/run`),
      cancel: (id: string) => del<{ ok: true }>(`/api/conversations/${id}/followup`),
    },
    /** Pick up the chat's latest turn that ended early: continue where it stopped, or send it again. */
    retry: (id: string, runId: string) => post<SendMessageResult & { mode: RetryMode }>(`/api/conversations/${id}/retry`, { runId }),
  },

  chat: {
    /** With `workspaceId`: a global agent's chat belongs to that workspace. */
    start: (input: { agentId?: string; content: string; attachments?: UploadFile[]; workspaceId?: string | null; projectId?: string | null } & ModelChoicePatch) =>
      withProject(input, (body) => post<StartChatResult>("/api/chat", body)),
  },

  tasks: {
    /** `workspaceId`: a workspace's board, or all of them when omitted. `archived`: the tasks taken off the board. */
    list: (q: { workspaceId?: string | null; archived?: boolean } = {}) => get<Task[]>("/api/tasks", { ...q, fields: "summary" }),
    get: (id: string) => get<Task>(`/api/tasks/${id}`),
    /** What happened on the ticket, oldest first. */
    events: (id: string) => get<TaskEvent[]>(`/api/tasks/${id}/events`, { limit: 200 }),
    /** With an agent (and no status) the task goes to To do and the agent starts right away. */
    create: (input: {
      workspaceId: string | null;
      projectId?: string | null;
      title: string;
      description?: string;
      type?: TaskType;
      status?: TaskStatus;
      agentId?: string | null;
    }) => withProject(input, (body) => post<Task>("/api/tasks", body)),
    /** Moving to To do starts the agent; moving away from In progress stops it. Archived tasks are off the board. */
    update: (id: string, input: { title?: string; description?: string; status?: TaskStatus; agentId?: string | null; archived?: boolean; projectId?: string | null }) =>
      patch<Task>(`/api/tasks/${id}`, input),
    /** Approve a ticket in review: its open pull request is merged first, then it's done. */
    approve: (id: string) => post<Task>(`/api/tasks/${id}/approve`),
    /** Feedback for the agent in the task's chat; the task goes back to work. */
    message: (id: string, content: string, attachments?: UploadFile[]) =>
      post<Task>(`/api/tasks/${id}/messages`, attachments?.length ? { content, attachments } : { content }),
    /** A file for a description; link it there with its `url`. */
    upload: (file: PendingFile) => {
      const form = new FormData();
      // expo/fetch (the global fetch) takes parts that read their own bytes, not React Native's `{ uri }` parts.
      form.append("file", { name: file.name, type: file.mime, bytes: () => new File(file.uri).bytes() } as unknown as Blob);
      return post<TaskAttachment>("/api/tasks/attachments", form);
    },
  },

  runs: {
    list: (q: { status?: string; limit?: number; agentId?: string } = {}) => get<Run[]>("/api/runs", q),
    get: (id: string) => get<Run>(`/api/runs/${id}`),
    /** The run's raw stream-json log. */
    log: (id: string) => get<string>(`/api/runs/${id}/log`),
    /** A run that had ended without the phone hearing of it (its chat changed computers) stops showing at once. */
    cancel: async (id: string) => {
      const res = await post<{ ok: true }>(`/api/runs/${id}/cancel`);
      const run = await get<Run>(`/api/runs/${id}`).catch(() => null);
      if (run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")) useLive.getState().runFinished(run);
      return res;
    },
  },

  routines: {
    list: (q: { agentId?: string } = {}) => get<Routine[]>("/api/routines", q),
    run: (id: string) => post<Run>(`/api/routines/${id}/run`),
    setEnabled: (id: string, enabled: boolean) => patch<Routine>(`/api/routines/${id}`, { enabled }),
    /** Schedules and conditions only: app and webhook triggers are set up on the computer. */
    create: (input: RoutineInput) => post<Routine>("/api/routines", input),
    update: (id: string, input: Partial<RoutineInput>) => patch<Routine>(`/api/routines/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/routines/${id}`),
    events: (id: string, limit = 50) => get<AutomationEvent[]>(`/api/routines/${id}/events`, { limit }),
  },

  browser: {
    profiles: () => get<BrowserProfile[]>("/api/browser/profiles"),
    launch: (id: string) => post<{ cdpUrl: string; port: number }>(`/api/browser/profiles/${id}/launch`),
    /** With `conversationId`: into that chat's tab. */
    input: (id: string, event: BrowserInput, conversationId?: string | null) =>
      post<{ ok: true }>(`/api/browser/profiles/${id}/input`, conversationId ? { ...event, conversationId } : event),
  },

  computer: {
    input: (view: string, event: ComputerInputEvent, frame: { width: number; height: number }) =>
      post<{ ok: true }>("/api/computer/input", { view, event, frame }),
  },

  vms: {
    list: () => get<Vm[]>("/api/vms"),
    screenshot: (id: string, size = 960) => get<{ data: string; mime: string; width: number; height: number }>(`/api/vms/${id}/screenshot`, { size }),
    start: (id: string) => post<Vm>(`/api/vms/${id}/start`),
    stop: (id: string) => post<Vm>(`/api/vms/${id}/stop`),
    input: (id: string, event: ComputerInputEvent, frame: { width: number; height: number }) => post<{ ok: true }>(`/api/vms/${id}/input`, { event, frame }),
  },

  android: {
    /** Android phones connected to the computer for agents. An older Godmode refuses this (403). */
    devices: () => get<AndroidDevice[]>("/api/android/devices"),
    screenshot: (id: string, size = 720) => get<AndroidScreenshot>(`/api/android/devices/${id}/screenshot`, { size }),
  },

  notifications: {
    list: () => get<AppNotification[]>("/api/notifications", { limit: 30 }),
    read: (ids: string[] | "all") => post<{ ok: true }>("/api/notifications/read", { ids }),
  },

  missingLogins: {
    open: () => get<MissingLogin[]>("/api/missing-logins", { status: "open" }),
    /** Dismissed, marked resolved or opened again; the login itself is added on the computer. */
    setStatus: (id: string, status: MissingLoginStatus) => patch<MissingLogin>(`/api/missing-logins/${id}`, { status }),
  },

  calls: {
    /** Calls agents made and took, newest first. Placed on the computer, never from the phone. */
    list: (limit = 100) => get<PhoneCall[]>("/api/calls", { limit }),
    get: (id: string) => get<PhoneCall>(`/api/calls/${id}`),
  },

  humanTasks: {
    /** What agents handed over to the human: open and doing, or with `closed` the finished ones too. */
    list: (q: { status?: "active" | "closed" | "all"; conversationId?: string } = {}) => get<HumanTask[]>("/api/human-tasks", q),
    /** The human is on it (`doing`) or puts it back (`open`). */
    move: (id: string, status: HumanTaskLane) => patch<HumanTask>(`/api/human-tasks/${id}`, { status }),
    /** One of the human's own, to do now (`open`) or later (`backlog`). */
    create: (input: HumanTaskInput) => post<HumanTask>("/api/human-tasks", input),
    /** Moved (`status`, `beforeId`) or reprioritized; the words only of the human's own tasks. */
    update: (id: string, input: Pick<HumanTaskPatch, "status" | "beforeId" | "priority" | "title" | "body">) => patch<HumanTask>(`/api/human-tasks/${id}`, input),
    /** Refused while an agent stands still for the task's question. */
    remove: (id: string) => del<{ ok: true }>(`/api/human-tasks/${id}`),
    /** Done or can't do it; the note goes to the agent and its chat continues. */
    close: (id: string, outcome: "done" | "declined", note?: string, optionId?: string) =>
      post<HumanTaskCloseResult>(`/api/human-tasks/${id}/close`, { outcome, ...(note ? { note } : {}), ...(optionId ? { optionId } : {}) }),
  },

  questions: {
    /** What agents asked and wait for; answered by writing into the chat (or with optionId / decision). */
    open: () => get<AgentQuestion[]>("/api/questions", { status: "open" }),
    /** One of optionId, decision (with an optional note) or text; the run that asked continues with it. */
    answer: (id: string, input: AnswerQuestionInput) => post<AnswerQuestionResult>(`/api/questions/${id}/answer`, input),
  },
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
