/**
 * Android phones: real devices (and emulators) connected to this computer over adb — by USB cable or Wi-Fi. Godmode
 * finds them on its own; a phone is assigned to agents (every run of the agent) and to chats (runs in that chat), and
 * such a run sees its screen, taps, swipes, types, starts apps and runs shell commands on it. The human watches and
 * takes over through the same screen.
 */
import type { ID, ISODate } from "./models";

/** `disconnected` = known, but not plugged in (or not reachable over Wi-Fi) right now. */
export type AndroidDeviceState = "connected" | "unauthorized" | "offline" | "disconnected";

export type AndroidConnection = "usb" | "wifi" | "emulator";

export type AndroidDeviceKind = "phone" | "emulator";

/** What a phone is assigned to. */
export type AndroidAssignmentKind = "agent" | "conversation";

export interface AndroidAssignment {
  kind: AndroidAssignmentKind;
  id: ID;
  name: string;
}

export interface AndroidBattery {
  /** 0–100 */
  level: number;
  charging: boolean;
}

export interface AndroidDevice {
  id: ID;
  /** The device's own serial number (emulators: their AVD name). */
  serial: string;
  /** The human's name for it; starts as "<maker> <model>". */
  name: string;
  /** What the phone is for; agents read it, e.g. "Test phone, signed in to the shop's TikTok account". */
  description: string;
  kind: AndroidDeviceKind;
  manufacturer: string | null;
  model: string | null;
  /** e.g. "15" */
  androidVersion: string | null;
  sdk: number | null;
  /** Screen size in pixels, upright. */
  width: number | null;
  height: number | null;
  state: AndroidDeviceState;
  /** How it is connected right now (null while disconnected). */
  connection: AndroidConnection | null;
  /** adb's name for the connection in use, e.g. "R58M12ABCDE" or "192.168.1.20:5555". */
  adbSerial: string | null;
  battery: AndroidBattery | null;
  /** The screen is on (null = unknown or disconnected). */
  awake: boolean | null;
  /** An agent is working on the phone right now. */
  busy: boolean;
  lastSeenAt: ISODate | null;
  /** Agents and chats that use the phone. */
  assignments: AndroidAssignment[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** A connection adb sees that can't be used yet (the phone hasn't allowed this computer, or is still starting). */
export interface AndroidPendingDevice {
  adbSerial: string;
  state: "unauthorized" | "offline" | "no-permissions";
  connection: AndroidConnection;
  /** What the human has to do. */
  hint: string;
}

/** GET /api/android/status */
export interface AndroidStatus {
  adb: {
    installed: boolean;
    version: string | null;
    path: string | null;
    /** Installed by Godmode into its data directory (vs. found on the system). */
    managed: boolean;
  };
  /** Godmode can download adb for this platform. */
  canInstall: boolean;
  pending: AndroidPendingDevice[];
  /** Why devices can't be listed, when adb itself fails. */
  error: string | null;
}

export interface AndroidDevicePatch {
  name?: string;
  description?: string;
}

/** POST /api/android/devices/:id/assign */
export interface AndroidAssignInput {
  kind: AndroidAssignmentKind;
  id: ID;
  /** false = remove the assignment. */
  assigned: boolean;
}

/** Keys the human (and agents) can press on a phone. */
export const ANDROID_KEYS = [
  "home",
  "back",
  "recents",
  "power",
  "wake",
  "sleep",
  "volume_up",
  "volume_down",
  "mute",
  "enter",
  "delete",
  "tab",
  "escape",
  "space",
  "menu",
  "search",
  "up",
  "down",
  "left",
  "right",
  "notifications",
  "quick_settings",
  "paste",
  "copy",
  "select_all",
  "camera",
  "play_pause",
] as const;

export type AndroidKey = (typeof ANDROID_KEYS)[number];

/** Human takeover in the live view. Coordinates are pixels of the frame the human saw. */
export type AndroidInputEvent =
  | { type: "tap"; x: number; y: number }
  | { type: "long_press"; x: number; y: number; durationMs?: number }
  | { type: "swipe"; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: "key"; key: AndroidKey }
  | { type: "text"; text: string };

/** POST /api/android/devices/:id/input */
export interface AndroidInputRequest {
  event: AndroidInputEvent;
  /** Size of the picture the coordinates refer to. */
  frame?: { width: number; height: number };
}

/** GET /api/android/devices/:id/screenshot */
export interface AndroidScreenshot {
  /** base64 */
  data: string;
  mime: "image/png";
  width: number;
  height: number;
  /** Size of the phone's screen as it is turned right now, in its own pixels. */
  screen: { width: number; height: number };
}

/** POST /api/android/devices/:id/exec */
export interface AndroidExecInput {
  command: string;
  timeoutSeconds?: number;
}

export interface AndroidExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** POST /api/android/connect: reach a phone over Wi-Fi (Developer options → Wireless debugging). */
export interface AndroidConnectInput {
  /** IP address or host name shown on the phone. */
  host: string;
  /** Port shown on the phone (default 5555). */
  port?: number;
  /** "Pair device with pairing code": the six digits, with the pairing port in `pairingPort`. */
  pairingCode?: string;
  pairingPort?: number;
}

export interface AndroidConnectResult {
  ok: boolean;
  message: string;
}

/** A short label for a phone: "Pixel 8 · Android 15". */
export function androidSummary(device: Pick<AndroidDevice, "manufacturer" | "model" | "androidVersion" | "kind">): string {
  const maker = device.manufacturer && device.model && !device.model.toLowerCase().startsWith(device.manufacturer.toLowerCase()) ? `${device.manufacturer} ` : "";
  const what = device.kind === "emulator" ? "Emulator" : device.model ? `${maker}${device.model}` : "Android phone";
  return device.androidVersion ? `${what} · Android ${device.androidVersion}` : what;
}
