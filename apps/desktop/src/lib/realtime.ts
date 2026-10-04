import type { QueryClient } from "@tanstack/react-query";
import { browserView, type AgentQuestion, type AutomationEvent, type BrowserProfile, type ClientEvent, type ConversationWithMessages, type EntityName, type RemoteRunner, type ServerEvent, type Task, type TaskEvent, type Vm } from "@godmode/shared";
import { wsUrl } from "./core";
import { useLive } from "@/stores/live";
import { withPending } from "./pending-queue";
import { qk } from "./queryKeys";

type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();

let socket: WebSocket | null = null;
let retry = 0;
let stopped = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;
const pendingSends: ClientEvent[] = [];

/** Subscribe to raw server events (returns unsubscribe). */
export function onServerEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sendClientEvent(event: ClientEvent) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  else pendingSends.push(event);
}

/** A delta didn't fit what this client has of the run (it missed one): ask for the whole list, once a second at most. */
const resyncAsked = new Map<string, number>();

function resync(runId: string) {
  const now = Date.now();
  if (now - (resyncAsked.get(runId) ?? 0) < 1000) return;
  if (resyncAsked.size > 100) resyncAsked.clear();
  resyncAsked.set(runId, now);
  sendClientEvent({ type: "run.resync", runId });
}

const ENTITY_KEYS: Record<EntityName, readonly unknown[][]> = {
  workspaces: [qk.workspaces],
  agents: [qk.agents],
  routines: [qk.routines],
  credentials: [qk.credentials],
  totp: [qk.totp],
  "mcp-servers": [qk.mcpServers],
  "api-tools": [qk.apiTools],
  composio: [qk.composio],
  "browser-profiles": [qk.browserProfiles],
  "missing-logins": [qk.missingLogins, qk.bootstrap],
  questions: [qk.questions, qk.bootstrap],
  notifications: [qk.notifications, qk.bootstrap],
  settings: [qk.settings, qk.bootstrap],
  runs: [qk.runs],
  models: [qk.models],
  computer: [qk.computer],
  // VM list + status (installs, image downloads, assignment changes).
  vms: [qk.vms],
  "ssh-servers": [qk.sshServers],
  // Bot status, access requests and chats (the sidebar badge counts requests).
  messaging: [qk.messaging, qk.bootstrap],
  tasks: [qk.tasks],
  // A phone was paired, removed, or connected.
  mobile: [qk.mobile],
  // An app was connected, removed, or called a tool.
  connectors: [qk.connectors],
  // A runner was paired, removed, or its chats changed.
  runners: [qk.runners],
  // Cloud link state, plan or billing changed (linking approved, link up or down, notice from the cloud).
  cloud: [qk.cloud, qk.cloudBilling],
  // A finished or undone dream rewrote the memory files.
  dreams: [qk.dreams, qk.agentFilesAll, qk.agentFileAll, qk.agentCommitsAll],
  followups: [qk.followups],
  // The background upkeep repaired or updated a tool: system check, permissions, updates.
  system: [qk.doctor],
};

export function startRealtime(queryClient: QueryClient) {
  stopped = false;
  void connect(queryClient);
  return () => {
    stopped = true;
    socket?.close();
    socket = null;
    if (pingTimer) clearInterval(pingTimer);
  };
}

