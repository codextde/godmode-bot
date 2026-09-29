/**
 * Computer use service: what can be shared (displays, windows, browser tabs), engines per shared target, status and
 * permissions, and the per-run state the `computer` MCP tools work with (the last screenshot per view, so the
 * coordinates the model reads off an image map back to the screen).
 */
import type { ComputerDisplay, ComputerImage, ComputerSources, ComputerStatus, ComputerTab, ComputerTarget, ComputerWindow } from "@godmode/shared";
import { computerTargetLabel, computerView } from "@godmode/shared";
import { listPages } from "../browser/cdp";
import { allRunning } from "../browser/state";
import { config } from "../config";
import { get } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { onSettingsApplied } from "../services/runtime";
import { badRequest, HttpError } from "../util";
import { cuaDriverInstalled, cuaDriverRunning, cuaLastError, getCuaDriver, stopCuaDriver } from "./cua";
import { EngineError, errorMessage, type ComputerEngine } from "./engine";
import { desktopEngine } from "./engines/desktop";
import { TabEngine } from "./engines/tab";
import { windowEngine } from "./engines/window";
import type { Shot } from "./geometry";
import { getHelper, helperAvailability, stopHelper } from "./helper";
import { isGodmodeTab, isGodmodeWindow } from "./self";

const log = logger("computer");

export function computerEnabled(): boolean {
  try {
    return getSettings().computer.enabled;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Engines                                                              */
/* ------------------------------------------------------------------ */

/** `agent`: the engine a run acts through (window shares show the agent cursor for its input, not the human's). */
export function createEngine(target: ComputerTarget, opts: { agent?: boolean } = {}): ComputerEngine {
  switch (target.kind) {
    case "desktop":
    case "display":
      return desktopEngine(target);
    case "window":
      return windowEngine(target, { agent: opts.agent ?? false });
    case "tab":
      return new TabEngine(target);
  }
}

/** Target for a view key ("display:5", "window:812:4711", "tab:<profile>:<target>"). */
export function targetForView(view: string): ComputerTarget {
  const [kind, a, b] = view.split(":");
  if (kind === "display" && a) return a === "primary" ? { kind: "desktop" } : { kind: "display", displayId: a };
  if (kind === "window" && a && b && /^\d+$/.test(a) && /^\d+$/.test(b)) {
    return { kind: "window", pid: Number(a), windowId: Number(b), app: "", title: "" };
  }
  if (kind === "tab" && a && b) return { kind: "tab", profileId: a, targetId: view.slice(`tab:${a}:`.length), title: "", url: "" };
  throw badRequest(`Unknown view "${view}"`);
}

/**
 * Serialized desktop control: every share of the desktop or a display moves the same mouse, so runs using it take
 * turns. Background shares (a window, a tab) are only exclusive per window/tab.
 */
export function computerLockKey(target: ComputerTarget): string {
  switch (target.kind) {
    case "desktop":
    case "display":
      return "desktop";
    case "window":
      return `window:${target.pid}:${target.windowId}`;
    case "tab":
      return `tab:${target.profileId}:${target.targetId}`;
  }
}

/* ------------------------------------------------------------------ */
/* Sources                                                              */
/* ------------------------------------------------------------------ */

async function listTabs(): Promise<ComputerTab[]> {
  const tabs: ComputerTab[] = [];
  for (const rb of allRunning()) {
    if (rb.stopping) continue;
    const profile = get<{ name: string }>("SELECT name FROM browser_profiles WHERE id = ?", rb.profileId);
    try {
      for (const p of await listPages(rb.client, rb.port)) {
        tabs.push({ profileId: rb.profileId, profileName: profile?.name ?? "Browser", targetId: p.targetId, title: p.title, url: p.url });
      }
    } catch (err) {
      log.debug(`could not list tabs of ${rb.profileId}`, err);
    }
  }
  return tabs;
}

async function nativeSources(): Promise<{ displays: ComputerDisplay[]; windows: ComputerWindow[]; problems: string[] }> {
  const helper = await getHelper();
  const problems: string[] = [];
  const perms = await helper.permissions().catch(() => null);
  if (perms && !perms.screenRecording) problems.push("Screen Recording permission is missing — window titles and pictures are unavailable until you allow it.");
  if (perms && !perms.accessibility) problems.push("Accessibility permission is missing — agents can't click or type until you allow it.");
  const [displays, windows] = await Promise.all([helper.displays(), helper.windows()]);
  return {
    displays: displays.map((d) => ({ ...d, id: String(d.id) })),
    windows: windows.map((w) => ({
      id: w.id,
      pid: w.pid,
      app: w.app,
      bundleId: w.bundleId,
      title: w.title,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      onScreen: w.onScreen,
      frontmost: w.frontmost,
    })),
    problems,
  };
}

/** Windows / Linux: displays from the native helper (every monitor) or Cua Driver (primary), windows from Cua Driver. */
async function otherSources(): Promise<{ displays: ComputerDisplay[]; windows: ComputerWindow[]; problems: string[] }> {
  const problems: string[] = [];
  let displays: ComputerDisplay[] = [];
  const helper = await getHelper().catch((err) => {
    problems.push(errorMessage(err));
    return null;
  });
  if (helper) displays = (await helper.displays()).map((d) => ({ ...d, id: String(d.id) }));

  let windows: ComputerWindow[] = [];
  if (!getSettings().computer.useCuaDriver) {
    problems.push("Single windows can be shared once Cua Driver is turned on in Settings → Computer.");
  } else {
    try {
      const cua = await getCuaDriver();
      if (!displays.length) {
        const size = await cua.call("get_screen_size", {}).catch(() => null);
        const w = Number(size?.structured.width) || 0;
        const h = Number(size?.structured.height) || 0;
        const scale = Number(size?.structured.scale_factor) || 1;
        // Cua Driver's desktop works in native pixels of the primary display.
        if (w && h) displays = [{ id: "primary", name: "Primary display", x: 0, y: 0, width: Math.round(w * scale), height: Math.round(h * scale), scale: 1, primary: true }];
      }
      windows = (await cua.listWindows())
        .filter((x) => x.bounds.width >= 60 && x.bounds.height >= 40)
        .map((x) => ({
          id: x.window_id,
          pid: x.pid,
          app: x.app_name,
          bundleId: null,
          title: x.title,
          x: x.bounds.x,
          y: x.bounds.y,
          width: x.bounds.width,
          height: x.bounds.height,
          onScreen: x.is_on_screen,
          frontmost: false,
        }));
    } catch (err) {
      problems.push(errorMessage(err));
    }
  }
  return { displays, windows, problems };
}

export { isGodmodeTab, isGodmodeWindow } from "./self";

/** Everything the human can share right now. */
export async function listSources(): Promise<ComputerSources> {
  if (!computerEnabled()) throw new HttpError(409, "Computer use is turned off in Settings → Computer.", "computer_disabled");
  const tabs = (await listTabs()).filter((t) => !isGodmodeTab(t.url));
  try {
    const local = process.platform === "darwin" ? await nativeSources() : await otherSources();
    return { ...local, windows: local.windows.filter((w) => !isGodmodeWindow(w)), tabs };
  } catch (err) {
    return { displays: [], windows: [], tabs, problems: [errorMessage(err)] };
  }
}

/** Small picture of a display, window or tab for the share picker. */
export async function thumbnail(view: string, maxEdge = 480): Promise<ComputerImage> {
  if (!computerEnabled()) throw new HttpError(409, "Computer use is turned off in Settings → Computer.", "computer_disabled");
  const engine = createEngine(targetForView(view));
  try {
    const shot = await engine.capture(view, { maxEdge: Math.min(Math.max(maxEdge, 96), 960), purpose: "thumbnail", quality: 0.6 });
    return { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height };
  } catch (err) {
    throw toHttp(err);
  } finally {
    await engine.dispose();
  }
}

export function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof EngineError) {
    const status = err.code === "gone" ? 404 : err.code === "permission" ? 403 : err.code === "bad_request" ? 400 : err.code === "unsupported" ? 424 : 409;
    return new HttpError(status, err.message, `computer_${err.code}`);
  }
  return new HttpError(500, errorMessage(err), "computer_failed");
}

