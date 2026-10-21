import { AppState, type AppStateStatus } from "react-native";
import type { InvalidateQueryFilters } from "@tanstack/react-query";
import { browserView, type Agent, type AgentQuestion, type ClientEvent, type EntityName, type ServerEvent, type Task, type TaskEvent, type Vm } from "@godmode/shared";
import { answersNow, api, ApiError, forget, reachableBase, retryAddresses } from "./api";
import { noteQueue, upsertMessage } from "./chat-cache";
import { setQueue } from "./composer";
import { withPending } from "./pending-queue";
import { useLive } from "./live";
import { primaryOf, removedBy } from "./peers";
import { qk, queryClient } from "./query";
import { useSession } from "./session";

let socket: WebSocket | null = null;
let attempt = 0;
let running = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let awayTimer: ReturnType<typeof setInterval> | null = null;
/** The computer of the group the open socket goes to. */
let socketComputer: string | null = null;
/**
 * Addresses whose socket was refused (a computer of the group that doesn't have this phone's key yet answers the
 * handshake with 401) or closed for a removed phone there: the next attempts try them after the others.
 */
const refusedSockets = new Set<string>();
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
  android: [qk.androidDevices],
  settings: [qk.bootstrap, qk.settings],
  workspaces: [qk.workspaces, qk.agents],
  tasks: [qk.tasks],
  "human-tasks": [qk.humanTasks, qk.bootstrap],
  calls: [["calls"]],
};

function sendEvent(event: ClientEvent) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

const resyncAsked = new Map<string, number>();

