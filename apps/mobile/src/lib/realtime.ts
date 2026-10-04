import { AppState, type AppStateStatus } from "react-native";
import { browserView, type ClientEvent, type EntityName, type ServerEvent, type Vm } from "@godmode/shared";
import { api, reachableBase } from "./api";
import { useLive } from "./live";
import { qk, queryClient } from "./query";
import { useSession } from "./session";

let socket: WebSocket | null = null;
let attempt = 0;
let running = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
const counts = new Map<string, number>();

const ENTITY_KEYS: Partial<Record<EntityName, readonly (readonly unknown[])[]>> = {
  agents: [qk.agents],
  routines: [qk.routines],
  "browser-profiles": [qk.browserProfiles],
  "missing-logins": [qk.missingLogins, qk.bootstrap],
  questions: [qk.questions, qk.bootstrap],
  notifications: [qk.notifications, qk.bootstrap],
  runs: [qk.runs],
  vms: [qk.vms],
  settings: [qk.bootstrap],
  workspaces: [qk.workspaces, qk.agents],
  tasks: [qk.tasks],
};

function sendEvent(event: ClientEvent) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

/** Ref-counted subscription (browser/computer live views, open chats), replayed after every reconnect. */
function subscription(key: string, on: ClientEvent, off: ClientEvent): () => void {
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  if (n === 1) sendEvent(on);
  return () => {
    const left = (counts.get(key) ?? 1) - 1;
    if (left > 0) return void counts.set(key, left);
    counts.delete(key);
    sendEvent(off);
    if (!key.startsWith("conversation:")) useLive.getState().dropFrame(key);
  };
}

/** A browser's live view: its active tab, or with `conversationId` that chat's own tab. */
export const subscribeBrowser = (profileId: string, conversationId: string | null = null) =>
  subscription(
    `browser:${browserView(profileId, conversationId)}`,
    { type: "browser.subscribe", profileId, passive: true, ...(conversationId ? { conversationId } : {}) },
    { type: "browser.unsubscribe", profileId, ...(conversationId ? { conversationId } : {}) },
  );

export const subscribeComputer = (view: string) =>
  subscription(`computer:${view}`, { type: "computer.subscribe", view }, { type: "computer.unsubscribe", view });

export const subscribeConversation = (conversationId: string) =>
  subscription(`conversation:${conversationId}`, { type: "conversation.subscribe", conversationId }, { type: "conversation.unsubscribe", conversationId });

function replaySubscriptions() {
  for (const key of counts.keys()) {
    const [kind, ...rest] = key.split(":");
    const id = rest.join(":");
    if (kind === "browser") {
      const [profileId, conversationId] = id.split(":");
      sendEvent({ type: "browser.subscribe", profileId: profileId!, passive: true, ...(conversationId ? { conversationId } : {}) });
    }
    else if (kind === "computer") sendEvent({ type: "computer.subscribe", view: id });
    else if (kind === "conversation") sendEvent({ type: "conversation.subscribe", conversationId: id });
  }
}

async function catchUp() {
  try {
    const [runs, me] = await Promise.all([api.runs.list({ status: "queued,running", limit: 50 }), api.me()]);
    useLive.getState().seedRuns(runs);
    useSession.getState().setInstance(me.instance);
  } catch {
    /* the next reconnect tries again */
  }
}