async function connect(queryClient: QueryClient) {
  if (stopped) return;
  let url: string;
  try {
    url = await wsUrl();
  } catch {
    scheduleReconnect(queryClient);
    return;
  }
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    useLive.getState().setConnected(true);
    // Streaming replies as what changed instead of the whole block list every time.
    ws.send(JSON.stringify({ type: "deltas.patch" } satisfies ClientEvent));
    while (pendingSends.length) ws.send(JSON.stringify(pendingSends.shift()));
    // Resubscribe live views
    for (const viewers of browserViewers.values()) ws.send(JSON.stringify(subscribeEvent(viewers)));
    for (const view of computerViewers.keys()) ws.send(JSON.stringify({ type: "computer.subscribe", view } satisfies ClientEvent));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 25_000);
    // Refresh everything after a reconnect — we may have missed events.
    void queryClient.invalidateQueries();
  };
  ws.onmessage = (msg) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(msg.data as string);
    } catch {
      return;
    }
    handle(queryClient, event);
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
  };
  ws.onclose = () => {
    useLive.getState().setConnected(false);
    if (pingTimer) clearInterval(pingTimer);
    if (socket === ws) socket = null;
    scheduleReconnect(queryClient);
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect(queryClient: QueryClient) {
  if (stopped) return;
  const delay = Math.min(10_000, 500 * 2 ** retry++);
  setTimeout(() => void connect(queryClient), delay);
}

function handle(qc: QueryClient, event: ServerEvent) {
  const live = useLive.getState();
  switch (event.type) {
    case "hello":
      // A run.started for each active run follows; whatever else still looks live ended while we were away.
      if (event.activeRunIds) live.retainRuns(event.activeRunIds);
      break;
    case "run.started":
      live.runStarted(event.run);
      qc.invalidateQueries({ queryKey: qk.runs });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "run.delta":
      if (!live.runDelta(event)) resync(event.runId);
      break;
    case "run.activity":
      live.runActivity(event.runId, event.label);
      break;
    case "run.paused":
      live.runPaused(event.run);
      qc.invalidateQueries({ queryKey: qk.conversation(event.run.conversationId) });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.runs });
      qc.invalidateQueries({ queryKey: qk.agents });
      break;
    case "run.finished":
      live.runFinished(event.run);
      qc.invalidateQueries({ queryKey: qk.conversation(event.run.conversationId) });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.runs });
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "message.created":
    case "message.updated":
      qc.invalidateQueries({ queryKey: qk.conversation(event.message.conversationId) });
      break;
    case "queue.updated": {
      const key = qk.conversation(event.conversationId);
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, queue: withPending(event.conversationId, event.queue) } : old));
      // A fetch that started before this change must not bring the old queue back.
      qc.invalidateQueries({ queryKey: key });
      break;
    }
    case "conversation.updated":
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.conversation(event.conversation.id) });
      // Follow-ups show the chat's title.
      qc.invalidateQueries({ queryKey: qk.followups });
      break;
    case "conversation.deleted":
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.followups });
      break;
    case "agent.updated":
    case "agent.deleted":
      qc.invalidateQueries({ queryKey: qk.agents });
      if (event.type === "agent.deleted") qc.invalidateQueries({ queryKey: qk.followups });
      break;
    case "routine.updated":
    case "routine.deleted":
      qc.invalidateQueries({ queryKey: qk.routines });
      break;
    case "task.updated":
      upsertTask(qc, event.task);
      break;
    case "task.event": {
      // Merged into the cached timeline; the human's own message replaces its pending row.
      const e = event.event;
      qc.setQueryData<TaskEvent[]>(qk.taskEvents(e.taskId), (list) => {
        if (!Array.isArray(list) || list.some((x) => x.id === e.id)) return list;
        let rest = list;
        if (e.kind === "feedback") {
          const pending = list.findIndex((x) => x.id.startsWith("pending-") && x.body === e.body);
          if (pending >= 0) rest = list.filter((_, i) => i !== pending);
        }
        const real = rest.filter((x) => !x.id.startsWith("pending-"));
        const pending = rest.filter((x) => x.id.startsWith("pending-"));
        return [...real, e].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).concat(pending);
      });
      break;
    }
    case "task.deleted":
      qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.filter((t) => t.id !== event.id));
      break;
    case "automation.event":
      void upsertAutomationEvent(qc, event.event);
      // Pending counts and the trigger's last event live on the routine.
      qc.invalidateQueries({ queryKey: qk.routines });
      break;
    case "question.created":
    case "question.updated": {
      const q = event.question;
      // Seed the lists from the event so cards don't wait for a refetch.
      qc.setQueriesData<AgentQuestion[]>({ queryKey: qk.questions }, (list) => {
        if (!Array.isArray(list)) return list;
        return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : list;
      });
      qc.invalidateQueries({ queryKey: qk.questions });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      qc.invalidateQueries({ queryKey: qk.conversation(q.conversationId) });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.tasks });
      break;
    }
    case "missing-login.created":
    case "missing-login.updated":
      qc.invalidateQueries({ queryKey: qk.missingLogins });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "notification":
      qc.invalidateQueries({ queryKey: qk.notifications });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "vault.status":
      qc.setQueryData(qk.vaultStatus, event.status);
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "browser.updated": {
      // Frequent while chats browse (tabs and titles change): update in place instead of refetching.
      const known = qc.getQueryData<BrowserProfile[]>(qk.browserProfiles);
      if (known?.some((p) => p.id === event.profile.id)) {
        qc.setQueryData(qk.browserProfiles, known.map((p) => (p.id === event.profile.id ? event.profile : p)));
      } else qc.invalidateQueries({ queryKey: qk.browserProfiles });
      if (!event.profile.running) live.dropBrowserFrame(event.profile.id);
      break;
    }
    case "browser.frame":
      live.browserFrame(browserView(event.profileId, event.conversationId), {
        data: event.data,
        url: event.url,
        title: event.title,
        width: event.width,
        height: event.height,
        at: Date.now(),
      });
      break;
    case "computer.frame":
      live.computerFrame(event.view, {
        data: event.data,
        mime: event.mime,
        width: event.width,
        height: event.height,
        label: event.label,
        ...(event.error ? { error: event.error } : {}),
        at: Date.now(),
      });
      break;
    case "computer.action":
      live.computerAction(event.view, { runId: event.runId, action: event.action, x: event.x, y: event.y, at: Date.now() });
      break;
    case "vm.updated":
      void upsertVm(qc, event.vm);
      break;
    case "vm.deleted":
      qc.setQueryData<Vm[]>(qk.vmList, (old) => (Array.isArray(old) ? old.filter((v) => v.id !== event.id) : old));
      qc.invalidateQueries({ queryKey: qk.vmStatus });
      break;
    case "runner.updated":
      void upsertRunner(qc, event.runner);
      break;
    case "runner.deleted":
      qc.setQueryData<RemoteRunner[]>(qk.runners, (old) => (Array.isArray(old) ? old.filter((r) => r.id !== event.id) : old));
      qc.removeQueries({ queryKey: qk.runnerHealth(event.id) });
      // Its chats stay, as ordinary chats of this computer.
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      break;
    case "runner.paired":
      qc.invalidateQueries({ queryKey: qk.runners });
      break;
    case "entity.changed":
      for (const key of ENTITY_KEYS[event.entity] ?? []) qc.invalidateQueries({ queryKey: key });
      break;
  }
}