/** A delta didn't fit what the phone has of the run (it missed one): ask for the whole list, once a second at most. */
function resync(runId: string) {
  const now = Date.now();
  if (now - (resyncAsked.get(runId) ?? 0) < 1000) return;
  if (resyncAsked.size > 100) resyncAsked.clear();
  resyncAsked.set(runId, now);
  sendEvent({ type: "run.resync", runId });
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

/** The chat on screen while the app is in front: the computer counts it as read and doesn't notify about it. */
let viewing: string | null = null;

export function viewConversation(conversationId: string | null) {
  viewing = conversationId;
  sendView();
}

function sendView() {
  sendEvent({ type: "conversation.view", conversationId: AppState.currentState === "active" ? viewing : null });
}

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

async function catchUp(instanceId: string) {
  const token = useSession.getState().connection?.token;
  try {
    const [runs, me] = await Promise.all([api.runs.list({ status: "queued,running", limit: 50 }), api.me()]);
    useLive.getState().seedRuns(runs);
    const session = useSession.getState();
    // Paired again meanwhile: this answer is the old pairing's.
    if (session.connection?.token !== token) return;
    // Another computer of the group answered: its name and addresses aren't the paired one's.
    if (me.instance.id === session.connection?.instance.id) {
      session.setInstance(me.instance);
      // Older Godmodes don't list their addresses; the ones from pairing stay then.
      const { urls } = me as typeof me & { urls?: unknown };
      if (Array.isArray(urls)) session.setUrls(urls);
    }
    session.setGroup(me.group);
  } catch {
    /* the next reconnect tries again */
  }
  await checkPrimary(instanceId);
}

/** Whether the socket goes to another computer of the group because the primary doesn't answer. */
async function checkPrimary(instanceId: string) {
  const connection = useSession.getState().connection;
  const primary = connection ? primaryOf(connection) : undefined;
  const away = !!connection && !!primary && primary.instance.id !== instanceId && !(await answersNow(connection, primary.instance.id));
  if (socketComputer === instanceId) useLive.getState().setPrimaryAway(away);
}

/**
 * The chat lists, not the open chats: a long chat is megabytes, and refetching it on every run of every agent kept it
 * from ever loading — messages that only arrive by refetch went missing meanwhile. Each chat refreshes on its own events.
 */
const conversationLists = { queryKey: qk.conversations, predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[1] !== "detail" };

const soon = new Map<string, ReturnType<typeof setTimeout>>();

/** Refetch once a burst of events is over: a run's start, its messages and its end each touch the same lists. */
function refreshSoon(filters: InvalidateQueryFilters & { queryKey: readonly unknown[] }) {
  const id = JSON.stringify(filters.queryKey) + (filters.predicate ? ":lists" : "");
  if (soon.has(id)) return;
  soon.set(
    id,
    setTimeout(() => {
      soon.delete(id);
      // A fetch on its way started before the event: let it land (restarting it with every event could keep a slow
      // one from ever finishing), then ask again.
      if (queryClient.isFetching(filters) > 0) return refreshSoon(filters);
      void queryClient.invalidateQueries(filters);
    }, 350),
  );
}

/**
 * Patch cached lists from an event. A fetch of one that is on its way started before the event and would land without
 * it: that one is cancelled and fetched again afterwards.
 */
async function patchLists(filters: { queryKey: readonly unknown[] }, patch: () => void) {
  const fetching = queryClient.isFetching(filters) > 0;
  if (fetching) await queryClient.cancelQueries(filters);
  patch();
  if (fetching) void queryClient.invalidateQueries(filters);
}

/** A ticket from its event into every cached board it belongs on, without fetching the boards again. */
function upsertTask(task: Task) {
  queryClient.setQueryData(qk.task(task.id), task);
  for (const [key, list] of queryClient.getQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"] })) {
    if (!Array.isArray(list)) continue;
    const scope = key[2];
    const belongs = (key[3] === "archived") === !!task.archivedAt && (scope === "all" || task.workspaceId === scope);
    const at = list.findIndex((t) => t.id === task.id);
    if (!belongs) {
      if (at >= 0) queryClient.setQueryData(key, list.filter((t) => t.id !== task.id));
    } else queryClient.setQueryData(key, at >= 0 ? list.map((t) => (t.id === task.id ? task : t)) : [task, ...list]);
  }
}

function handle(event: ServerEvent) {
  const live = useLive.getState();
  switch (event.type) {
    case "run.started":
      live.runStarted(event.run);
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.run.conversationId) });
      refreshSoon(conversationLists);
      refreshSoon({ queryKey: qk.runs });
      break;
    case "run.activity":
      live.runActivity(event.runId, event.label);
      break;
    case "run.delta":
      if (!live.delta(event)) resync(event.runId);
      break;
    case "run.paused":
    case "run.finished":
      // The chat shows the stored answer before the streaming copy goes (a paused run stands still until it continues).
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.run.conversationId) }).then(() => live.runFinished(event.run));
      refreshSoon(conversationLists);
      refreshSoon({ queryKey: qk.runs });
      refreshSoon({ queryKey: qk.agents });
      refreshSoon({ queryKey: qk.bootstrap });
      break;
    case "message.created":
    case "message.updated":
      // Into the cached chat as it is; a fetch on its way gets it too (see chat-cache), so nothing is fetched again.
      upsertMessage(event.message);
      break;
    case "queue.updated":
      setQueue(event.conversationId, () => withPending(event.conversationId, event.queue));
      noteQueue(event.conversationId, event.queue);
      break;
    case "conversation.updated":
      void queryClient.invalidateQueries({ queryKey: qk.conversation(event.conversation.id) });
      refreshSoon(conversationLists);
      break;
    case "conversation.deleted":
      queryClient.removeQueries({ queryKey: qk.conversation(event.id) });
      refreshSoon(conversationLists);
      break;
    case "agent.updated":
      queryClient.setQueryData<Agent[]>(qk.agents, (old) => (old?.some((a) => a.id === event.agent.id) ? old.map((a) => (a.id === event.agent.id ? event.agent : a)) : old));
      refreshSoon({ queryKey: qk.agents });
      break;
    case "agent.deleted":
      queryClient.setQueryData<Agent[]>(qk.agents, (old) => old?.filter((a) => a.id !== event.id));
      break;
    case "task.updated":
      void patchLists({ queryKey: [...qk.tasks, "list"] }, () => upsertTask(event.task));
      refreshSoon({ queryKey: qk.bootstrap });
      break;
    case "task.event": {
      const e = event.event;
      queryClient.setQueryData<TaskEvent[]>(qk.taskEvents(e.taskId), (list) =>
        !Array.isArray(list) || list.some((x) => x.id === e.id) ? list : [...list, e].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
      break;
    }
    case "task.deleted":
      queryClient.removeQueries({ queryKey: qk.task(event.id) });
      queryClient.setQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"] }, (list) => list?.filter((t) => t.id !== event.id));
      break;
    case "routine.updated":
    case "routine.deleted":
      refreshSoon({ queryKey: qk.routines });
      break;
    case "vm.updated":
      queryClient.setQueryData<Vm[]>(qk.vms, (old) => old?.map((v) => (v.id === event.vm.id ? event.vm : v)));
      break;
    case "vm.deleted":
      queryClient.setQueryData<Vm[]>(qk.vms, (old) => old?.filter((v) => v.id !== event.id));
      break;
    case "browser.updated":
      refreshSoon({ queryKey: qk.browserProfiles });
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
      refreshSoon({ queryKey: qk.notifications });
      break;
    case "question.created":
    case "question.updated": {
      const q = event.question;
      // The lists are of open questions: a settled one leaves at once.
      queryClient.setQueriesData<AgentQuestion[]>({ queryKey: qk.questions }, (list) => {
        if (!Array.isArray(list) || !list.some((x) => x.id === q.id)) return list;
        return q.status === "open" ? list.map((x) => (x.id === q.id ? q : x)) : list.filter((x) => x.id !== q.id);
      });
      refreshSoon({ queryKey: qk.questions });
      refreshSoon({ queryKey: qk.bootstrap });
      refreshSoon({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.conversation(q.conversationId) });
      refreshSoon(conversationLists);
      break;
    }
    case "missing-login.created":
    case "missing-login.updated":
      refreshSoon({ queryKey: qk.missingLogins });
      refreshSoon({ queryKey: qk.bootstrap });
      break;
    case "vault.status":
      refreshSoon({ queryKey: qk.bootstrap });
      break;
    case "entity.changed":
      for (const key of ENTITY_KEYS[event.entity] ?? []) refreshSoon({ queryKey: key });
      break;
  }
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  if (awayTimer) clearInterval(awayTimer);
  reconnectTimer = null;
  pingTimer = null;
  awayTimer = null;
}