/** Does the shared thing still exist (and may it be shared)? Throws a 4xx with a message for the human. */
export async function validateTarget(target: ComputerTarget): Promise<ComputerTarget> {
  if (!computerEnabled()) throw new HttpError(409, "Computer use is turned off in Settings → Computer.", "computer_disabled");
  if (target.kind === "window" && isGodmodeWindow(target)) throw new HttpError(400, "Godmode's own window can't be shared with an agent.", "computer_self");
  const engine = createEngine(target);
  try {
    const views = await engine.views();
    if (target.kind === "tab" && isGodmodeTab(await tabUrl(target))) {
      throw new HttpError(400, "A tab showing Godmode itself can't be shared with an agent.", "computer_self");
    }
    if (target.kind === "display") return { ...target, name: views[0]?.label ?? target.name };
    if (target.kind === "tab") return { ...target, title: views[0]?.label ?? target.title };
    return target;
  } catch (err) {
    throw toHttp(err);
  } finally {
    await engine.dispose();
  }
}

async function tabUrl(target: Extract<ComputerTarget, { kind: "tab" }>): Promise<string> {
  const rb = allRunning().find((b) => b.profileId === target.profileId);
  if (!rb) return target.url;
  try {
    const { targetInfo } = await rb.client.send<{ targetInfo: { url: string } }>("Target.getTargetInfo", { targetId: target.targetId });
    return targetInfo.url;
  } catch {
    return target.url;
  }
}

/* ------------------------------------------------------------------ */
/* Status & permissions                                                 */
/* ------------------------------------------------------------------ */