/** Newest first; the id breaks ties so the order is stable. */
function newestFirst(a: AutomationEvent, b: AutomationEvent): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Merge an event into a cached page of `limit` events (see qk.automationEventList). */
function mergeEvent(old: AutomationEvent[] | undefined, event: AutomationEvent, limit: number): AutomationEvent[] | undefined {
  if (!Array.isArray(old)) return old;
  if (old.some((e) => e.id === event.id)) return old.map((e) => (e.id === event.id ? event : e));
  // A full page ends where the server cut it: an older event (e.g. a status update of one) isn't on it.
  const last = old[old.length - 1];
  if (old.length >= limit && last && newestFirst(event, last) > 0) return old;
  return [event, ...old].sort(newestFirst).slice(0, limit);
}

/** Patch the event into every cached list that shows it (per automation, or "all"). */
async function upsertAutomationEvent(qc: QueryClient, event: AutomationEvent) {
  const filters = {
    queryKey: qk.automationEvents,
    predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[1] === "list" && (q.queryKey[2] === "all" || q.queryKey[2] === event.routineId),
  };
  // A refetch that started before the event would land without it; cancel it, patch, and refetch when next needed.
  await qc.cancelQueries(filters);
  for (const query of qc.getQueryCache().findAll(filters)) {
    const limit = typeof query.queryKey[3] === "number" ? query.queryKey[3] : Infinity;
    qc.setQueryData<AutomationEvent[]>(query.queryKey, (old) => mergeEvent(old, event, limit));
  }
  void qc.invalidateQueries({ ...filters, refetchType: "none" });
}

/**
 * Patch a VM into the cached list in place: image downloads report progress every second, which must not refetch the
 * list each time. The status (running count, downloaded images) only changes with the state, so it refreshes then.
 */
async function upsertVm(qc: QueryClient, vm: Vm) {
  const old = qc.getQueryData<Vm[]>(qk.vmList);
  const prev = Array.isArray(old) ? old.find((v) => v.id === vm.id) : undefined;
  if (!prev || prev.state !== vm.state) void qc.invalidateQueries({ queryKey: qk.vmStatus });
  if (!Array.isArray(old)) {
    void qc.invalidateQueries({ queryKey: qk.vmList });
    return;
  }
  // A list fetch that started before this event would land without it: cancel it, patch, and fetch again (the cancelled
  // one may have carried other changes, e.g. assignments).
  const fetching = qc.isFetching({ queryKey: qk.vmList }) > 0;
  if (fetching) await qc.cancelQueries({ queryKey: qk.vmList });
  qc.setQueryData<Vm[]>(qk.vmList, (list) => {
    if (!Array.isArray(list)) return list;
    return list.some((v) => v.id === vm.id) ? list.map((v) => (v.id === vm.id ? vm : v)) : [...list, vm];
  });
  if (fetching) void qc.invalidateQueries({ queryKey: qk.vmList });
}

