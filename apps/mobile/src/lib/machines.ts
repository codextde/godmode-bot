import type {
  AndroidAssignInput,
  AndroidConnectInput,
  AndroidConnectResult,
  AndroidDevice,
  AndroidDevicePatch,
  AndroidExecResult,
  BrowserProfile,
  ChromeImportInput,
  ChromeImportResult,
  ComputerDisplay,
  ComputerImage,
  ComputerSources,
  ComputerTab,
  ComputerTarget,
  ComputerWindow,
  LocalChromeProfile,
  ProfileUseStatus,
  ProfileUseSyncInput,
  ProfileUseSyncResult,
  Vm,
  VmAssignInput,
  VmExecResult,
  VmImagePreset,
  VmInput,
  VmPatch,
  VmStatus,
} from "@godmode/shared";
import { computerTargetLabel, computerView } from "@godmode/shared";
import { router, type Href } from "expo-router";
import { request } from "./api";
import { currentLanguage, t } from "./i18n";
import { pk } from "./programs";
import { qk, queryClient } from "./query";

/**
 * This computer's machines the way the desktop app manages them (full-access phones only): what can be watched on its
 * screen, macOS VMs, Android phones and the browser's sessions.
 */
const enc = encodeURIComponent;
const LONG = 30 * 60_000;

export const machinesApi = {
  computer: {
    /** Displays, windows and Godmode browser tabs that can be watched and controlled. */
    sources: () => request<ComputerSources>("GET", "/api/computer/sources"),
    thumbnail: (view: string, size = 480) => request<ComputerImage>("GET", `/api/computer/thumbnail?view=${enc(view)}&size=${size}`),
  },

  vms: {
    status: () => request<VmStatus>("GET", "/api/vms/status"),
    /** Answers at once with state "creating"; the image downloads and the disk is made in the background. */
    create: (input: VmInput) => request<Vm>("POST", "/api/vms", input, 120_000),
    /** CPU, memory and display apply on the next start; the disk only grows, and only while stopped. */
    update: (id: string, patch: VmPatch) => request<Vm>("PATCH", `/api/vms/${enc(id)}`, patch, 60_000),
    remove: (id: string, keepFiles: boolean) => request<{ ok: true }>("DELETE", `/api/vms/${enc(id)}${keepFiles ? "?keepFiles=1" : ""}`, undefined, 120_000),
    /** A new disk from the VM's image; the shared folder and who uses it stay. */
    reset: (id: string, start: boolean) => request<Vm>("POST", `/api/vms/${enc(id)}/reset`, { start }, 120_000),
    /** A copy of a stopped VM. */
    duplicate: (id: string) => request<Vm>("POST", `/api/vms/${enc(id)}/duplicate`, {}, LONG),
    exec: (id: string, command: string) => request<VmExecResult>("POST", `/api/vms/${enc(id)}/exec`, { command, timeoutSeconds: 120 }, 130_000),
    assign: (id: string, input: VmAssignInput) => request<Vm>("POST", `/api/vms/${enc(id)}/assign`, input),
    /** A downloaded image, to free space; VMs made from it keep working. */
    removeImage: (image: string) => request<{ ok: true }>("DELETE", `/api/vms/images/${enc(image)}`, undefined, 120_000),
  },

  android: {
    /** Asks adb again which phones are there. */
    rescan: () => request<unknown>("POST", "/api/android/refresh", {}, 30_000),
    /** Wireless debugging: pairs with the six-digit code first when one is given, then connects. */
    connect: (input: AndroidConnectInput) => request<AndroidConnectResult>("POST", "/api/android/connect", input, 60_000),
    update: (id: string, patch: AndroidDevicePatch) => request<AndroidDevice>("PATCH", `/api/android/devices/${enc(id)}`, patch),
    forget: (id: string) => request<{ ok: true }>("DELETE", `/api/android/devices/${enc(id)}`),
    disconnect: (id: string) => request<AndroidDevice>("POST", `/api/android/devices/${enc(id)}/disconnect`, {}, 30_000),
    exec: (id: string, command: string) => request<AndroidExecResult>("POST", `/api/android/devices/${enc(id)}/exec`, { command }, 130_000),
    assign: (id: string, input: AndroidAssignInput) => request<AndroidDevice>("POST", `/api/android/devices/${enc(id)}/assign`, input),
  },

  browser: {
    /** With a chat: that chat's tab (opened if it has none), else the active one. */
    navigate: (id: string, url: string, conversationId: string | null) =>
      request<{ ok: true }>("POST", `/api/browser/profiles/${enc(id)}/navigate`, { url, conversationId }, 60_000),
    /** Which workspace a profile belongs to (null: every workspace), and whether it is that one's default. */
    assign: (id: string, workspaceId: string | null, isDefault?: boolean) =>
      request<BrowserProfile>("PATCH", `/api/browser/profiles/${enc(id)}`, isDefault === undefined ? { workspaceId } : { workspaceId, isDefault }),
    chromeProfiles: () => request<LocalChromeProfile[]>("GET", "/api/browser/chrome-profiles"),
    import: (id: string, input: ChromeImportInput) => request<ChromeImportResult>("POST", `/api/browser/profiles/${enc(id)}/import`, input, 5 * 60_000),
    profileUse: () => request<ProfileUseStatus>("GET", "/api/browser/profile-use"),
    profileUseInstall: () => request<ProfileUseStatus>("POST", "/api/browser/profile-use/install", {}, 10 * 60_000),
    /** Can take several minutes. */
    profileUseSync: (input: ProfileUseSyncInput) => request<ProfileUseSyncResult>("POST", "/api/browser/profile-use/sync", input, LONG),
  },
};

