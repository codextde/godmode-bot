/**
 * Android phones (owner: android): the phones adb sees, kept as records so a phone keeps its name, description and
 * assignments when it is unplugged, comes back over Wi-Fi or gets another USB port. Discovery polls `adb devices`
 * while an adb server runs (Godmode never starts one in the background on its own — only when the human opens the
 * phones page or a run uses a phone). Also: renaming, assigning, the human's "Run command", Wi-Fi pairing, and the
 * runs that may use phones.
 */
import { connect as tcpConnect } from "node:net";
import type {
  AndroidAssignInput,
  AndroidConnectInput,
  AndroidConnectResult,
  AndroidConnection,
  AndroidDevice,
  AndroidDeviceKind,
  AndroidDevicePatch,
  AndroidDeviceState,
  AndroidExecInput,
  AndroidExecResult,
  AndroidPendingDevice,
  AndroidStatus,
} from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent, updateAgent } from "../agents/service";
import { audit } from "../services/audit";
import { getConversationSummary, updateConversation } from "../services/conversations";
import { getSettings } from "../services/settings";
import { onSettingsApplied } from "../services/runtime";
import { HttpError, badRequest, conflict, newId, notFound, now } from "../util";
import { AdbError, adb, adbErrorText, adbVersion, canInstallAdb, deviceError, installAdb, listAdbDevices, readProps, resolveAdb, type AdbDevice } from "./adb";
import { androidAssignments, removeDeviceEverywhere } from "./assignments";
import { forgetSize, readState, screenSize, type PhoneState } from "./screen";

const log = logger("android");

const POLL_MS = 4000;
const STATE_MS = 30_000;
/** Without an adb server running, look again this long after someone last asked for phones. */
const INTEREST_MS = 10 * 60_000;
const MAX_EXEC_OUTPUT = 200_000;