let connecting = false;
/** The socket was open before in this pairing: the next open is a reconnect. */
let wasOpen = false;

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
  const found = await reachableBase(connection, (id) => useLive.getState().setComputer(id), refusedSockets);
  connecting = false;
  if (!running || socket) return;
  // Paired again while this attempt looked for the computer: the new pairing's attempt was skipped, so make it now.
  if (useSession.getState().connection?.token !== connection.token) return void connect();
  if (!found || found instanceof ApiError) {
    useLive.getState().setComputer(null);
    useLive.getState().setStatus("offline", found?.message);
    scheduleReconnect();
    return;
  }
  const { base, instanceId } = found;
  const ws = new (WebSocket as unknown as new (url: string, protocols: string[] | null, options: { headers: Record<string, string> }) => WebSocket)(
    `${base.replace(/^http/, "ws")}/api/ws`,
    null,
    { headers: { authorization: `Bearer ${connection.token}` } },
  );
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    refusedSockets.clear();
    attempt = 0;
    // Another computer of the group than before: what it has may differ.
    const moved = useSession.getState().connection?.activeInstanceId !== instanceId;
    useSession.getState().setActive(base, instanceId);
    socketComputer = instanceId;
    useLive.getState().setComputer(instanceId);
    useLive.getState().setStatus("online");
    // Streaming replies as what changed, not the whole block list five times a second (megabytes in a long run).
    sendEvent({ type: "deltas.patch" });
    replaySubscriptions();
    if (viewing) sendView();
    void checkPrimary(instanceId);
    void catchUp(instanceId);
    // Events were missed while the link was down, so everything is asked again (lists are small and chats come as a
    // window). Not on the first connect to the same computer: every screen has just fetched its own.
    if (wasOpen || moved) void queryClient.invalidateQueries();
    wasOpen = true;
    pingTimer = setInterval(() => sendEvent({ type: "ping" }), 25_000);
    awayTimer = setInterval(() => void checkPrimary(instanceId), 60_000);
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
    socketComputer = null;
    clearTimers();
    // Ask again before reconnecting: the gateway may have lost the computer while Tailscale still reaches it.
    forget(base);
    useLive.getState().setStatus("offline");
    if (e.code === 4003) {
      const current = useSession.getState().connection;
      if (!current || removedBy(current, instanceId)) return void useSession.getState().disconnect("removed");
      // Another computer of the group: the paired one says whether the phone was removed.
      forget(base, true);
    }
    if (e.code === 4003 || !opened) refusedSockets.add(base);
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function onAppState(state: AppStateStatus) {
  // Pulled-down notification shade or the app switcher: the chat isn't being read meanwhile.
  if (viewing) sendView();
  if (state === "active") {
    if (running && !socket) {
      retryAddresses();
      clearTimers();
      attempt = 0;
      void connect();
    }
  } else if (state === "background" && socket) {
    const ws = socket;
    socket = null;
    socketComputer = null;
    clearTimers();
    ws.close();
    useLive.getState().setStatus("offline");
  }
}

/** Live events from the paired computer while the app is in the foreground. */
export function startRealtime(): () => void {
  running = true;
  attempt = 0;
  wasOpen = false;
  refusedSockets.clear();
  void connect();
  const sub = AppState.addEventListener("change", onAppState);
  return () => {
    running = false;
    sub.remove();
    clearTimers();
    const ws = socket;
    socket = null;
    socketComputer = null;
    ws?.close();
  };
}

/** Try right away instead of waiting for the backoff (pull to refresh, "Retry"). */
export function reconnectNow() {
  if (!running || socket) return;
  retryAddresses();
  clearTimers();
  attempt = 0;
  void connect();
}