export async function computerStatus(): Promise<ComputerStatus> {
  const settings = getSettings().computer;
  const platform = process.platform;
  const native = await helperAvailability();
  let permissions: ComputerStatus["permissions"] = { accessibility: null, screenRecording: null };
  if (native.available && platform === "darwin") {
    const p = await getHelper()
      .then((h) => h.permissions())
      .catch(() => null);
    if (p) permissions = p;
  }
  const installed = await cuaDriverInstalled();
  const running = cuaDriverRunning();
  const cuaDetail = !settings.useCuaDriver
    ? "Turned off"
    : running
      ? `Running (v${running.version})`
      : installed.installed
        ? "Ready — starts when an agent controls a window"
        : (cuaLastError() ?? "Not installed");
  const cuaUsable = settings.useCuaDriver && installed.installed;
  const mac = platform === "darwin";
  return {
    enabled: settings.enabled,
    platform,
    permissions,
    native: { available: native.available, detail: native.detail },
    cua: { enabled: settings.useCuaDriver, installed: installed.installed, running: !!running, version: running?.version ?? null, detail: cuaDetail },
    supports: {
      desktop: native.available || cuaUsable,
      displays: native.available,
      windows: mac ? native.available || cuaUsable : cuaUsable,
      tabs: true,
    },
  };
}

/** Ask macOS for Accessibility + Screen Recording (the dialogs name the app that runs Godmode). */
export async function requestComputerPermissions(): Promise<ComputerStatus> {
  if (process.platform !== "darwin") return computerStatus();
  try {
    const helper = await getHelper();
    await helper.call("requestPermissions", { accessibility: true, screenRecording: true }, 30_000);
  } catch (err) {
    throw toHttp(err);
  }
  bus.changed("computer");
  return computerStatus();
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

export interface RunComputer {
  runId: string;
  agentId: string;
  conversationId: string;
  target: ComputerTarget;
  engine: ComputerEngine;
  /** The last screenshot the model saw of each view. */
  shots: Map<string, Shot>;
  /** View of the latest screenshot — the coordinate space of the next action. */
  view: string | null;
  /** Tool calls of one run are handled one at a time. */
  queue: Promise<unknown>;
  /** Where the target came from: shared in the chat, or the agent's own unattended access. */
  source: "share" | "agent";
  /** Set when the human stops sharing (or access is turned off): nothing may act anymore. */
  revoked: boolean;
  /** Aborts long actions (typing, waiting, held keys) when access is revoked. */
  abort: AbortController;
}

export class RevokedError extends Error {}

/** Throw when the run's access was revoked (checked before and during every action). */
export function assertActive(rc: RunComputer) {
  if (rc.revoked || runs.get(rc.runId) !== rc) throw new RevokedError("The human stopped sharing — you no longer have access to the computer.");
}

const runs = new Map<string, RunComputer>();

/** Give a run access to a shared target (called by the runner before Claude starts). */
export function attachComputer(runId: string, agentId: string, conversationId: string, target: ComputerTarget, source: RunComputer["source"] = "share"): RunComputer {
  const existing = runs.get(runId);
  if (existing) return existing;
  const rc: RunComputer = {
    runId,
    agentId,
    conversationId,
    target,
    engine: createEngine(target, { agent: true }),
    shots: new Map(),
    view: null,
    queue: Promise.resolve(),
    source,
    revoked: false,
    abort: new AbortController(),
  };
  runs.set(runId, rc);
  log.info(`run ${runId} controls ${computerTargetLabel(target)} (${rc.engine.name})`);
  return rc;
}

export async function detachComputer(runId: string): Promise<void> {
  const rc = runs.get(runId);
  if (!rc) return;
  rc.revoked = true;
  rc.abort.abort();
  runs.delete(runId);
  await rc.engine.dispose().catch(() => {});
}

/** Revoke unattended access of an agent's running runs (its computer access was turned off or changed). */
export async function detachAgentComputer(agentId: string): Promise<void> {
  for (const rc of [...runs.values()]) if (rc.agentId === agentId && rc.source === "agent") await detachComputer(rc.runId);
}

export function runComputer(runId: string): RunComputer | null {
  return runs.get(runId) ?? null;
}

/** Runs currently controlling something (for the UI: "agent is working here"). */
export function activeComputerRuns(): { runId: string; conversationId: string; target: ComputerTarget }[] {
  return [...runs.values()].map((r) => ({ runId: r.runId, conversationId: r.conversationId, target: r.target }));
}

/** The view a share opens on: its single view, or the primary display of a desktop. */
export function defaultView(target: ComputerTarget): string {
  return computerView(target);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

export async function shutdownComputer(): Promise<void> {
  for (const runId of [...runs.keys()]) await detachComputer(runId);
  await Promise.all([stopHelper().catch(() => {}), stopCuaDriver().catch(() => {})]);
}

onSettingsApplied(() => {
  try {
    const s = getSettings().computer;
    // Turning computer use off revokes every run's access right away.
    if (!s.enabled) for (const runId of [...runs.keys()]) void detachComputer(runId);
    if (!s.useCuaDriver || !s.enabled) void stopCuaDriver();
  } catch {
    /* settings not loaded */
  }
});
