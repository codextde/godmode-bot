import * as Device from "expo-device";
import Constants from "expo-constants";
import type {
  Agent,
  AppNotification,
  Bootstrap,
  BrowserProfile,
  ComputerInputEvent,
  Conversation,
  ConversationWithMessages,
  MissingLogin,
  MobilePairingPayload,
  MobilePairResult,
  MobileSession,
  Routine,
  Run,
  SendMessageResult,
  StartChatResult,
  Task,
  TaskStatus,
  TaskType,
  Vm,
  Workspace,
} from "@godmode/shared";
import { isPhoneUrlAllowed } from "@godmode/shared";
import { addressOrder, useSession, type Connection } from "./session";

const TIMEOUT_MS = 12_000;
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

export const OFFLINE_MESSAGE = "Can't reach your computer. Check that it's awake and Tailscale is on.";

async function send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    return new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.code);
  } catch {
    return new ApiError(res.status, `Request failed (${res.status})`);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(query?: Query): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

const verified = new Set<string>();

/**
 * Does this address answer as the paired computer? Asked (without the key) before the key goes to an address, so a
 * network that isn't Tailscale can't collect it.
 */
async function isInstance(base: string, instanceId: string): Promise<boolean> {
  const key = `${instanceId} ${base}`;
  if (verified.has(key)) return true;
  if (!isPhoneUrlAllowed(base)) return false;
  try {
    const res = await send(`${base}/api/health`, { method: "GET" }, PROBE_TIMEOUT_MS);
    const ok = res.ok && ((await res.json()) as { instance?: string }).instance === instanceId;
    if (ok) verified.add(key);
    return ok;
  } catch {
    return false;
  }
}

/** The address to use right now: the one that worked last, else the first other one that answers as the computer. */
export async function reachableBase(connection: Connection): Promise<string | null> {
  for (const base of addressOrder(connection)) {
    if (await isInstance(base, connection.instance.id)) return base;
  }
  return null;
}

function forget(base: string) {
  for (const key of verified) if (key.endsWith(` ${base}`)) verified.delete(key);
}

/**
 * Calls the paired computer. Reads fall through to its other addresses; writes are sent once, so a slow answer never
 * turns into a second message or run.
 */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, "This phone isn't paired.", "not_paired");
  const headers: Record<string, string> = { authorization: `Bearer ${connection.token}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  for (const base of addressOrder(connection)) {
    if (!(await isInstance(base, connection.instance.id))) continue;
    let res: Response;
    try {
      res = await send(base + path, { method, headers, body: payload });
    } catch {
      forget(base);
      if (method === "GET") continue;
      throw new ApiError(0, "No answer from your computer. Check whether it went through before trying again.", "timeout");
    }
    useSession.getState().setActiveUrl(base);
    if (res.status === 401) {
      await useSession.getState().disconnect("removed");
      throw new ApiError(401, "This phone was removed from Godmode.", "unauthorized");
    }
    if (!res.ok) throw await errorFrom(res);
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("application/json") ? await res.json() : await res.text()) as T;
  }
  throw new ApiError(0, OFFLINE_MESSAGE, "offline");
}

const get = <T>(path: string, query?: Query) => request<T>("GET", path + qs(query));
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

export function deviceName(): string {
  return Device.deviceName || Device.modelName || (process.env.EXPO_OS === "ios" ? "iPhone" : "Android phone");
}

/** Trade the scanned code for this phone's own token, trying each address in the code. */
export async function pairWith(payload: MobilePairingPayload): Promise<Connection> {
  if (payload.exp * 1000 < Date.now()) throw new ApiError(401, "This code has expired. Show a new one on your computer.", "pairing_invalid");
  const body = JSON.stringify({
    code: payload.code,
    name: deviceName(),
    platform: process.env.EXPO_OS === "android" ? "android" : "ios",
    model: Device.modelName ?? null,
    appVersion: Constants.expoConfig?.version ?? null,
  });
  const urls = payload.urls.filter(isPhoneUrlAllowed);
  if (!urls.length) throw new ApiError(400, "This code points somewhere Godmode doesn't send your phone's key.", "pairing_invalid");
  let offline = true;
  for (const base of urls) {
    if (!(await isInstance(base, payload.id))) continue;
    let res: Response;
    try {
      res = await send(`${base}/api/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch {
      continue;
    }
    offline = false;
    if (!res.ok) throw await errorFrom(res);
    const result = (await res.json()) as MobilePairResult;
    if (result.instance.id !== payload.id) throw new ApiError(409, "A different computer answered. Scan the code again.", "instance_mismatch");
    return {
      token: result.token,
      deviceId: result.device.id,
      deviceName: result.device.name,
      instance: result.instance,
      urls,
      activeUrl: base,
      pairedAt: result.device.createdAt,
    };
  }
  throw new ApiError(0, offline ? "Can't reach your computer. Turn on Tailscale on this phone and sign in with the same account." : OFFLINE_MESSAGE, "offline");
}

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

  agents: {
    list: () => get<Agent[]>("/api/agents"),
    get: (id: string) => get<Agent>(`/api/agents/${id}`),
  },

  conversations: {
    /** With `workspaceId`: the workspace's chats. */
    list: (q: { search?: string; limit?: number; agentId?: string; workspaceId?: string | null } = {}) => get<Conversation[]>("/api/conversations", q),
    get: (id: string) => get<ConversationWithMessages>(`/api/conversations/${id}`),
    send: (id: string, content: string) => post<SendMessageResult>(`/api/conversations/${id}/messages`, { content }),
    update: (id: string, input: { title?: string; pinned?: boolean; archived?: boolean }) => patch<Conversation>(`/api/conversations/${id}`, input),
    delete: (id: string) => del<{ ok: true }>(`/api/conversations/${id}`),
    /** Continue the chat's paused run where it stopped. */
    continue: (id: string) => post<Run>(`/api/conversations/${id}/continue`),
  },

  chat: {
    /** With `workspaceId`: a global agent's chat belongs to that workspace. */
    start: (input: { agentId?: string; content: string; workspaceId?: string | null }) => post<StartChatResult>("/api/chat", input),
  },

  tasks: {
    /** `workspaceId`: a workspace's board, or all of them when omitted. */
    list: (q: { workspaceId?: string | null } = {}) => get<Task[]>("/api/tasks", q),
    get: (id: string) => get<Task>(`/api/tasks/${id}`),
    /** With an agent (and no status) the task goes to To do and the agent starts right away. */
    create: (input: { workspaceId: string | null; title: string; description?: string; type?: TaskType; status?: TaskStatus; agentId?: string | null }) =>
      post<Task>("/api/tasks", input),
    /** Moving to To do starts the agent; moving away from In progress stops it. Archived tasks are off the board. */
    update: (id: string, input: { title?: string; description?: string; status?: TaskStatus; agentId?: string | null; archived?: boolean }) =>
      patch<Task>(`/api/tasks/${id}`, input),
    /** Feedback for the agent in the task's chat; the task goes back to work. */
    message: (id: string, content: string) => post<Task>(`/api/tasks/${id}/messages`, { content }),
  },

  runs: {
    list: (q: { status?: string; limit?: number; agentId?: string } = {}) => get<Run[]>("/api/runs", q),
    cancel: (id: string) => post<{ ok: true }>(`/api/runs/${id}/cancel`),
  },

  routines: {
    list: (q: { agentId?: string } = {}) => get<Routine[]>("/api/routines", q),
    run: (id: string) => post<Run>(`/api/routines/${id}/run`),
    setEnabled: (id: string, enabled: boolean) => patch<Routine>(`/api/routines/${id}`, { enabled }),
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
  },

  notifications: {
    list: () => get<AppNotification[]>("/api/notifications", { limit: 30 }),
  },

  missingLogins: {
    open: () => get<MissingLogin[]>("/api/missing-logins", { status: "open" }),
  },
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
