/**
 * macOS VMs (owner: vm): isolated macOS instances agents work in, run by Tart (see ./tart.ts).
 *
 * A VM record lives in SQLite; its disk is Tart's VM `<id>` in `<data>/vm/tart` and its shared folder is
 * `<data>/vm/shared/<id>`, mounted in the guest (`~/Godmode`). Disks persist until the VM is reset (re-cloned from its
 * image, keeping the shared folder and assignments) or deleted. Images are downloaded once into template VMs (see
 * ./images.ts); new VMs and resets are APFS copy-on-write clones of them, so they take seconds and almost no space.
 *
 * `tart run` is spawned detached (headless) with its output in `<data>/vm/logs/<id>.log`, so VMs survive a Godmode
 * restart and are adopted again on start. Agents use the shell tools (`tart exec` through the Tart guest agent of the
 * Cirrus Labs images); the screen comes from the guest's own Screen Sharing on the VM's private NAT address, which only
 * this Mac reaches (Tart's `--vnc-experimental` server would listen on every interface).
 *
 * Every lifecycle operation claims the VM (`op`) and only releases its own claim, so concurrent requests (a stop during
 * a boot, a reset during a stop) are refused or take over explicitly instead of clobbering each other.
 *
 * A run works in its chat's VM, else its agent's, else its workspace's (see ./assignments.ts); the runner calls
 * `attachVm` (which boots the VM when needed) and `detachVm`.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Vm, VmAssignInput, VmExecResult, VmImagePreset, VmInput, VmPatch, VmProgress, VmState, VmStatus } from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import { HttpError, badRequest, conflict, newId, notFound, now, sleep } from "../util";
import { getAgent, updateAgent } from "../agents/service";
import { emitConversationUpdated, updateConversation } from "../services/conversations";
import { updateWorkspace } from "../services/workspaces";
import { ASSIGNMENT_TABLES, vmAssignments } from "./assignments";
import { downloadImage, pruneImageLeftovers, templateName } from "./images";
import * as tart from "./tart";

const log = logger("vm");

/** The Cirrus Labs images log in automatically as admin (password "admin", passwordless sudo). */
export const GUEST_USER = "admin";
const GUEST_PASSWORD = "admin";
const SHARED_TAG = "godmode";
/** Where macOS guests mount the shared folder (virtiofs automount), and the friendlier link to it in the guest's home. */
const GUEST_MOUNT = `/Volumes/My Shared Files/${SHARED_TAG}`;
export const GUEST_SHARED_DIR = `/Users/${GUEST_USER}/Godmode`;
/** macOS's license and Virtualization.framework allow two macOS VMs at a time per Mac. */
export const MAX_RUNNING = 2;
const SCREEN_PORT = 5900;
const BOOT_TIMEOUT_MS = 5 * 60_000;
const STOP_TIMEOUT_S = 30;
const PROGRESS_EMIT_MS = 1000;
const SWEEP_MS = 30_000;
/** VM ids become Tart VM names and directory names. */
const VM_ID = /^vm_[A-Za-z0-9]{8,64}$/;