export const mk = {
  computerSources: ["computer", "sources"],
  thumbnail: (view: string) => ["computer", "thumbnail", view],
  vmStatus: pk.vmStatus,
  androidStatus: pk.androidStatus,
  chromeProfiles: ["browser", "chrome-profiles"],
  profileUse: ["browser", "profile-use"],
} as const;

/** The changed VM in the list at once (the computer's `vm.updated` events follow). */
export function putVm(vm: Vm) {
  queryClient.setQueryData<Vm[]>(qk.vms, (old) => (old ? (old.some((v) => v.id === vm.id) ? old.map((v) => (v.id === vm.id ? vm : v)) : [...old, vm]) : old));
  void queryClient.invalidateQueries({ queryKey: mk.vmStatus });
}

export function dropVm(id: string) {
  queryClient.setQueryData<Vm[]>(qk.vms, (old) => old?.filter((v) => v.id !== id));
  void queryClient.invalidateQueries({ queryKey: qk.vms });
}

export function putPhone(device: AndroidDevice) {
  queryClient.setQueryData<AndroidDevice[]>(qk.androidDevices, (old) => old?.map((d) => (d.id === device.id ? device : d)));
  void queryClient.invalidateQueries({ queryKey: qk.androidDevices });
}

export const refreshPhones = () =>
  Promise.all([queryClient.invalidateQueries({ queryKey: qk.androidDevices }), queryClient.invalidateQueries({ queryKey: mk.androidStatus })]);

/** Back to where the screen was opened from; to `fallback` when it was opened on its own (a link). */
export function leave(fallback: Href) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/* ------------------------------------------------------------------ */
/* Computer                                                             */
/* ------------------------------------------------------------------ */

export function windowTarget(w: ComputerWindow): ComputerTarget {
  return { kind: "window", windowId: w.id, pid: w.pid, app: w.app, title: w.title, bundleId: w.bundleId };
}

export function displayTarget(d: ComputerDisplay): ComputerTarget {
  return { kind: "display", displayId: d.id, name: d.name };
}

export function tabTarget(t: ComputerTab): ComputerTarget {
  return { kind: "tab", profileId: t.profileId, targetId: t.targetId, title: t.title, url: t.url };
}

/** Opens a display, window or tab of this computer in the live view, to watch and take control. */
export function sourceHref(target: ComputerTarget) {
  const note = t(target.kind === "window" ? "machines:computer.window" : target.kind === "tab" ? "machines:computer.tab" : "machines:computer.display");
  return { pathname: "/live" as const, params: { kind: "share", id: computerView(target), title: computerTargetLabel(target, currentLanguage()), note } };
}

