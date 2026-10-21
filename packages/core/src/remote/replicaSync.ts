/**
 * Moving the shared data between the computers of a device group (owner: remote). Each computer pulls what the other
 * changed (replica.ts) when their link comes up, a moment after the other says something changed, and once a minute.
 * A secondary pulls from its primary; the primary from every secondary. What a pull brings is written here as the
 * other computer's, so it is never sent back to it.
 */
import { refreshAgentFiles, trashAgentRepo } from "../agents/service";
import { bus } from "../events/bus";
import { logger } from "../log";
import { refreshMobileAccess } from "../mobile/access";
import { computerName } from "../mobile/devices";
import { reloadSchedules } from "../scheduler/scheduler";
import { notify } from "../services/notifications";
import { applyRuntimeSettings } from "../services/runtime";
import { getSettings, resetSettingsCache, updateSettings } from "../services/settings";
import { ticketsArrived } from "../tasks/service";
import { get, getMeta, setMeta } from "../db";
import { groupRole, isSecondary, primaryRunnerId } from "./group";
import {
  type ApplyResult,
  type ReplicaPage,
  announce,
  applyChanges,
  emptyApplyResult,
  ensureReplica,
  mergeResults,
  pendingFor,
  pruneTombstones,
  replicaPulledKey,
  replicaSeq,
  retryDeferred,
} from "./replica";
import { link, listRunners, runnerRow } from "./runners";

const log = logger("replica");

const PULL_EVERY_MS = 60_000;
const HINT_DELAY_MS = 300;
const WATCH_MS = 1_500;
const MAX_PAGES = 200;
const PHONE_ON_META = "link.group.phoneAccessOn";

const chains = new Map<string, Promise<ApplyResult | null>>();
const hintTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** When each computer was last pulled completely (ms). */
const pulledAt = new Map<string, number>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let lastSeq = 0;
let fetchChat: ((peer: string, conversationId: string) => void) | null = null;
let infoChanged: ((peer: string) => Promise<void>) | null = null;

/** Computers this one exchanges the shared data with: its primary, or (on the primary) every secondary. */
function peers(): string[] {
  const role = groupRole();
  if (!role) return [];
  if (role === "secondary") {
    const id = primaryRunnerId();
    return id ? [id] : [];
  }
  return listRunners()
    .filter((r) => r.kind === "device")
    .map((r) => r.id);
}

function fromPrimary(peer: string): boolean {
  return isSecondary() && peer === primaryRunnerId();
}

/**
 * Pull what `peer` changed since the last pull and write it here. One pull per computer at a time; a pull asked for
 * while one runs waits for it and then runs too (so nothing told meanwhile is missed). Null when it can't be reached.
 */
export function pullFrom(peer: string): Promise<ApplyResult | null> {
  const previous = chains.get(peer) ?? Promise.resolve(null);
  const next = previous.then(
    () => pullNow(peer),
    () => pullNow(peer),
  );
  chains.set(
    peer,
    next.catch(() => null),
  );
  return next;
}

async function pullNow(peer: string): Promise<ApplyResult | null> {
  const r = runnerRow(peer);
  if (!r || r.kind !== "device" || !groupRole()) return null;
  let l: ReturnType<typeof link>;
  try {
    l = link(peer);
    if (l.state.state !== "online") return null;
  } catch {
    return null;
  }
  ensureReplica();
  const primary = fromPrimary(peer);
  const opts = { peerWinsTies: primary, onMissing: (table: string, id: string) => missing(peer, table, id) };
  const total = emptyApplyResult();
  let after = Number(getMeta(replicaPulledKey(peer)) ?? 0);
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await l.json<ReplicaPage>("GET", `/api/link/replica/changes?after=${after}&setup=${primary ? 0 : 1}`, undefined, { timeoutMs: 120_000 });
    if (!res || !Array.isArray(res.changes) || typeof res.last !== "number") break;
    if (res.changes.length) mergeResults(total, applyChanges(peer, res.changes, opts));
    after = Math.max(after, res.last);
    setMeta(replicaPulledKey(peer), String(after));
    if (!res.more) break;
  }
  // Says how far this computer got: the other one counts what is still waiting for it from there.
  await l.json("POST", "/api/link/replica/ack", { after }, { timeoutMs: 30_000 }).catch(() => undefined);
  mergeResults(total, retryDeferred(peer, opts));
  // What it says about itself can change between connects (phone access switched on there).
  await infoChanged?.(peer).catch(() => undefined);
  pulledAt.set(peer, Date.now());
  if (total.applied || total.failed) log.info("took changes from another computer", { peer: r.name, applied: total.applied, kept: total.kept, deferred: total.deferred, failed: total.failed });
  await afterApply(r.name, total);
  return total;
}

