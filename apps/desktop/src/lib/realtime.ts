import type { QueryClient } from "@tanstack/react-query";
import type { AutomationEvent, ClientEvent, EntityName, ServerEvent } from "@godmode/shared";
import { wsUrl } from "./core";
import { useLive } from "@/stores/live";
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

const ENTITY_KEYS: Record<EntityName, readonly unknown[][]> = {
  workspaces: [qk.workspaces],
  agents: [qk.agents],
  routines: [qk.routines],
  credentials: [qk.credentials],
  totp: [qk.totp],
  "mcp-servers": [qk.mcpServers],
  composio: [qk.composio],
  "browser-profiles": [qk.browserProfiles],
  "missing-logins": [qk.missingLogins, qk.bootstrap],
  notifications: [qk.notifications, qk.bootstrap],
  settings: [qk.settings, qk.bootstrap],
  runs: [qk.runs],
  models: [qk.models],
  computer: [qk.computer],
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
    while (pendingSends.length) ws.send(JSON.stringify(pendingSends.shift()));
    // Resubscribe live views
    for (const [profileId, viewers] of browserViewers) ws.send(JSON.stringify(subscribeEvent(profileId, viewers)));
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
    case "run.started":
      live.runStarted(event.run);
      qc.invalidateQueries({ queryKey: qk.runs });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      break;
    case "run.delta":
      live.runDelta(event.runId, event.conversationId, event.messageId, event.blocks);
      break;
    case "run.activity":
      live.runActivity(event.runId, event.label);
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
    case "conversation.updated":
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.conversation(event.conversation.id) });
      break;
    case "conversation.deleted":
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      break;
    case "agent.updated":
    case "agent.deleted":
      qc.invalidateQueries({ queryKey: qk.agents });
      break;
    case "routine.updated":
    case "routine.deleted":
      qc.invalidateQueries({ queryKey: qk.routines });
      break;
    case "automation.event":
      void upsertAutomationEvent(qc, event.event);
      // Pending counts and the trigger's last event live on the routine.
      qc.invalidateQueries({ queryKey: qk.routines });
      break;
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
    case "browser.updated":
      qc.invalidateQueries({ queryKey: qk.browserProfiles });
      if (!event.profile.running) live.dropBrowserFrame(event.profile.id);
      break;
    case "browser.frame":
      live.browserFrame(event.profileId, {
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
  watching: number;
  passive: number;
}

/** Live view subscribers per profile in this UI; the core only hears about the first/last and passive changes. */
const browserViewers = new Map<string, BrowserViewers>();

function subscribeEvent(profileId: string, viewers: BrowserViewers): ClientEvent {
  return { type: "browser.subscribe", profileId, passive: viewers.watching === 0 };
}

/**
 * Subscribe to the live view of a browser profile. Passive viewers (glanceable previews) get frames without
 * keeping an idle browser running.
 */
export function subscribeBrowser(profileId: string, { passive = false }: { passive?: boolean } = {}): () => void {
  const kind = passive ? "passive" : "watching";
  const viewers = browserViewers.get(profileId) ?? { watching: 0, passive: 0 };
  const wasPassive = viewers.watching === 0;
  const isFirst = viewers.watching + viewers.passive === 0;
  viewers[kind]++;
  browserViewers.set(profileId, viewers);
  if (isFirst || wasPassive !== (viewers.watching === 0)) sendClientEvent(subscribeEvent(profileId, viewers));

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const wasPassive = viewers.watching === 0;
    viewers[kind]--;
    if (viewers.watching + viewers.passive === 0) {
      browserViewers.delete(profileId);
      sendClientEvent({ type: "browser.unsubscribe", profileId });
    } else if (wasPassive !== (viewers.watching === 0)) sendClientEvent(subscribeEvent(profileId, viewers));
  };
}