export const IMAGE_PRESETS: Omit<VmImagePreset, "downloaded" | "sizeBytes">[] = [
  {
    id: "tahoe",
    name: "macOS Tahoe",
    image: "ghcr.io/cirruslabs/macos-tahoe-base:latest",
    description: "macOS 26 with Homebrew, Git and the Xcode command line tools — a good start for most agents.",
    downloadGb: 27.3,
    diskGb: 50,
    recommended: true,
  },
  {
    id: "sequoia",
    name: "macOS Sequoia",
    image: "ghcr.io/cirruslabs/macos-sequoia-base:latest",
    description: "macOS 15 with Homebrew, Git and the Xcode command line tools.",
    downloadGb: 25.3,
    diskGb: 50,
    recommended: false,
  },
  {
    id: "tahoe-xcode",
    name: "macOS Tahoe + Xcode",
    image: "ghcr.io/cirruslabs/macos-tahoe-xcode:latest",
    description: "macOS 26 with the latest Xcode and simulators, for agents that build and test apps.",
    downloadGb: 62.1,
    diskGb: 140,
    recommended: false,
  },
];
const DEFAULT_IMAGE = IMAGE_PRESETS.find((p) => p.recommended)!.image;
const IMAGE_REF = /^[a-z0-9]+([.-][a-z0-9]+)*(:\d+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+(:[\w][\w.-]{0,127}|@sha256:[a-f0-9]{64})?$/;
const DISPLAY = /^(\d{3,4})x(\d{3,4})$/;

/* ------------------------------------------------------------------ */
/* Records + live state                                                 */
/* ------------------------------------------------------------------ */

interface VmRow {
  id: string;
  name: string;
  image: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  display: string;
  provisioned_at: string | null;
  last_error: string | null;
  last_started_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

type Op = "creating" | "starting" | "stopping";

/** What Godmode is doing with a VM right now (memory only). */
interface Live {
  op: Op | null;
  /** Identifies the operation holding `op`; only it may release it. */
  opToken: number;
  progress: VmProgress | null;
  /** The `tart run` process, when this Godmode started it. */
  proc: Subprocess | null;
  ip: string | null;
  /** The guest agent answered since the VM (last) started. */
  ready: boolean;
  /** Settles when the in-flight start (boot + setup) is done. */
  starting: Promise<void> | null;
  /** A stop or delete asked the in-flight start or creation to give up. */
  cancelled: boolean;
  /** The VM was deleted while it was being created: its disk goes when the clone is done. */
  deleted: boolean;
  lastEmit: number;
  lastUsed: number;
}

const live = new Map<string, Live>();
/** Tart's view of its VMs (by name = VM id), refreshed by `refreshStates`. */
let states = new Map<string, tart.TartVmInfo>();
let statesLoaded = false;
let statesAt = 0;
let statesInFlight: Promise<void> | null = null;
/** Runs working in a VM: run id → VM id, and the signal that ends the run's in-flight VM calls. */
const runVms = new Map<string, { vmId: string; abort: AbortController }>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let tokens = 0;

function liveOf(id: string): Live {
  let l = live.get(id);
  if (!l) {
    l = { op: null, opToken: 0, progress: null, proc: null, ip: null, ready: false, starting: null, cancelled: false, deleted: false, lastEmit: 0, lastUsed: Date.now() };
    live.set(id, l);
  }
  return l;
}

/** Claim the VM for an operation (see `release`). */
function claim(l: Live, op: Op, progress: VmProgress | null): number {
  l.op = op;
  l.opToken = ++tokens;
  l.progress = progress;
  return l.opToken;
}

/** Release the claim — unless another operation took the VM over meanwhile. */
function release(l: Live, token: number) {
  if (l.opToken !== token) return;
  l.op = null;
  l.progress = null;
}

/** Refuse when another operation holds the VM. */
function assertIdle(id: string, l: Live, what: string) {
  if (!l.op) return;
  const doing = l.op === "creating" ? "being created" : l.op === "starting" ? "starting" : "shutting down";
  throw conflict(`"${vmName(id)}" is ${doing} — ${what} when it's done.`);
}

function assertId(id: string): string {
  if (!VM_ID.test(id)) throw badRequest("Invalid virtual machine id");
  return id;
}

export function sharedDirOf(id: string): string {
  return join(tart.vmRoot(), "shared", assertId(id));
}

function logPathOf(id: string): string {
  return join(tart.vmRoot(), "logs", `${assertId(id)}.log`);
}

function row(id: string): VmRow | null {
  return get<VmRow>("SELECT * FROM vms WHERE id = ?", id);
}

function requireRow(id: string): VmRow {
  const r = row(id);
  if (!r) throw notFound("Virtual machine");
  assertId(r.id);
  return r;
}

function stateOf(r: VmRow, l: Live | undefined): VmState {
  if (l?.op) return l.op;
  const info = states.get(r.id);
  if (info) return info.state;
  // Tart answered and doesn't know the VM: its disk is gone (deleted outside Godmode, or a restored backup).
  if (statesLoaded) return "error";
  return "stopped";
}

function toVm(r: VmRow): Vm {
  const l = live.get(r.id);
  const info = states.get(r.id);
  const state = stateOf(r, l);
  const missing = state === "error" && !info && !r.last_error;
  return {
    id: r.id,
    name: r.name,
    image: r.image,
    cpu: r.cpu,
    memoryMb: r.memory_mb,
    diskGb: r.disk_gb,
    display: r.display,
    state,
    progress: l?.op ? l.progress : null,
    error: missing ? "The VM's disk is missing. Reset the VM to create it again from its image." : r.last_error,
    ip: state === "running" ? (l?.ip ?? null) : null,
    sharedDir: sharedDirOf(r.id),
    guestSharedDir: GUEST_SHARED_DIR,
    guestUser: GUEST_USER,
    diskUsageBytes: info?.sizeBytes ?? null,
    assignments: vmAssignments(r.id),
    lastStartedAt: r.last_started_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function emit(id: string) {
  const r = row(id);
  if (!r) return;
  const l = live.get(id);
  if (l) l.lastEmit = Date.now();
  bus.emit({ type: "vm.updated", vm: toVm(r) });
}

function setProgress(id: string, progress: VmProgress | null, force = false) {
  const l = liveOf(id);
  const phaseChanged = l.progress?.phase !== progress?.phase || l.progress?.label !== progress?.label;
  l.progress = progress;
  if (force || phaseChanged || Date.now() - l.lastEmit >= PROGRESS_EMIT_MS) emit(id);
}

function setError(id: string, error: string | null) {
  update("vms", id, { last_error: error, updated_at: now() });
}

const stoppedListeners = new Set<(id: string) => void>();

/** Called when a VM stops, suspends or is deleted (e.g. to close its screen connection). */
export function onVmStopped(fn: (id: string) => void): void {
  stoppedListeners.add(fn);
}

function vmStopped(id: string) {
  for (const fn of stoppedListeners) {
    try {
      fn(id);
    } catch {
      /* listeners must not break stopping */
    }
  }
}

/** Refresh Tart's list of VMs (throttled; `force` waits for a fresh answer). */
async function refreshStates(force = false): Promise<void> {
  if (!tart.vmSupport().supported || !tart.resolveTart()) return;
  if (!force && Date.now() - statesAt < 1500) return;
  if (statesInFlight && !force) return statesInFlight;
  const p = (async () => {
    try {
      const list = await tart.listVms();
      states = new Map(list.map((v) => [v.name, v]));
      statesLoaded = true;
      statesAt = Date.now();
    } catch (err) {
      log.warn("could not list VMs", err);
    }
  })();
  statesInFlight = p;
  try {
    await p;
  } finally {
    if (statesInFlight === p) statesInFlight = null;
  }
}

function runningIds(except?: string): string[] {
  const ids = new Set<string>();
  for (const [name, info] of states) if (info.state === "running") ids.add(name);
  for (const [id, l] of live) if (l.op === "starting") ids.add(id);
  if (except) ids.delete(except);
  return [...ids].filter((id) => row(id));
}

export async function listVms(): Promise<Vm[]> {
  await refreshStates();
  return all<VmRow>("SELECT * FROM vms ORDER BY created_at ASC")
    .filter((r) => VM_ID.test(r.id))
    .map(toVm);
}

export async function getVm(id: string): Promise<Vm> {
  const r = requireRow(id);
  await refreshStates();
  return toVm(r);
}

/** Name of a VM (for prompts and messages). */
export function vmName(id: string): string {
  return row(id)?.name ?? id;
}

/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */

const pulls = new Map<string, { promise: Promise<void>; percent: number | null; progress: VmProgress | null }>();

function hostInfo() {
  let freeDiskGb: number | null = null;
  try {
    const dir = existsSync(tart.vmRoot()) ? tart.vmRoot() : join(tart.vmRoot(), "..");
    const fs = statfsSync(dir);
    freeDiskGb = Math.round(((fs.bavail * fs.bsize) / 1e9) * 10) / 10;
  } catch {
    /* unknown */
  }
  return { cpus: cpus().length, memoryMb: Math.round(totalmem() / 1024 / 1024), freeDiskGb };
}

/** The image was downloaded: its template VM exists. */
function imageDownloaded(image: string): boolean {
  return states.has(templateName(image));
}

export async function vmStatus(): Promise<VmStatus> {
  const support = tart.vmSupport();
  const bin = support.supported ? tart.resolveTart() : null;
  const version = bin ? await tart.tartVersion() : null;
  await refreshStates();
  return {
    supported: support.supported,
    reason: support.reason,
    tart: { installed: !!bin && !!version, version, path: bin?.path ?? null, managed: bin?.managed ?? false, bundledVersion: tart.TART_VERSION },
    images: IMAGE_PRESETS.map((p) => ({ ...p, downloaded: imageDownloaded(p.image), sizeBytes: states.get(templateName(p.image))?.sizeBytes ?? null })),
    maxRunning: MAX_RUNNING,
    running: runningIds().length,
    host: hostInfo(),
    storageDir: tart.vmRoot(),
    downloads: Object.fromEntries([...pulls].map(([image, p]) => [image, p.percent])),
  };
}

/** Remove a downloaded image (its template) to free space; VMs made from it keep working. */
export async function removeImage(image: string, actor = "user"): Promise<void> {
  await ensureTart();
  const ref = resolveImage(image);
  if (pulls.has(ref)) throw conflict("The image is still downloading");
  await tart.tart(["delete", templateName(ref)], { timeoutMs: 5 * 60_000 });
  audit(actor, "vm.image.remove", ref);
  await refreshStates(true);
  bus.changed("vms");
}

export async function installTart(): Promise<{ ok: boolean; output: string }> {
  const result = await tart.installTart();
  statesAt = 0;
  bus.changed("vms");
  return result;
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function assertUsable() {
  const support = tart.vmSupport();
  if (!support.supported) throw new HttpError(400, support.reason ?? "macOS VMs are not supported on this machine", "unsupported");
}

async function ensureTart() {
  assertUsable();
  if (tart.resolveTart()) return;
  const res = await tart.installTart();
  if (!res.ok) throw new HttpError(500, res.output, "tart_install_failed");
}

function presetFor(image: string) {
  return IMAGE_PRESETS.find((p) => p.image === image || p.id === image) ?? null;
}

function resolveImage(value: string | undefined): string {
  const v = value?.trim();
  if (!v) return DEFAULT_IMAGE;
  const preset = presetFor(v);
  if (preset) return preset.image;
  if (!IMAGE_REF.test(v)) throw badRequest("Image must be a preset or an OCI image reference like ghcr.io/cirruslabs/macos-tahoe-base:latest");
  return v;
}

function imageLabel(image: string): string {
  return presetFor(image)?.name ?? image.replace(/^.*\//, "");
}

function cleanName(name: string | undefined): string {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (!n) throw badRequest("VM name is required");
  if (n.length > 60) throw badRequest("VM name can be at most 60 characters");
  return n;
}

function defaults() {
  const host = hostInfo();
  return {
    cpu: Math.max(2, Math.min(4, Math.floor(host.cpus / 2))),
    memoryMb: host.memoryMb >= 16 * 1024 ? 8192 : 4096,
    display: "1440x900",
  };
}

function checkCpu(cpu: number): number {
  const max = cpus().length;
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > max) throw badRequest(`CPU cores must be between 1 and ${max}`);
  return cpu;
}

function checkMemory(mb: number): number {
  const max = Math.max(2048, Math.round(totalmem() / 1024 / 1024) - 2048);
  if (!Number.isInteger(mb) || mb < 2048 || mb > max) throw badRequest(`Memory must be between 2048 and ${max} MB`);
  return mb;
}

function checkDisplay(display: string): string {
  const m = display.trim().match(DISPLAY);
  if (!m || Number(m[1]) < 640 || Number(m[2]) < 480) throw badRequest('Display must look like "1440x900" (at least 640x480)');
  return `${m[1]}x${m[2]}`;
}

function checkDisk(gb: number, min: number): number {
  if (!Number.isInteger(gb) || gb < min || gb > 4000) throw badRequest(`Disk size must be between ${min} and 4000 GB`);
  return gb;
}

/* ------------------------------------------------------------------ */
/* Images + disks                                                       */
/* ------------------------------------------------------------------ */

/** Download an image into its template VM unless it's there (concurrent callers share the download). */
async function ensureImage(image: string, onProgress: (p: VmProgress) => void): Promise<void> {
  await refreshStates(true);
  if (imageDownloaded(image)) return;
  let pull = pulls.get(image);
  if (!pull) {
    const entry = { percent: null as number | null, progress: null as VmProgress | null, promise: Promise.resolve() };
    const label = imageLabel(image);
    entry.promise = downloadImage(image, (p) => {
      entry.percent = p.percent;
      entry.progress = p.phase === "download" ? { phase: "download", label: `Downloading ${label}`, percent: p.percent } : { phase: "clone", label: `Unpacking ${label}`, percent: p.percent };
    }).finally(() => {
      pulls.delete(image);
      statesAt = 0;
      bus.changed("vms");
    });
    pull = entry;
    pulls.set(image, entry);
    bus.changed("vms");
  }
  const entry = pull;
  const ticker = setInterval(() => entry.progress && onProgress(entry.progress), 1000);
  try {
    await entry.promise;
  } finally {
    clearInterval(ticker);
  }
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** (Re)create the VM's disk from its image and apply its CPU, memory, display and disk size. */
async function buildDisk(id: string, l: Live): Promise<void> {
  const r = requireRow(id);
  const preset = presetFor(r.image);
  setProgress(id, { phase: "download", label: `Downloading ${imageLabel(r.image)}${preset ? ` (${preset.downloadGb} GB)` : ""}`, percent: null }, true);
  await ensureImage(r.image, (progress) => {
    if (l.op === "creating") setProgress(id, progress);
  });
  if (l.cancelled) throw new Cancelled();
  setProgress(id, { phase: "clone", label: "Creating the VM's disk", percent: null }, true);
  // Built under a temporary name and renamed when complete: an interrupted build never leaves a half-configured VM
  // (with the template's MAC address) behind under the VM's name.
  const building = buildingName(id);
  await tart.tart(["delete", building], { timeoutMs: 120_000 }).catch(() => undefined);
  try {
    await tart.tartOk(["clone", templateName(r.image), building], { timeoutMs: 30 * 60_000 });
    if (l.cancelled) throw new Cancelled();
    // A fresh MAC address: two VMs from one image must not get the same IP.
    await tart.tartOk(["set", building, "--random-mac"], { timeoutMs: 60_000 });
    await tart.setVm(building, { cpu: r.cpu, memoryMb: r.memory_mb, display: r.display });
    const diskGb = (await tart.getVmConfig(building)).diskGb;
    if (diskGb && r.disk_gb > Math.round(diskGb)) await tart.setVm(building, { diskGb: r.disk_gb });
    else if (diskGb && Math.round(diskGb) !== r.disk_gb) update("vms", id, { disk_gb: Math.round(diskGb) });
    if (l.cancelled) throw new Cancelled();
    await tart.tartOk(["rename", building, id], { timeoutMs: 60_000 });
  } catch (err) {
    await tart.tart(["delete", building], { timeoutMs: 120_000 }).catch(() => undefined);
    throw err;
  }
  await refreshStates(true);
}

/** Tart name of a VM's disk while it is being built. */
function buildingName(id: string): string {
  return `${assertId(id)}-building`;
}

async function deleteDisk(id: string): Promise<void> {
  const res = await tart.tart(["delete", assertId(id)], { timeoutMs: 5 * 60_000 });
  if (res.code !== 0 && !/does not exist|not found/i.test(tart.tartErrorText(res))) {
    throw new Error(`Could not delete the VM's disk: ${tart.tartErrorText(res)}`);
  }
}

/** Build the disk under a "creating" claim; failures end up as the VM's error. Returns whether it worked. */
async function buildClaimed(id: string, l: Live, token: number, what: "create" | "reset"): Promise<boolean> {
  try {
    await buildDisk(id, l);
    log.info(`${what === "create" ? "created" : "reset"} VM ${id}`);
    return true;
  } catch (err) {
    if (!(err instanceof Cancelled) && row(id) && !l.deleted) {
      log.warn(`${what === "create" ? "creating" : "resetting"} VM ${id} failed`, err);
      setError(id, errorText(err));
    }
    return false;
  } finally {
    release(l, token);
    if (l.deleted) {
      // Deleted meanwhile: remove what the clone left behind.
      await deleteDisk(id).catch(() => undefined);
      live.delete(id);
    } else {
      await refreshStates(true);
      emit(id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Create / update / delete                                             */
/* ------------------------------------------------------------------ */

export async function createVm(input: VmInput, actor = "user"): Promise<Vm> {
  await ensureTart();
  const name = cleanName(input.name);
  const image = resolveImage(input.image);
  const d = defaults();
  const minDisk = presetFor(image)?.diskGb ?? 20;
  const ts = now();
  const r: VmRow = {
    id: newId("vm"),
    name,
    image,
    cpu: checkCpu(input.cpu ?? d.cpu),
    memory_mb: checkMemory(input.memoryMb ?? d.memoryMb),
    disk_gb: checkDisk(input.diskGb ?? minDisk, 20),
    display: checkDisplay(input.display ?? d.display),
    provisioned_at: null,
    last_error: null,
    last_started_at: null,
    last_used_at: null,
    created_at: ts,
    updated_at: ts,
  };
  mkdirSync(sharedDirOf(r.id), { recursive: true, mode: 0o700 });
  insert("vms", { ...r });
  audit(actor, "vm.create", r.id, { name, image });
  const l = liveOf(r.id);
  const token = claim(l, "creating", { phase: "download", label: `Preparing ${imageLabel(image)}`, percent: null });
  emit(r.id);
  void buildClaimed(r.id, l, token, "create").then((ok) => {
    if (ok && input.start && row(r.id)) startVm(r.id).catch((err) => log.warn(`could not start new VM ${r.id}`, err));
  });
  return toVm(r);
}

export async function updateVm(id: string, patch: VmPatch, actor = "user"): Promise<Vm> {
  const r = requireRow(id);
  const l = liveOf(id);
  assertIdle(id, l, "change it");
  await refreshStates(true);
  assertIdle(id, l, "change it");
  const state = states.get(id)?.state;
  const next: Partial<VmRow> = {};
  if (patch.name !== undefined) {
    next.name = cleanName(patch.name);
    // The guest's computer name follows on the next start.
    if (next.name !== r.name) next.provisioned_at = null;
  }
  if (patch.cpu !== undefined) next.cpu = checkCpu(patch.cpu);
  if (patch.memoryMb !== undefined) next.memory_mb = checkMemory(patch.memoryMb);
  if (patch.display !== undefined) next.display = checkDisplay(patch.display);
  if (patch.diskGb !== undefined && patch.diskGb !== r.disk_gb) {
    if (patch.diskGb < r.disk_gb) throw badRequest("A VM's disk can only grow");
    if (state === "running") throw conflict("Stop the VM before resizing its disk");
    next.disk_gb = checkDisk(patch.diskGb, r.disk_gb);
  }
  const config = {
    cpu: next.cpu !== undefined && next.cpu !== r.cpu ? next.cpu : undefined,
    memoryMb: next.memory_mb !== undefined && next.memory_mb !== r.memory_mb ? next.memory_mb : undefined,
    display: next.display !== undefined && next.display !== r.display ? next.display : undefined,
    diskGb: next.disk_gb,
  };
  const changesConfig = Object.values(config).some((v) => v !== undefined);
  // A suspended VM resumes with the hardware it was saved with; changing it would lose the saved session.
  if (changesConfig && state === "suspended") throw conflict("Shut the VM down (Stop) before changing its hardware — it's suspended with the current settings");
  if (changesConfig && states.has(id)) await tart.setVm(id, config);
  update("vms", id, { ...next, updated_at: now() });
  audit(actor, "vm.update", id, { ...patch });
  emit(id);
  return getVm(id);
}

export async function deleteVm(id: string, opts: { keepFiles?: boolean } = {}, actor = "user"): Promise<void> {
  const r = requireRow(id);
  const l = liveOf(id);
  // Everything before the first await: the build (if any) cleans up after itself, runs stop using the VM, and no
  // start can begin while it's being deleted.
  const creating = l.op === "creating";
  l.cancelled = true;
  if (creating) l.deleted = true;
  else claim(l, "stopping", { phase: "boot", label: "Deleting", percent: null });
  for (const [runId, entry] of runVms) {
    if (entry.vmId !== id) continue;
    entry.abort.abort();
    runVms.delete(runId);
  }
  if (tart.vmSupport().supported) {
    // Without Tart the disk (and a running VM) would stay behind with no way to manage it.
    await ensureTart();
    await refreshStates(true);
    if (!creating && (states.get(id)?.state === "running" || l.starting || l.proc)) await stopProcess(id, l, 5, { graceful: false });
    if (!creating) await deleteDisk(id);
  }
  const affected = {
    agents: all<{ id: string }>("SELECT id FROM agents WHERE vm_id = ?", id).map((x) => x.id),
    conversations: all<{ id: string }>("SELECT id FROM conversations WHERE vm_id = ?", id).map((x) => x.id),
    workspaces: all<{ id: string }>("SELECT id FROM workspaces WHERE vm_id = ?", id).length,
  };
  tx(() => {
    run("UPDATE agents SET vm_id = NULL WHERE vm_id = ?", id);
    run("UPDATE conversations SET vm_id = NULL WHERE vm_id = ?", id);
    run("UPDATE workspaces SET vm_id = NULL WHERE vm_id = ?", id);
    run("DELETE FROM vms WHERE id = ?", id);
  });
  if (!opts.keepFiles) rmSync(sharedDirOf(id), { recursive: true, force: true });
  rmSync(logPathOf(id), { force: true });
  vmStopped(id);
  // A build that is still running removes its disk when it finishes (buildClaimed).
  if (!creating) live.delete(id);
  audit(actor, "vm.delete", id, { name: r.name, keptFiles: !!opts.keepFiles });
  log.info(`deleted VM ${id} (${r.name})`);
  states.delete(id);
  bus.emit({ type: "vm.deleted", id });
  for (const agentId of affected.agents) {
    try {
      bus.emit({ type: "agent.updated", agent: getAgent(agentId) });
    } catch {
      /* deleted meanwhile */
    }
  }
  for (const convId of affected.conversations) emitConversationUpdated(convId);
  if (affected.workspaces) bus.changed("workspaces");
}

/**
 * Recreate the VM's disk from its image — a clean macOS. The shared folder, settings and assignments are kept.
 * Answers once the reset started; progress and failures arrive like a creation (`vm.updated`, the VM's error).
 */
export async function resetVm(id: string, opts: { start?: boolean } = {}, actor = "user"): Promise<Vm> {
  await ensureTart();
  const r = requireRow(id);
  const l = liveOf(id);
  assertIdle(id, l, "reset it");
  const token = claim(l, "creating", { phase: "clone", label: "Resetting", percent: null });
  l.cancelled = false;
  emit(id);
  audit(actor, "vm.reset", id, { name: r.name, image: r.image });
  try {
    await refreshStates(true);
    if (states.get(id)?.state === "running" || l.proc) await stopProcess(id, l, 10, { graceful: false });
    // stopProcess cancels in-flight work; this reset goes on.
    l.cancelled = false;
    await deleteDisk(id);
    update("vms", id, { provisioned_at: null, last_error: null, updated_at: now() });
  } catch (err) {
    release(l, token);
    setError(id, errorText(err));
    await refreshStates(true);
    emit(id);
    throw new HttpError(500, `Could not reset the VM: ${errorText(err)}`, "vm_reset_failed");
  }
  void buildClaimed(id, l, token, "reset").then((ok) => {
    if (ok && opts.start && row(id)) startVm(id).catch((err) => log.warn(`could not start VM ${id} after its reset`, err));
  });
  return toVm(requireRow(id));
}

/** A copy of a stopped VM (APFS copy-on-write): same disk contents, its own shared folder, no assignments. */
export async function duplicateVm(id: string, name?: string, actor = "user"): Promise<Vm> {
  await ensureTart();
  const r = requireRow(id);
  const l = liveOf(id);
  assertIdle(id, l, "duplicate it");
  await refreshStates(true);
  assertIdle(id, l, "duplicate it");
  const state = stateOf(r, l);
  if (state !== "stopped") throw conflict(state === "suspended" ? "Shut the VM down (Stop) before duplicating it" : "Stop the VM before duplicating it");
  const copy: VmRow = { ...r, id: newId("vm"), name: cleanName(name ?? `${r.name} copy`), provisioned_at: null, last_error: null, last_started_at: null, last_used_at: null, created_at: now(), updated_at: now() };
  await tart.tartOk(["clone", id, copy.id], { timeoutMs: 30 * 60_000 });
  await tart.tartOk(["set", copy.id, "--random-mac"], { timeoutMs: 60_000 });
  mkdirSync(sharedDirOf(copy.id), { recursive: true, mode: 0o700 });
  insert("vms", { ...copy });
  audit(actor, "vm.duplicate", copy.id, { from: id, name: copy.name });
  await refreshStates(true);
  emit(copy.id);
  return toVm(copy);
}

/* ------------------------------------------------------------------ */
/* Start / stop                                                         */
/* ------------------------------------------------------------------ */

function logTail(id: string): string {
  let text = "";
  try {
    text = readFileSync(logPathOf(id), "utf8");
  } catch {
    /* no log */
  }
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ")
    .slice(0, 600);
}

/** Suspending needs a macOS guest (Tart saves no state for Linux VMs). */
async function isMacGuest(id: string): Promise<boolean> {
  return (await tart.getVmConfig(id).catch(() => ({ os: "darwin" }))).os === "darwin";
}

/**
 * Boot the VM (headless, with the shared folder mounted), wait for the guest agent, and prepare the guest when needed.
 * Resolves when the VM accepts commands. Concurrent calls share one start.
 */
export function startVm(id: string): Promise<void> {
  requireRow(id);
  const l = liveOf(id);
  if (l.starting) return l.starting;
  if (l.op === "creating") {
    const pct = l.progress?.percent != null ? ` (${Math.round(l.progress.percent)}%)` : "";
    return Promise.reject(conflict(`"${vmName(id)}" is still being created${pct}. Try again when it's ready.`));
  }
  if (l.op === "stopping") return Promise.reject(conflict(`"${vmName(id)}" is shutting down. Try again in a moment.`));
  // Claimed before anything is awaited: a stop, reset or second start in the meantime sees it.
  const token = claim(l, "starting", { phase: "boot", label: "Starting", percent: null });
  l.cancelled = false;
  const p = doStart(id, l, token).finally(() => {
    if (l.starting === p) l.starting = null;
    release(l, token);
    void refreshStates(true).then(() => emit(id));
  });
  l.starting = p;
  emit(id);
  return p;
}

function checkCancelled(l: Live) {
  if (l.cancelled) throw conflict("The VM was stopped while it was starting");
}

async function doStart(id: string, l: Live, token: number): Promise<void> {
  await ensureTart();
  await refreshStates(true);
  checkCancelled(l);
  const info = states.get(id);
  if (!info) throw new HttpError(409, "The VM's disk is missing. Reset the VM to create it again from its image.", "vm_missing");
  if (info.state === "running") {
    // Adopted after a Godmode restart (or started outside Godmode): make sure the guest answers.
    if (!l.ready) {
      setProgress(id, { phase: "boot", label: "Connecting", percent: null }, true);
      await waitForGuest(id, l, null, 90_000);
      l.ip ??= await tart.ipOf(id, 5).catch(() => null);
    }
    return;
  }
  const others = runningIds(id);
  if (others.length >= MAX_RUNNING) {
    const names = others.map((o) => `"${vmName(o)}"`).join(" and ");
    throw conflict(`macOS runs at most ${MAX_RUNNING} macOS VMs at the same time. Stop ${names} first.`);
  }
  const bin = tart.resolveTart()!;
  const r = requireRow(id);
  const resuming = info.state === "suspended";
  // Suspending (and --suspendable) is for macOS guests only; a custom Linux image boots without it.
  const macOS = await isMacGuest(id);
  checkCancelled(l);
  setProgress(id, { phase: "boot", label: resuming ? "Resuming" : "Booting macOS", percent: null }, true);
  setError(id, null);
  l.ip = null;
  l.ready = false;
  const args = [
    "run",
    id,
    "--no-graphics",
    // Suspend support (Godmode suspends VMs when it quits); no audio devices, which agents don't need.
    ...(macOS ? ["--suspendable"] : []),
    // The human's clipboard is none of the VM's business.
    "--no-clipboard",
    `--dir=${SHARED_TAG}:${sharedDirOf(id)}`,
  ];
  let proc: Subprocess;
  try {
    mkdirSync(sharedDirOf(id), { recursive: true, mode: 0o700 });
    mkdirSync(join(tart.vmRoot(), "logs"), { recursive: true, mode: 0o700 });
    const fd = openSync(logPathOf(id), "w", 0o600);
    try {
      // Detached: the VM keeps running when Godmode restarts (see onQuit) and is adopted again.
      proc = Bun.spawn([bin.path, ...args], { stdin: "ignore", stdout: fd, stderr: fd, env: tart.tartEnv() as Record<string, string>, detached: true });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    setError(id, errorText(err));
    throw err;
  }
  proc.unref();
  l.proc = proc;
  void proc.exited.then(() => onProcessExit(id, proc));
  log.info(`${resuming ? "resuming" : "starting"} VM ${id} (${r.name})`);
  try {
    await waitForGuest(id, l, proc, BOOT_TIMEOUT_MS);
    checkCancelled(l);
    l.ip = await tart.ipOf(id, 30).catch(() => null);
    checkCancelled(l);
    // Every boot (idempotent, a second or two): settings made by an older Godmode version get updated too.
    setProgress(id, { phase: "setup", label: requireRow(id).provisioned_at ? "Getting the VM ready" : "Setting up the VM", percent: null }, true);
    await provision(id);
    checkCancelled(l);
    l.ready = true;
    update("vms", id, { last_started_at: now(), last_used_at: now(), updated_at: now() });
    l.lastUsed = Date.now();
    // Callers use the VM right away (its screen needs Tart's "running" state).
    await refreshStates(true);
    log.info(`VM ${id} is running${l.ip ? ` at ${l.ip}` : ""}`);
  } catch (err) {
    if (!l.cancelled && l.opToken === token) {
      log.warn(`starting VM ${id} failed`, err);
      setError(id, errorText(err));
      // Only a VM that actually runs is stopped: `tart stop` on a suspended VM would discard its saved session.
      if (proc.exitCode === null && proc.signalCode === null) {
        await tart.tart(["stop", id, "--timeout", "5"], { timeoutMs: 40_000 }).catch(() => undefined);
        await Promise.race([proc.exited, sleep(10_000)]);
      }
    }
    throw l.cancelled ? conflict("The VM was stopped while it was starting") : err;
  }
}

/** Wait until the Tart guest agent runs commands (macOS booted and logged in). `proc` exiting ends the wait. */
async function waitForGuest(id: string, l: Live, proc: Subprocess | null, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void proc?.exited.then(() => {
    exited = true;
  });
  for (;;) {
    checkCancelled(l);
    if (exited) throw new Error(logTail(id) || "The VM stopped while starting");
    const res = await tart.tart(["exec", id, "/usr/bin/true"], { timeoutMs: 15_000 }).catch(() => null);
    if (res?.code === 0) {
      l.ready = true;
      return;
    }
    if (exited) throw new Error(logTail(id) || "The VM stopped while starting");
    if (Date.now() > deadline) {
      throw new Error(
        `The VM did not become ready within ${Math.round(timeoutMs / 60_000)} minutes${res ? ` (${tart.tartErrorText(res)})` : ""}. ` +
          "The image needs the Tart guest agent (all non-vanilla Cirrus Labs images have it).",
      );
    }
    await sleep(1500);
  }
}

function onProcessExit(id: string, proc: Subprocess) {
  vmStopped(id);
  const l = live.get(id);
  if (!l || l.proc !== proc) return;
  l.proc = null;
  l.ip = null;
  l.ready = false;
  log.info(`VM ${id} stopped (tart exited with ${proc.exitCode ?? proc.signalCode})`);
  void refreshStates(true).then(() => emit(id));
}

/**
 * Stop the VM: macOS shuts down (`tart stop` alone powers the VM off like pulling the plug — writes the guest hadn't
 * flushed yet would be lost), forced after `timeoutS`. Cancels an in-flight start and waits for it.
 */
async function stopProcess(id: string, l: Live, timeoutS: number, opts: { graceful?: boolean } = {}): Promise<void> {
  // Booted by this Godmode, or adopted running after a restart: shut macOS down instead of cutting the power — unless
  // the disk is about to be thrown away (delete, reset).
  const booted = (opts.graceful ?? true) && !l.starting && (l.ready || states.get(id)?.state === "running");
  l.cancelled = true;
  vmStopped(id);
  const powerOff = async () => {
    const res = await tart.tart(["stop", id, "--timeout", "5"], { timeoutMs: 40_000 });
    if (res.code !== 0 && !/not running|is not running|stopped|does not exist/i.test(tart.tartErrorText(res))) {
      log.warn(`tart stop ${id}: ${tart.tartErrorText(res)}`);
    }
  };
  if (booted && (await shutDownGuest(id, l, timeoutS))) {
    // Shut down cleanly.
  } else {
    if (booted) log.warn(`VM ${id} did not shut down within ${timeoutS} s; powering it off`);
    await powerOff();
  }
  // A start in progress gives up at its next step; if it spawned `tart run` after the power-off above, stop that too.
  if (l.starting) {
    await l.starting.catch(() => undefined);
    if (l.proc && l.proc.exitCode === null && l.proc.signalCode === null) await powerOff();
  }
  if (l.proc) {
    await Promise.race([l.proc.exited, sleep(10_000)]);
    // Still up (it was just starting when Tart looked): this Godmode owns the process — stop it directly.
    if (l.proc.exitCode === null && l.proc.signalCode === null) {
      l.proc.kill("SIGINT");
      await Promise.race([l.proc.exited, sleep(10_000)]);
    }
  }
  l.proc = null;
  l.ip = null;
  l.ready = false;
}

/** Ask the guest OS to shut down and wait until the VM is off. Returns whether it went down within `timeoutS`. */
async function shutDownGuest(id: string, l: Live, timeoutS: number): Promise<boolean> {
  // The command doesn't return once the system goes down: a short timeout is expected. (Absolute paths: commands run
  // through the guest agent get a minimal PATH without /sbin.)
  const res = await tart
    .tart(["exec", id, "/bin/sh", "-c", "/bin/sync; sudo -n /sbin/shutdown -h now"], { timeoutMs: Math.min(15, timeoutS) * 1000 })
    .catch(() => null);
  // Refused right away (no guest agent, sudo failed): no point in waiting.
  if (res && res.code !== 0 && !res.timedOut && !/transport|unavailable|shut ?down|closed|EOF/i.test(`${res.stderr} ${res.stdout}`)) {
    await sleep(1000);
    await refreshStates(true);
    if (states.get(id)?.state === "running") return false;
  }
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (l.proc) {
      if (l.proc.exitCode !== null || l.proc.signalCode !== null) return true;
    } else {
      await refreshStates(true);
      if (states.get(id)?.state !== "running") return true;
    }
    await sleep(500);
  }
  return false;
}

export async function stopVm(id: string, actor = "user", stillWanted: () => boolean = () => true): Promise<Vm> {
  requireRow(id);
  const l = liveOf(id);
  if (l.op === "creating") throw conflict("The VM is still being created");
  if (l.op === "stopping") return getVm(id);
  await ensureTart();
  await refreshStates(true);
  if (states.get(id)?.state === "stopped" && !l.starting && !l.proc) return getVm(id);
  // Looked again after the awaits above: a creation or reset that started meanwhile isn't interrupted.
  const opNow = l.op as Op | null; // may have changed during the awaits
  if (opNow === "creating") throw conflict("The VM is being created");
  if (opNow === "stopping" || !stillWanted()) return getVm(id);
  // Takes over from a start in progress (which gives up).
  const token = claim(l, "stopping", { phase: "boot", label: "Shutting down", percent: null });
  emit(id);
  try {
    await stopProcess(id, l, STOP_TIMEOUT_S);
    audit(actor, "vm.stop", id);
  } finally {
    release(l, token);
    await refreshStates(true);
    emit(id);
  }
  return getVm(id);
}

/** Save the VM's memory to disk and stop it; the next start resumes where it left off. */
export async function suspendVm(id: string, actor = "user"): Promise<Vm> {
  requireRow(id);
  const l = liveOf(id);
  assertIdle(id, l, "suspend it");
  await ensureTart();
  await refreshStates(true);
  if (states.get(id)?.state !== "running") throw conflict("Only a running VM can be suspended");
  if (!(await isMacGuest(id))) throw conflict("Only macOS VMs can be suspended — stop it instead");
  assertIdle(id, l, "suspend it");
  vmStopped(id);
  const token = claim(l, "stopping", { phase: "boot", label: "Suspending", percent: null });
  emit(id);
  try {
    const res = await tart.tart(["suspend", id], { timeoutMs: 3 * 60_000 });
    if (res.code !== 0) throw new HttpError(500, `Could not suspend the VM: ${tart.tartErrorText(res)}`, "vm_suspend_failed");
    if (l.proc) await Promise.race([l.proc.exited, sleep(15_000)]);
    l.proc = null;
    l.ip = null;
    l.ready = false;
    audit(actor, "vm.suspend", id);
  } finally {
    release(l, token);
    await refreshStates(true);
    emit(id);
  }
  return getVm(id);
}

export async function restartVm(id: string, actor = "user"): Promise<Vm> {
  await stopVm(id, actor);
  await startVm(id);
  return getVm(id);
}

/** Boot the VM unless it runs (and answers); waits for a start in progress. */
export async function ensureVmRunning(id: string): Promise<void> {
  requireRow(id);
  const l = liveOf(id);
  if (l.starting) return l.starting;
  if (l.op) return startVm(id); // rejects with what's going on
  await refreshStates();
  if (states.get(id)?.state === "running" && l.ready) return;
  await startVm(id);
}

function touch(id: string) {
  const l = live.get(id);
  if (l) l.lastUsed = Date.now();
}

/* ------------------------------------------------------------------ */
/* Guest                                                                */
/* ------------------------------------------------------------------ */

/** Single-quote for sh/zsh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A guest path as a shell word: absolute, `~/…` or relative to the guest's home. */
export function guestPathWord(path: string): string {
  const p = path.trim();
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${shq(p.slice(2))}`;
  if (p.startsWith("/")) return shq(p);
  return `"$HOME"/${shq(p)}`;
}

/** Godmode's SSH key for its VMs (authorized in every guest when it boots, see `provision`). */
export function sshKeyPath(): string {
  return join(tart.vmRoot(), "ssh", "id_ed25519");
}

async function ensureSshKey(): Promise<string | null> {
  const dir = join(tart.vmRoot(), "ssh");
  const key = sshKeyPath();
  if (!existsSync(`${key}.pub`)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const res = Bun.spawnSync(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "godmode-vm", "-f", key], { stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) {
      log.warn(`ssh-keygen failed: ${res.stderr.toString().trim()}`);
      return null;
    }
  }
  try {
    return readFileSync(`${key}.pub`, "utf8").trim();
  } catch {
    return null;
  }
}

function hostnameFor(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "godmode-vm"
  );
}

/**
 * Every boot: link the shared folder into the home folder, name the computer after the VM, authorize Godmode's SSH key
 * (for "Open Terminal"), turn on Screen Sharing (the VM's screen), let only this Mac reach SSH and Screen Sharing, and
 * keep the screen from sleeping. Idempotent.
 */
async function provision(id: string): Promise<void> {
  const r = requireRow(id);
  const pub = await ensureSshKey();
  const script = [
    `link=${shq(GUEST_SHARED_DIR)}`,
    `[ -L "$link" ] || [ -e "$link" ] || ln -s ${shq(GUEST_MOUNT)} "$link"`,
    // Absolute paths: commands run through the guest agent get a minimal PATH.
    `sudo -n /usr/sbin/scutil --set ComputerName ${shq(r.name)} 2>/dev/null || true`,
    `sudo -n /usr/sbin/scutil --set LocalHostName ${shq(hostnameFor(r.name))} 2>/dev/null || true`,
    `sudo -n /bin/launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null || true`,
    `sudo -n /usr/bin/pmset -a displaysleep 0 sleep 0 2>/dev/null || true`,
    // Only this Mac (the VM's gateway) may use SSH and Screen Sharing: other VMs on the same network share the images'
    // well-known login. (Commands from Godmode use the guest agent's virtual socket, not the network.)
    `gw=$(/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/gateway:/ {print $2}')`,
    `if [ -n "$gw" ]; then printf 'pass in quick proto tcp from %s to any port { 22, 5900 }\nblock return in quick proto tcp from any to any port { 22, 5900 }\n' "$gw" | sudo -n /sbin/pfctl -q -a com.apple/godmode -f - 2>/dev/null; sudo -n /sbin/pfctl -q -E 2>/dev/null; fi; true`,
    `/usr/bin/defaults -currentHost write com.apple.screensaver idleTime -int 0 2>/dev/null || true`,
    pub
      ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qF ${shq(pub)} ~/.ssh/authorized_keys || echo ${shq(pub)} >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys`
      : "true",
  ].join("\n");
  const res = await tart.tart(["exec", id, "/bin/zsh", "-c", script], { timeoutMs: 60_000 });
  if (res.code !== 0) {
    // Not fatal: the VM works without it (the next start tries again).
    log.warn(`setting up VM ${id} failed: ${tart.tartErrorText(res) || `exit ${res.code}`}`);
    return;
  }
  update("vms", id, { provisioned_at: now() });
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
}

/** Run a shell command in the VM (a login zsh as the guest user). Boots the VM when needed. */
export async function execInVm(id: string, command: string, opts: ExecOptions = {}): Promise<VmExecResult> {
  await ensureVmRunning(id);
  touch(id);
  const script = opts.cwd?.trim() ? `cd ${guestPathWord(opts.cwd)} && {\n${command}\n}` : command;
  const args = ["exec", ...(opts.stdin !== undefined ? ["-i"] : []), id, "/bin/zsh", "-l", "-c", script];
  const res = await tart.tart(args, { timeoutMs: opts.timeoutMs ?? 120_000, stdin: opts.stdin, signal: opts.signal, maxOutput: 2_000_000 });
  touch(id);
  return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut };
}

/* ------------------------------------------------------------------ */
/* Screen                                                               */
/* ------------------------------------------------------------------ */

export interface ScreenEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
}

let screenEndpointOverride: ((id: string) => ScreenEndpoint | null) | null = null;

/** Tests: where the VM screen of a (fake) VM listens. null = the guest's Screen Sharing. */
export function __setScreenEndpointForTests(fn: ((id: string) => ScreenEndpoint | null) | null) {
  screenEndpointOverride = fn;
}

/**
 * The running VM's screen: the guest's Screen Sharing on its private NAT address (not reachable from the network),
 * logged in as the guest user. null when the VM isn't running.
 */
export async function screenEndpoint(id: string): Promise<ScreenEndpoint | null> {
  if (screenEndpointOverride) return (await vmRunning(id)) ? screenEndpointOverride(id) : null;
  const ip = await vmAddress(id);
  return ip ? { host: ip, port: SCREEN_PORT, username: GUEST_USER, password: GUEST_PASSWORD } : null;
}

async function vmRunning(id: string): Promise<boolean> {
  requireRow(id);
  const l = liveOf(id);
  if (states.get(id)?.state !== "running") await refreshStates(true);
  if (l.op === "stopping" || states.get(id)?.state !== "running") return false;
  touch(id);
  return true;
}

/** The running VM's address on the private network only this Mac reaches, or null. */
export async function vmAddress(id: string): Promise<string | null> {
  if (!(await vmRunning(id))) return null;
  const l = liveOf(id);
  l.ip ??= await tart.ipOf(id, 10).catch(() => null);
  return l.ip;
}

/* ------------------------------------------------------------------ */
/* Opening things for the human                                         */
/* ------------------------------------------------------------------ */

function openOnMac(args: string[]): void {
  const res = Bun.spawnSync(["/usr/bin/open", ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new HttpError(500, `Could not open it: ${res.stderr.toString().trim() || `exit ${res.exitCode}`}`, "open_failed");
}

/** Show the VM's screen in macOS Screen Sharing (boots the VM first when needed). */
export async function openVmScreen(id: string): Promise<void> {
  await ensureVmRunning(id);
  const ep = await screenEndpoint(id);
  if (!ep) throw conflict("The VM's screen is not available right now — try again in a moment");
  openOnMac([`vnc://${encodeURIComponent(ep.username)}:${encodeURIComponent(ep.password)}@${ep.host}:${ep.port}`]);
}

/** Open Terminal with an SSH session into the VM. */
export async function openVmTerminal(id: string): Promise<void> {
  await ensureVmRunning(id);
  const l = liveOf(id);
  l.ip ??= await tart.ipOf(id, 30).catch(() => null);
  if (!l.ip) throw conflict("The VM has no IP address yet — try again in a moment");
  if (!requireRow(id).provisioned_at) await provision(id);
  touch(id);
  const key = sshKeyPath();
  const script = join(tart.vmRoot(), "ssh", `${id}.command`);
  writeFileSync(
    script,
    `#!/bin/zsh\nclear\nexec ssh -i ${shq(key)} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ${GUEST_USER}@${l.ip}\n`,
    { mode: 0o700 },
  );
  chmodSync(script, 0o700);
  openOnMac(["-a", "Terminal", script]);
}

export function revealVmFolder(id: string): void {
  requireRow(id);
  const dir = sharedDirOf(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  openOnMac([dir]);
}

/* ------------------------------------------------------------------ */
/* Assignments                                                          */
/* ------------------------------------------------------------------ */

/** Assign the VM to an agent, chat or workspace (or remove that assignment) — from the VM's side. */
export async function assignVm(id: string, input: VmAssignInput, actor = "user"): Promise<Vm> {
  requireRow(id);
  const table = ASSIGNMENT_TABLES[input.kind];
  const target = get<{ vm_id: string | null }>(`SELECT vm_id FROM ${table} WHERE id = ?`, input.id);
  if (!target) throw notFound(input.kind === "conversation" ? "Chat" : input.kind === "agent" ? "Agent" : "Workspace");
  // Taking work out of a VM widens its access to this computer: only the human may.
  if (!input.assigned && actor.startsWith("agent:")) throw new HttpError(403, "Only the human can remove a VM assignment", "forbidden");
  // Removing only clears this VM (the target may use another one by now).
  const vmId = input.assigned ? id : target.vm_id === id ? null : undefined;
  if (vmId !== undefined) {
    if (input.kind === "agent") await updateAgent(input.id, { vmId }, actor);
    else if (input.kind === "conversation") updateConversation(input.id, { vmId });
    else updateWorkspace(input.id, { vmId });
    audit(actor, input.assigned ? "vm.assign" : "vm.unassign", id, { kind: input.kind, target: input.id });
  }
  return getVm(id);
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

export interface RunVm {
  id: string;
  name: string;
  image: string;
  guestUser: string;
  guestSharedDir: string;
  hostSharedDir: string;
}

/**
 * Bind a run to its VM, booting the VM when needed (`onActivity` reports what the run waits for). Throws with a
 * message for the human when the VM can't be used (still downloading, two VMs already running, …). `signal` stops
 * waiting (the run was cancelled); the VM keeps booting.
 */
export async function attachVm(runId: string, vmId: string, onActivity?: (label: string) => void, signal?: AbortSignal): Promise<RunVm> {
  assertUsable();
  const r = requireRow(vmId);
  const l = liveOf(vmId);
  // In use from now on: the idle sweep leaves it alone.
  touch(vmId);
  await refreshStates();
  if (states.get(vmId)?.state !== "running" || !l.ready) onActivity?.(`Starting the VM "${r.name}"…`);
  const running = ensureVmRunning(vmId);
  if (signal) {
    running.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("cancelled"));
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      running.then(resolve, reject);
    });
  } else await running;
  runVms.set(runId, { vmId, abort: new AbortController() });
  touch(vmId);
  update("vms", vmId, { last_used_at: now() });
  return { id: vmId, name: r.name, image: r.image, guestUser: GUEST_USER, guestSharedDir: GUEST_SHARED_DIR, hostSharedDir: sharedDirOf(vmId) };
}

/** The run ended: its in-flight VM calls (shell commands, file transfers) are cancelled. */
export function detachVm(runId: string): void {
  const entry = runVms.get(runId);
  if (!entry) return;
  runVms.delete(runId);
  entry.abort.abort();
  touch(entry.vmId);
}

/** The VM a run works in (for its `vm` MCP tools). */
export function vmOfRun(runId: string): string | null {
  return runVms.get(runId)?.vmId ?? null;
}

/** Aborts when the run ends: for the run's VM calls. */
export function runSignal(runId: string): AbortSignal | undefined {
  return runVms.get(runId)?.abort.signal;
}

/** A run is working in the VM right now. */
export function vmInUse(vmId: string): boolean {
  return [...runVms.values()].some((e) => e.vmId === vmId);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

/** Adopt VMs that kept running while Godmode was closed and watch for idle ones and outside changes. */
export async function startVms(): Promise<void> {
  sweepTimer ??= setInterval(() => void sweep(), SWEEP_MS);
  sweepTimer.unref?.();
  if (!tart.vmSupport().supported || !tart.resolveTart()) return;
  await refreshStates(true);
  void pruneImageLeftovers();
  for (const r of all<VmRow>("SELECT * FROM vms")) {
    if (!VM_ID.test(r.id) || states.get(r.id)?.state !== "running") continue;
    log.info(`VM ${r.id} (${r.name}) is still running`);
    // Readiness is checked on first use (doStart's adoption path).
    liveOf(r.id).lastUsed = Date.now();
  }
}

/** Notice VMs that stopped on their own, and stop idle ones (settings.vm.idleStopMinutes). */
async function sweep(): Promise<void> {
  if (!tart.vmSupport().supported || !tart.resolveTart()) return;
  const before = new Map([...states].map(([k, v]) => [k, v.state]));
  await refreshStates(true);
  for (const r of all<{ id: string }>("SELECT id FROM vms")) {
    const was = before.get(r.id);
    const is = states.get(r.id)?.state;
    if (was !== is && !live.get(r.id)?.op) emit(r.id);
  }
  const idleMinutes = getSettings().vm.idleStopMinutes;
  if (!idleMinutes || idleMinutes <= 0) return;
  for (const [id, info] of states) {
    if (info.state !== "running" || vmInUse(id) || !row(id)) continue;
    // First seen now (e.g. started outside Godmode): its idle time starts now.
    const l = liveOf(id);
    if (l.op || Date.now() - l.lastUsed < idleMinutes * 60_000) continue;
    log.info(`stopping VM ${id}: idle for ${idleMinutes} minutes`);
    const idle = () => !vmInUse(id) && Date.now() - l.lastUsed >= idleMinutes * 60_000;
    await stopVm(id, "system", idle).catch((err) => log.warn(`could not stop idle VM ${id}`, err));
  }
}

/** On quit: suspend, stop or keep running VMs (settings.vm.onQuit). */
export async function shutdownVms(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (!tart.vmSupport().supported || !tart.resolveTart()) return;
  const action = getSettings().vm.onQuit;
  if (action === "keep") return;
  await refreshStates(true).catch(() => undefined);
  const running = [...states].filter(([id, info]) => info.state === "running" && row(id)).map(([id]) => id);
  if (!running.length) return;
  log.info(`${action === "suspend" ? "suspending" : "stopping"} ${running.length} VM(s)`);
  await Promise.all(
    running.map(async (id) => {
      if (action === "suspend" && (await isMacGuest(id))) {
        const res = await tart.tart(["suspend", id], { timeoutMs: 60_000 }).catch(() => null);
        if (res?.code === 0) return;
        log.warn(`could not suspend VM ${id}; stopping it instead`);
      }
      // Quick: the desktop app gives Godmode a few seconds to quit before it ends the process.
      await stopProcess(id, liveOf(id), 3).catch((err) => log.warn(`could not stop VM ${id}`, err));
    }),
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