function handle(event: ServerEvent) {
  const live = useLive.getState();
  switch (event.type) {
    case "run.started":
      live.runStarted(event.run);
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      break;
    case "run.activity":
      live.runActivity(event.runId, event.label);
      break;
    case "run.delta":
      live.delta(event.conversationId, { runId: event.runId, messageId: event.messageId, blocks: event.blocks });
      break;
    case "run.paused":
      // It stands still: nothing works in the chat until it continues.
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.run.conversationId) }).then(() => live.runFinished(event.run));
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      break;
    case "run.finished":
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.run.conversationId) }).then(() => live.runFinished(event.run));
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "message.created":
    case "message.updated":
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.message.conversationId) });
      break;
    case "conversation.updated":
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      break;
    case "conversation.deleted":
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      break;
    case "agent.updated":
    case "agent.deleted":
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      break;
    case "task.updated":
      queryClient.setQueryData(qk.task(event.task.id), event.task);
      void queryClient.invalidateQueries({ queryKey: [...qk.tasks, "list"] });
      break;
    case "task.deleted":
      queryClient.removeQueries({ queryKey: qk.task(event.id) });
      void queryClient.invalidateQueries({ queryKey: qk.tasks });
      break;
    case "routine.updated":
    case "routine.deleted":
      void queryClient.invalidateQueries({ queryKey: qk.routines });
      break;
    case "vm.updated":
      queryClient.setQueryData<Vm[]>(qk.vms, (old) => old?.map((v) => (v.id === event.vm.id ? event.vm : v)));
      break;
    case "vm.deleted":
      queryClient.setQueryData<Vm[]>(qk.vms, (old) => old?.filter((v) => v.id !== event.id));
      break;
    case "browser.updated":
      void queryClient.invalidateQueries({ queryKey: qk.browserProfiles });
      break;
    case "browser.frame":
      live.frame(`browser:${browserView(event.profileId, event.conversationId)}`, {
        data: event.data,
        mime: "image/jpeg",
        width: event.width,
        height: event.height,
        title: event.title,
        url: event.url,
        at: Date.now(),
      });
      break;
    case "computer.frame":
      live.frame(`computer:${event.view}`, {
        data: event.data,
        mime: event.mime,
        width: event.width,
        height: event.height,
        title: event.label,
        error: event.error,
        at: Date.now(),
      });
      break;
    case "notification":
      void queryClient.invalidateQueries({ queryKey: qk.notifications });
      break;
    case "question.created":
    case "question.updated":
      void queryClient.invalidateQueries({ queryKey: qk.questions });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.question.conversationId) });
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      break;
    case "missing-login.created":
    case "missing-login.updated":
      void queryClient.invalidateQueries({ queryKey: qk.missingLogins });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "vault.status":
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "entity.changed":
      for (const key of ENTITY_KEYS[event.entity] ?? []) void queryClient.invalidateQueries({ queryKey: key });
      break;
  }
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
}

let connecting = false;

function scheduleReconnect() {
  if (!running) return;
  attempt++;
  reconnectTimer = setTimeout(() => void connect(), Math.min(15_000, 600 * 2 ** Math.min(attempt, 5)));
}

async function connect() {
  const connection = useSession.getState().connection;
  if (!running || !connection || socket || connecting) return;
  connecting = true;
  useLive.getState().setStatus("connecting");
  const base = await reachableBase(connection);
  connecting = false;
  if (!running || socket) return;
  // Paired again while this attempt looked for the computer: the new pairing's attempt was skipped, so make it now.
  if (useSession.getState().connection?.token !== connection.token) return void connect();
  if (!base) {
    useLive.getState().setStatus("offline");
    scheduleReconnect();
    return;
  }
  const ws = new (WebSocket as unknown as new (url: string, protocols: string[] | null, options: { headers: Record<string, string> }) => WebSocket)(
    `${base.replace(/^http/, "ws")}/api/ws`,
    null,
    { headers: { authorization: `Bearer ${connection.token}` } },
  );
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    useSession.getState().setActiveUrl(base);
    useLive.getState().setStatus("online");
    replaySubscriptions();
    void catchUp();
    void queryClient.invalidateQueries();
    pingTimer = setInterval(() => sendEvent({ type: "ping" }), 25_000);
  };
  ws.onmessage = (msg) => {
    try {
      handle(JSON.parse(String(msg.data)) as ServerEvent);
    } catch {
      /* not an event */
    }
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = null;
    clearTimers();
    useLive.getState().setStatus("offline");
    if (e.code === 4003) {
      void useSession.getState().disconnect("removed");
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function onAppState(state: AppStateStatus) {
  if (state === "active") {
    if (running && !socket) {
      clearTimers();
      attempt = 0;
      void connect();
    }
  } else if (state === "background" && socket) {
    const ws = socket;
    socket = null;
    clearTimers();
    ws.close();
    useLive.getState().setStatus("offline");
  }
}

/** Live events from the paired computer while the app is in the foreground. */
export function startRealtime(): () => void {
  running = true;
  attempt = 0;
  void connect();
  const sub = AppState.addEventListener("change", onAppState);
  return () => {
    running = false;
    sub.remove();
    clearTimers();
    const ws = socket;
    socket = null;
    ws?.close();
  };
}

/** Try right away instead of waiting for the backoff (pull to refresh, "Retry"). */
export function reconnectNow() {
  if (!running || socket) return;
  clearTimers();
  attempt = 0;
  void connect();
}