interface DeviceRow {
  id: string;
  serial: string;
  name: string;
  description: string;
  kind: AndroidDeviceKind;
  manufacturer: string | null;
  model: string | null;
  android_version: string | null;
  sdk: number | null;
  width: number | null;
  height: number | null;
  last_adb_serial: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Live {
  adbSerial: string;
  state: Exclude<AndroidDeviceState, "disconnected">;
  connection: AndroidConnection;
  phone: PhoneState | null;
  phoneAt: number;
}

const live = new Map<string, Live>();
/** adb serial → device id, for connections whose phone is known (cleared when the connection goes away). */
const bySerial = new Map<string, string>();
let pending: AndroidPendingDevice[] = [];
let lastError: string | null = null;
let lastInterest = 0;

function row(id: string): DeviceRow | null {
  return get<DeviceRow>("SELECT * FROM android_devices WHERE id = ?", id);
}

function requireRow(id: string): DeviceRow {
  const r = row(id);
  if (!r) throw notFound("Android phone");
  return r;
}

function toDevice(r: DeviceRow): AndroidDevice {
  const l = live.get(r.id);
  return {
    id: r.id,
    serial: r.serial,
    name: r.name,
    description: r.description,
    kind: r.kind === "emulator" ? "emulator" : "phone",
    manufacturer: r.manufacturer,
    model: r.model,
    androidVersion: r.android_version,
    sdk: r.sdk,
    width: r.width,
    height: r.height,
    state: l?.state ?? "disconnected",
    connection: l?.connection ?? null,
    adbSerial: l?.adbSerial ?? null,
    battery: l?.phone?.battery ?? null,
    awake: l?.phone?.awake ?? null,
    busy: busyDevices().has(r.id),
    lastSeenAt: l?.state === "connected" ? now() : r.last_seen_at,
    assignments: androidAssignments(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listDevices(): AndroidDevice[] {
  const rows = all<DeviceRow>("SELECT * FROM android_devices ORDER BY name COLLATE NOCASE, created_at");
  // Connected phones first, then the ones seen most recently.
  return rows.map(toDevice).sort((a, b) => Number(b.state === "connected") - Number(a.state === "connected"));
}

export function getDevice(id: string): AndroidDevice {
  return toDevice(requireRow(id));
}

export function deviceName(id: string): string {
  return row(id)?.name ?? id;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                            */
/* ------------------------------------------------------------------ */

const PENDING_HINT: Record<AndroidPendingDevice["state"], string> = {
  unauthorized: "Unlock the phone and tap Allow on “Allow USB debugging?” (tick “Always allow from this computer”).",
  offline: "The phone is connecting or asleep. Unlock it; if it stays offline, unplug it and plug it in again.",
  "no-permissions": "This computer's USB rules don't let adb reach the phone. On Linux, add a udev rule for it (see Android's “Set up a device for development”).",
};

function defaultName(props: { manufacturer: string | null; model: string | null; avdName: string | null }, kind: AndroidDeviceKind): string {
  if (kind === "emulator") return `${props.avdName ?? props.model ?? "Android"} (emulator)`;
  const maker = props.manufacturer ? props.manufacturer.charAt(0).toUpperCase() + props.manufacturer.slice(1) : "";
  const model = props.model ?? "Android phone";
  return (model.toLowerCase().startsWith(maker.toLowerCase()) || !maker ? model : `${maker} ${model}`).slice(0, 100);
}

/** The record of the phone behind a connection: found by its own serial, created the first time it is seen. */
async function identify(d: AdbDevice): Promise<string> {
  const known = bySerial.get(d.serial);
  if (known && row(known)) return known;
  const props = await readProps(d.serial);
  const kind: AndroidDeviceKind = d.connection === "emulator" || props.avdName ? "emulator" : "phone";
  // Emulators all report the same serial number: their AVD name tells them apart.
  const identity = kind === "emulator" ? `avd:${props.avdName ?? d.serial}` : (props.serialno ?? (d.connection === "wifi" ? `wifi:${d.serial.replace(/:\d+$/, "")}` : d.serial));
  const ts = now();
  const existing = get<DeviceRow>("SELECT * FROM android_devices WHERE serial = ?", identity);
  let id: string;
  if (existing) {
    id = existing.id;
    update("android_devices", id, {
      manufacturer: props.manufacturer,
      model: props.model,
      android_version: props.androidVersion,
      sdk: props.sdk,
      kind,
      last_adb_serial: d.serial,
      last_seen_at: ts,
    });
  } else {
    id = newId("adr");
    insert("android_devices", {
      id,
      serial: identity,
      name: defaultName(props, kind),
      description: "",
      kind,
      manufacturer: props.manufacturer,
      model: props.model,
      android_version: props.androidVersion,
      sdk: props.sdk,
      width: null,
      height: null,
      last_adb_serial: d.serial,
      last_seen_at: ts,
      created_at: ts,
      updated_at: ts,
    });
    log.info("Android phone found", { device: id, kind, model: props.model });
  }
  bySerial.set(d.serial, id);
  return id;
}

const CONNECTION_RANK: Record<AndroidConnection, number> = { usb: 0, emulator: 1, wifi: 2 };

let refreshing: Promise<void> | null = null;
let lastRefresh = 0;

/** Look at what adb sees now. `startServer`: also when no adb server runs yet (adb starts one). */
export function refreshDevices(opts: { startServer?: boolean } = {}): Promise<void> {
  if (opts.startServer) lastInterest = Date.now();
  refreshing ??= doRefresh(!!opts.startServer).finally(() => {
    refreshing = null;
    lastRefresh = Date.now();
  });
  return refreshing;
}

function snapshot(): string {
  return JSON.stringify([[...live.entries()].map(([id, l]) => [id, l.adbSerial, l.state, l.connection, l.phone]), pending, lastError]);
}

function clearLive() {
  live.clear();
  bySerial.clear();
  pending = [];
}

async function doRefresh(startServer: boolean): Promise<void> {
  const before = snapshot();
  try {
    if (!getSettings().android.enabled || !resolveAdb()) {
      clearLive();
      lastError = null;
      return;
    }
    if (!startServer && !(await adbServerRunning())) {
      clearLive();
      return;
    }
    const devices = await listAdbDevices();
    lastError = null;
    const seen = new Map<string, Live>();
    const nextPending: AndroidPendingDevice[] = [];
    for (const d of devices) {
      if (d.state === "device") {
        let id: string;
        try {
          id = await identify(d);
        } catch (err) {
          log.debug(`could not read ${d.serial}`, err);
          nextPending.push({ adbSerial: d.serial, state: "offline", connection: d.connection, hint: PENDING_HINT.offline });
          continue;
        }
        const other = seen.get(id);
        // The same phone over USB and Wi-Fi: USB is faster.
        if (other && CONNECTION_RANK[other.connection] <= CONNECTION_RANK[d.connection]) continue;
        const prev = live.get(id);
        seen.set(id, { adbSerial: d.serial, state: "connected", connection: d.connection, phone: prev?.adbSerial === d.serial ? prev.phone : null, phoneAt: prev?.adbSerial === d.serial ? prev.phoneAt : 0 });
      } else if (d.state === "unauthorized" || d.state === "offline" || d.state === "no-permissions") {
        const id = bySerial.get(d.serial);
        if (id && row(id) && !seen.has(id) && d.state !== "no-permissions") {
          seen.set(id, { adbSerial: d.serial, state: d.state, connection: d.connection, phone: null, phoneAt: 0 });
        } else {
          nextPending.push({ adbSerial: d.serial, state: d.state, connection: d.connection, hint: PENDING_HINT[d.state] });
        }
      }
    }
    const present = new Set(devices.map((d) => d.serial));
    for (const serial of [...bySerial.keys()]) if (!present.has(serial)) bySerial.delete(serial);
    for (const [id, l] of live) {
      if (!seen.has(id)) {
        forgetSize(l.adbSerial);
        run("UPDATE android_devices SET last_seen_at = ? WHERE id = ?", now(), id);
      }
    }
    live.clear();
    for (const [id, l] of seen) live.set(id, l);
    pending = nextPending;
    await refreshPhoneStates();
  } catch (err) {
    lastError = err instanceof AdbError ? err.message : err instanceof Error ? err.message : String(err);
    log.debug("android refresh failed", err);
  } finally {
    if (snapshot() !== before) bus.changed("android");
  }
}

/** Battery and screen of connected phones, at most every 30 s; the screen size once per connection. */
async function refreshPhoneStates(): Promise<void> {
  await Promise.all(
    [...live.entries()].map(async ([id, l]) => {
      if (l.state !== "connected" || Date.now() - l.phoneAt < STATE_MS) return;
      l.phoneAt = Date.now();
      try {
        l.phone = await readState(l.adbSerial);
        const r = row(id);
        if (r && (!r.width || !r.height)) {
          const size = await screenSize(l.adbSerial);
          update("android_devices", id, { width: size.width, height: size.height });
        }
      } catch (err) {
        log.debug(`could not read the state of ${l.adbSerial}`, err);
      }
    }),
  );
}

/** An adb server answers on its port (asking doesn't start one, unlike `adb devices`). */
function adbServerRunning(): Promise<boolean> {
  const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5037;
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function schedule() {
  if (stopped) return;
  timer = setTimeout(async () => {
    timer = null;
    const interested = Date.now() - lastInterest < INTEREST_MS || runs.size > 0;
    await refreshDevices({ startServer: interested }).catch(() => undefined);
    schedule();
  }, POLL_MS);
  timer.unref?.();
}

export function startAndroid(): void {
  if (!stopped) return;
  stopped = false;
  onSettingsApplied(() => void refreshDevices());
  void refreshDevices().catch(() => undefined);
  schedule();
}

export function stopAndroid(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** For the API: look now when the last look is older than a second. */
export async function freshDevices(): Promise<AndroidDevice[]> {
  lastInterest = Date.now();
  if (Date.now() - lastRefresh > 1000) await refreshDevices({ startServer: true });
  return listDevices();
}

export async function androidStatus(): Promise<AndroidStatus> {
  lastInterest = Date.now();
  const bin = resolveAdb();
  return {
    adb: { installed: !!bin, version: bin ? await adbVersion() : null, path: bin?.path ?? null, managed: bin?.managed ?? false },
    canInstall: canInstallAdb(),
    pending,
    error: lastError,
  };
}

export async function installAndroidTools(): Promise<{ ok: boolean; output: string }> {
  const result = await installAdb();
  if (result.ok) await refreshDevices({ startServer: true });
  bus.changed("android");
  return result;
}

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

/** adb's name for a connected phone; throws for the human (and agents) when it can't be used. */
export function serialOf(id: string): string {
  requireRow(id);
  const l = live.get(id);
  if (!l) throw conflict(`${deviceName(id)} isn't connected. Plug it in (or reconnect it over Wi-Fi) and unlock it.`);
  if (l.state === "unauthorized") throw conflict(`${deviceName(id)} hasn't allowed USB debugging from this computer. Unlock it and tap Allow.`);
  if (l.state !== "connected") throw conflict(`${deviceName(id)} is offline right now. Unlock it; if it stays offline, plug it in again.`);
  return l.adbSerial;
}

export function isConnected(id: string): boolean {
  return live.get(id)?.state === "connected";
}

/** A device command failed because the phone went away: look again soon, so the list says so. */
export function noticeFailure(err: unknown): void {
  if (err instanceof AdbError && (err.code === "gone" || err.code === "unauthorized")) void refreshDevices();
}

const HOST = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:]{2,45}\]?$/;

/** Reach a phone over Wi-Fi: pair with the code from Wireless debugging first (Android 11+), then connect. */
export async function connectWifi(input: AndroidConnectInput): Promise<AndroidConnectResult> {
  const host = input.host.trim().replace(/^\[|\]$/g, "");
  if (!HOST.test(host)) throw badRequest("Enter the phone's IP address (shown under Wireless debugging)");
  const addr = (port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);
  if (input.pairingCode) {
    const code = input.pairingCode.trim();
    if (!/^\d{6}$/.test(code)) throw badRequest("The pairing code has six digits");
    if (!input.pairingPort) throw badRequest("Enter the pairing port shown next to the code");
    const res = await adb(["pair", addr(input.pairingPort)], { stdin: `${code}\n`, timeoutMs: 30_000 });
    const out = `${res.stdout.toString("utf8")} ${res.stderr}`;
    if (res.code !== 0 || !/success/i.test(out)) return { ok: false, message: `Pairing failed: ${adbErrorText(res) || "check the code and the port"}` };
  }
  const port = input.port ?? 5555;
  const res = await adb(["connect", addr(port)], { timeoutMs: 30_000 });
  const out = res.stdout.toString("utf8").trim();
  audit("user", "android.connect", host, { port, paired: !!input.pairingCode });
  await refreshDevices({ startServer: true });
  if (res.code !== 0 || /failed|cannot|unable|refused/i.test(out)) return { ok: false, message: out || adbErrorText(res) || "Couldn't connect" };
  return { ok: true, message: out || "Connected" };
}

/** Drop a Wi-Fi connection (the phone stays known). */
export async function disconnectWifi(id: string): Promise<void> {
  const l = live.get(id);
  if (!l || l.connection !== "wifi") throw conflict("This phone isn't connected over Wi-Fi");
  await adb(["disconnect", l.adbSerial], { timeoutMs: 15_000 });
  await refreshDevices();
}

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

export function updateDevice(id: string, patch: AndroidDevicePatch): AndroidDevice {
  const current = requireRow(id);
  const name = patch.name === undefined ? undefined : patch.name.trim().slice(0, 100);
  if (name !== undefined && !name) throw badRequest("Give the phone a name");
  update("android_devices", id, {
    name,
    description: patch.description === undefined ? undefined : patch.description.trim().slice(0, 4000),
    updated_at: now(),
  });
  audit("user", "android.update", id, { name: name ?? current.name });
  bus.changed("android");
  return getDevice(id);
}

/** Forget a phone that isn't connected (a connected one would be found again right away). */
export function forgetDevice(id: string): void {
  const current = requireRow(id);
  if (live.has(id)) throw conflict("Unplug the phone (or disconnect it) first — a connected phone is found again right away.");
  const removed = tx(() => {
    run("DELETE FROM android_devices WHERE id = ?", id);
    return removeDeviceEverywhere(id);
  });
  audit("user", "android.delete", id, { name: current.name });
  bus.changed("android");
  if (removed.agents.length) bus.changed("agents");
  for (const conversationId of removed.conversations) {
    try {
      bus.emit({ type: "conversation.updated", conversation: getConversationSummary(conversationId) });
    } catch {
      /* deleted meanwhile */
    }
  }
}

/** Give an agent or a chat the phone, or take it away (human, or a manager agent through the gateway). */
export async function assignDevice(id: string, input: AndroidAssignInput, actor = "user"): Promise<AndroidDevice> {
  requireRow(id);
  const toggle = (ids: string[]) => (input.assigned ? [...new Set([...ids, id])] : ids.filter((x) => x !== id));
  if (input.kind === "agent") {
    const agent = getAgent(input.id);
    // Assigning goes through the human path: agents can't give themselves phones through updateAgent.
    await updateAgent(agent.id, { androidDeviceIds: toggle(agent.androidDeviceIds) });
  } else {
    const conversation = getConversationSummary(input.id);
    updateConversation(conversation.id, { androidDeviceIds: toggle(conversation.androidDeviceIds) });
  }
  audit(actor, input.assigned ? "android.assign" : "android.unassign", id, { kind: input.kind, target: input.id });
  return getDevice(id);
}

function clipOutput(s: string): string {
  return s.length > MAX_EXEC_OUTPUT ? `${s.slice(0, MAX_EXEC_OUTPUT / 2)}\n\n… [output shortened] …\n\n${s.slice(-MAX_EXEC_OUTPUT / 2)}` : s;
}

/** The human's "Run command" on a phone (adb shell). */
export async function execForHuman(id: string, input: AndroidExecInput): Promise<AndroidExecResult> {
  const serial = serialOf(id);
  const timeoutMs = Math.min(Math.max(input.timeoutSeconds ?? 60, 1), 600) * 1000;
  const res = await adb(["shell", input.command], { serial, timeoutMs, maxOutput: 4 * MAX_EXEC_OUTPUT });
  if (res.code === null && !res.timedOut && !res.stdout.length) throw new HttpError(502, adbErrorText(res) || "adb failed", "adb_failed");
  if (res.code !== 0 && /error: (device|no devices)/.test(res.stderr)) {
    const err = deviceError(res, "The command");
    noticeFailure(err);
    throw conflict(err.message);
  }
  audit("user", "android.exec", id, {});
  return { exitCode: res.code, stdout: clipOutput(res.stdout.toString("utf8")), stderr: clipOutput(res.stderr), timedOut: res.timedOut, durationMs: res.durationMs };
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

/** A phone as the run's system prompt describes it. */
export interface PromptAndroidDevice {
  id: string;
  name: string;
  summary: string;
  description: string;
  connected: boolean;
}

export function promptDevices(ids: string[]): PromptAndroidDevice[] {
  return ids.flatMap((id) => {
    const r = row(id);
    if (!r) return [];
    const maker = r.manufacturer && r.model && !r.model.toLowerCase().startsWith(r.manufacturer.toLowerCase()) ? `${r.manufacturer} ` : "";
    const what = r.kind === "emulator" ? "Android emulator" : `${maker}${r.model ?? "Android phone"}`;
    return [{ id: r.id, name: r.name, summary: `${what}${r.android_version ? `, Android ${r.android_version}` : ""}`, description: r.description, connected: isConnected(r.id) }];
  });
}

interface RunAndroid {
  folders: string[];
  abort: AbortController;
}

const runs = new Map<string, RunAndroid & { devices: string[] }>();

function busyDevices(): Set<string> {
  return new Set([...runs.values()].flatMap((r) => r.devices));
}

/** The run may use phones: its tools work until `detachAndroid`. */
export function attachAndroid(runId: string, deviceIds: string[], folders: string[]): void {
  runs.set(runId, { folders, abort: new AbortController(), devices: deviceIds });
  lastInterest = Date.now();
  void refreshDevices({ startServer: true }).catch(() => undefined);
  bus.changed("android");
}

/** The run ended: its in-flight phone calls are cancelled. */
export function detachAndroid(runId: string): void {
  const entry = runs.get(runId);
  if (!entry) return;
  runs.delete(runId);
  entry.abort.abort();
  bus.changed("android");
}

export function androidRun(runId: string): { folders: string[]; signal: AbortSignal } | null {
  const entry = runs.get(runId);
  return entry ? { folders: entry.folders, signal: entry.abort.signal } : null;
}

/** The phone answers again; used by the tools to decide whether a failure is the phone's or the command's. */
export async function ensureConnected(id: string): Promise<string> {
  if (!isConnected(id)) await refreshDevices({ startServer: true });
  return serialOf(id);
}

export { deviceError };