/** A change points at a chat this computer doesn't have yet: the mirror fetches it, then the change is tried again. */
function missing(peer: string, table: string, id: string): void {
  if (table === "conversations") fetchChat?.(peer, id);
}

/** What the written changes mean beyond the rows: agent files, schedules, tickets, phones, the UI. */
async function afterApply(from: string, result: ApplyResult): Promise<void> {
  if (!result.applied) return;
  for (const gone of result.removedAgents) {
    await trashAgentRepo(gone).catch((err) => log.warn(`could not move the files of removed agent ${gone.slug} to the trash`, err));
  }
  for (const agentId of result.agents) {
    await refreshAgentFiles(agentId, `Changes from ${from}`).catch((err) => log.warn(`could not write the files of agent ${agentId}`, err));
  }
  if (result.keys.settings?.length) {
    resetSettingsCache();
    applyRuntimeSettings(getSettings());
  }
  if (result.keys.routines?.length) reloadSchedules();
  if (result.keys.tasks?.length) ticketsArrived([...new Set(result.keys.tasks)]);
  if (result.keys.mobile_devices?.some((id) => get("SELECT 1 FROM mobile_devices WHERE id = ?", id))) phonesArrived(from);
  announce(result);
}

/** A phone paired with another computer of the group: it works with this one too once phone access is on here. */
function phonesArrived(from: string): void {
  const settings = getSettings();
  // Once: a computer whose phone access the human switched off afterwards keeps it off.
  if (settings.mobile.enabled || getMeta(PHONE_ON_META)) return;
  setMeta(PHONE_ON_META, "1");
  try {
    applyRuntimeSettings(updateSettings({ mobile: { enabled: true } } as never));
    // Listening now: the other computers learn where phones reach this one (their next pull asks), and tell the phones.
    void refreshMobileAccess()
      .catch(() => undefined)
      .then(() => bus.emit({ type: "replica.changed", seq: replicaSeq() }));
    notify("info", "Your phone works with this computer too", `It was paired on ${from}. When that computer is away, the Godmode app on your phone connects to ${computerName()}.`, "/settings/phone");
  } catch (err) {
    log.warn("could not switch phone access on for a phone of the group", err);
  }
}

/** The other computer says something changed there: pull in a moment (a burst of changes is one pull). */
export function replicaHint(peer: string): void {
  if (hintTimers.has(peer)) return;
  const timer = setTimeout(() => {
    hintTimers.delete(peer);
    void pullFrom(peer).catch((err) => log.info("could not pull changes", { peer, error: err instanceof Error ? err.message : String(err) }));
  }, HINT_DELAY_MS);
  timer.unref?.();
  hintTimers.set(peer, timer);
}

/** When `peer` was last pulled completely (ms since epoch), or null. */
export function lastPulled(peer: string): number | null {
  return pulledAt.get(peer) ?? null;
}

/** Changes made here that no other computer of the group has taken yet. */
export function pendingChanges(): number {
  const list = peers();
  return list.length ? Math.max(...list.map(pendingFor)) : 0;
}

/**
 * `chat`: asks the computer a change came from for a chat it points at (the mirror). Watches this computer's own
 * changes and tells the others (`replica.changed` goes to the linked computers only), and pulls once a minute.
 */
export function startReplicaSync(opts: { fetchChat: (peer: string, conversationId: string) => void; refreshInfo: (peer: string) => Promise<void> }): void {
  fetchChat = opts.fetchChat;
  infoChanged = opts.refreshInfo;
  ensureReplica();
  lastSeq = replicaSeq();
  watchTimer ??= setInterval(() => {
    if (!groupRole()) return;
    const n = replicaSeq();
    if (n === lastSeq) return;
    lastSeq = n;
    bus.emit({ type: "replica.changed", seq: n });
  }, WATCH_MS);
  watchTimer.unref?.();
  pullTimer ??= setInterval(() => {
    pruneTombstones(peers());
    for (const peer of peers()) void pullFrom(peer).catch(() => undefined);
  }, PULL_EVERY_MS);
  pullTimer.unref?.();
}

export function stopReplicaSync(): void {
  if (watchTimer) clearInterval(watchTimer);
  if (pullTimer) clearInterval(pullTimer);
  watchTimer = null;
  pullTimer = null;
  for (const t of hintTimers.values()) clearTimeout(t);
  hintTimers.clear();
  fetchChat = null;
  infoChanged = null;
}