/**
 * Patch a runner into the cached list in place: its connection, latency and sync progress change often, which must not
 * refetch the list each time. Only the list itself is touched — the health reports live under the same key prefix.
 */
export async function upsertRunner(qc: QueryClient, runner: RemoteRunner) {
  const list = { queryKey: qk.runners, exact: true };
  if (!Array.isArray(qc.getQueryData<RemoteRunner[]>(qk.runners))) {
    void qc.invalidateQueries(list);
    return;
  }
  // A list fetch that started before this change would land without it: cancel it, patch, and fetch again.
  const fetching = qc.isFetching(list) > 0;
  if (fetching) await qc.cancelQueries(list);
  qc.setQueryData<RemoteRunner[]>(qk.runners, (old) => {
    if (!Array.isArray(old)) return old;
    return old.some((r) => r.id === runner.id) ? old.map((r) => (r.id === runner.id ? runner : r)) : [...old, runner];
  });
  if (fetching) void qc.invalidateQueries(list);
}

/** Computer live view subscribers per view in this UI; the core only hears about the first and the last. */
const computerViewers = new Map<string, number>();

/** Subscribe to a computer live view ("display:1", "window:<pid>:<id>", "tab:<profile>:<target>"). */
export function subscribeComputer(view: string): () => void {
  const count = computerViewers.get(view) ?? 0;
  computerViewers.set(view, count + 1);
  if (count === 0) sendClientEvent({ type: "computer.subscribe", view });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const left = (computerViewers.get(view) ?? 1) - 1;
    if (left > 0) computerViewers.set(view, left);
    else {
      computerViewers.delete(view);
      sendClientEvent({ type: "computer.unsubscribe", view });
      useLive.getState().dropComputerView(view);
    }
  };
}

interface BrowserViewers {
  profileId: string;
  conversationId: string | null;
  watching: number;
  passive: number;
}

/** Live view subscribers per view in this UI; the core only hears about the first/last and passive changes. */
const browserViewers = new Map<string, BrowserViewers>();

function subscribeEvent({ profileId, conversationId, watching }: BrowserViewers): ClientEvent {
  return { type: "browser.subscribe", profileId, ...(conversationId ? { conversationId } : {}), passive: watching === 0 };
}

/**
 * Subscribe to the live view of a browser profile — with `conversationId`, of the tab that chat works in. Passive
 * viewers (glanceable previews) get frames without keeping an idle browser running.
 */
export function subscribeBrowser(
  profileId: string,
  { passive = false, conversationId = null }: { passive?: boolean; conversationId?: string | null } = {},
): () => void {
  const kind = passive ? "passive" : "watching";
  const view = browserView(profileId, conversationId);
  const viewers = browserViewers.get(view) ?? { profileId, conversationId, watching: 0, passive: 0 };
  const wasPassive = viewers.watching === 0;
  const isFirst = viewers.watching + viewers.passive === 0;
  viewers[kind]++;
  browserViewers.set(view, viewers);
  if (isFirst || wasPassive !== (viewers.watching === 0)) sendClientEvent(subscribeEvent(viewers));

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const wasPassive = viewers.watching === 0;
    viewers[kind]--;
    if (viewers.watching + viewers.passive === 0) {
      browserViewers.delete(view);
      sendClientEvent({ type: "browser.unsubscribe", profileId, ...(conversationId ? { conversationId } : {}) });
    } else if (wasPassive !== (viewers.watching === 0)) sendClientEvent(subscribeEvent(viewers));
  };
}

/**
 * Patch every cached task list the task belongs to: the board's or the archive's (second key segment), of its scope
 * (third: all, global or a workspace id).
 */
export function upsertTask(qc: QueryClient, task: Task) {
  for (const [key, list] of qc.getQueriesData<Task[]>({ queryKey: qk.tasks })) {
    if (!list) continue;
    const scope = key[2];
    const belongs =
      (key[1] === "archived") === !!task.archivedAt &&
      (scope === "all" || (scope === "global" ? task.workspaceId === null : task.workspaceId === scope));
    const idx = list.findIndex((t) => t.id === task.id);
    if (!belongs) {
      if (idx >= 0) qc.setQueryData(key, list.filter((t) => t.id !== task.id));
      continue;
    }
    qc.setQueryData(key, idx >= 0 ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task]);
  }
}