/** Main display first. */
export function sortedDisplays(displays: ComputerDisplay[]): ComputerDisplay[] {
  return [...displays].sort((a, b) => Number(b.primary) - Number(a.primary));
}

/* ------------------------------------------------------------------ */
/* VMs                                                                  */
/* ------------------------------------------------------------------ */

export const MAX_VM_NAME = 60;
export const MAX_DISK_GB = 4000;
export const VM_DISPLAYS = ["1280x800", "1440x900", "1920x1200"];
const MEMORY_GB = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

/** Decimal GB, like the computer's free-space figure and Finder. */
export function formatGb(bytes: number): string {
  const gb = bytes / 1e9;
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

export function formatMemory(mb: number): string {
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export const formatDisplay = (display: string) => display.replace("x", " × ");

export function presetOf(image: string, presets: VmImagePreset[] | undefined): VmImagePreset | undefined {
  return presets?.find((p) => p.image === image || p.id === image);
}

/** "macOS Tahoe" for Godmode's images, else the reference's last part. */
export function imageName(image: string, presets: VmImagePreset[] | undefined): string {
  return presetOf(image, presets)?.name ?? image.replace(/^.*\//, "");
}

/** Where the shared folder shows inside the VM: "~/Godmode". */
export const guestFolderLabel = (vm: Pick<Vm, "guestSharedDir">) => vm.guestSharedDir.replace(/^\/Users\/[^/]+/, "~");

/** "macOS VM", then "macOS VM 2", … */
export function nextVmName(vms: Pick<Vm, "name">[], base = "macOS VM"): string {
  const taken = new Set(vms.map((v) => v.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Up to what the computer allows (its memory less 2 GB), plus the current value when it lies in between. */
export function memoryOptions(hostMb: number, current?: number): number[] {
  const max = Math.max(2048, hostMb - 2048);
  const opts = MEMORY_GB.map((g) => g * 1024).filter((mb) => mb <= max);
  if (current && !opts.includes(current)) opts.push(current);
  return opts.sort((a, b) => a - b);
}

export const displayOptions = (current?: string) => (current && !VM_DISPLAYS.includes(current) ? [...VM_DISPLAYS, current] : VM_DISPLAYS);

/** The computer's own defaults: half the cores (2 to 4), 8 GB on Macs with 16 GB or more. */
export function defaultSpecs(host: VmStatus["host"]) {
  const cpu = Math.min(host.cpus, Math.max(2, Math.min(4, Math.floor(host.cpus / 2))));
  const memoryMb = host.memoryMb >= 16 * 1024 ? 8192 : 4096;
  const opts = memoryOptions(host.memoryMb);
  return { cpu, memoryMb: opts.includes(memoryMb) ? memoryMb : (opts.at(-1) ?? 2048) };
}

export function diskValid(disk: string, min: number): boolean {
  const n = Number(disk);
  return !!disk.trim() && Number.isInteger(n) && n >= min && n <= MAX_DISK_GB;
}

/** Godmode is doing something with the VM right now. */
export const vmBusy = (state: Vm["state"]) => state === "creating" || state === "starting" || state === "stopping";

/* ------------------------------------------------------------------ */
/* Android                                                              */
/* ------------------------------------------------------------------ */

/** "192.168.1.20:37099" typed into an address field: host and port. */
export function splitAddress(text: string): { host: string; port?: number } {
  const m = text.trim().match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
  if (m && !m[1]!.includes(":")) return { host: m[1]!, port: Number(m[2]) };
  return { host: text.trim() };
}

/* ------------------------------------------------------------------ */
/* Browser                                                              */
/* ------------------------------------------------------------------ */

/** What is typed into the address bar, as an address the browser opens. */
export function normalizeUrl(text: string): string {
  const raw = text.trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(about|data|chrome):/i.test(raw)) return raw;
  return `https://${raw}`;
}

/** "github.com" from "https://www.github.com/x", or the text itself when it isn't an address. */
export function domainOf(text: string): string {
  const raw = text.trim().toLowerCase();
  try {
    return new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}
