/**
 * Computer use: agents see and control the human's computer. Like sharing your screen with ChatGPT, the human picks
 * what to share — the whole desktop (every display), one display, a single app window (controlled in the background,
 * without moving the human's cursor or stealing focus) or one tab of a Godmode browser — and the agent works inside it.
 */
import type { ID } from "./models";

/** What an agent may see and control. */
export type ComputerTarget =
  /** Every display, with the real mouse and keyboard (foreground). */
  | { kind: "desktop" }
  /** One display, with the real mouse and keyboard (foreground). */
  | { kind: "display"; displayId: string; name?: string }
  /** One app window, controlled in the background: input goes to the window, not the human's cursor. */
  | { kind: "window"; windowId: number; pid: number; app: string; title: string; bundleId?: string | null }
  /** One tab of a Godmode-managed browser (CDP), controlled in the background. */
  | { kind: "tab"; profileId: ID; targetId: string; title: string; url: string };

export type ComputerTargetKind = ComputerTarget["kind"];

export interface ComputerDisplay {
  /** Platform display id (CGDirectDisplayID on macOS, device name on Windows, output name on Linux). */
  id: string;
  name: string;
  /** Bounds in the desktop's coordinate space (points on macOS, top-left origin). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Physical pixels per point (2 on Retina). */
  scale: number;
  primary: boolean;
}

export interface ComputerWindow {
  id: number;
  pid: number;
  app: string;
  bundleId: string | null;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** On the current Space and not minimized. */
  onScreen: boolean;
  /** Its app is the frontmost app. */
  frontmost: boolean;
}

export interface ComputerTab {
  profileId: ID;
  profileName: string;
  targetId: string;
  title: string;
  url: string;
}

/** GET /api/computer/sources — everything the human can share. */
export interface ComputerSources {
  displays: ComputerDisplay[];
  windows: ComputerWindow[];
  tabs: ComputerTab[];
  /** Why something couldn't be listed (e.g. a missing permission). */
  problems: string[];
}

/** GET /api/computer/status */
export interface ComputerStatus {
  enabled: boolean;
  platform: string;
  /** macOS privacy permissions of the app that runs Godmode. null = not applicable or unknown. */
  permissions: { accessibility: boolean | null; screenRecording: boolean | null };
  /** Godmode's built-in helper (macOS): every display, window capture and background input. */
  native: { available: boolean; detail: string };
  /** Cua Driver (trycua/cua): background control of single windows on macOS, Windows and Linux. */
  cua: { enabled: boolean; installed: boolean; running: boolean; version: string | null; detail: string };
  /** What can be shared on this machine right now. */
  supports: { desktop: boolean; displays: boolean; windows: boolean; tabs: boolean };
}

/** A captured image of a shared source (thumbnails in the share picker). */
export interface ComputerImage {
  /** base64 */
  data: string;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/**
 * Human takeover in the computer live view. x/y are in the coordinate space of the last `computer.frame` of that
 * view (its width × height).
 */
export type ComputerInputEvent =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; count?: number }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "scroll"; x: number; y: number; deltaX?: number; deltaY: number }
  | { type: "key"; key: string; modifiers?: string[] }
  | { type: "text"; text: string };

/** Agent-level computer access for work nobody shared a screen for (routines, delegated tasks). */
export interface AgentComputerConfig {
  /** The agent may control the computer without the human sharing it in the chat. */
  enabled: boolean;
  /** What it controls then; null = the whole desktop. */
  target: ComputerTarget | null;
}

/**
 * A live view stream: `display:<id>`, `window:<pid>:<windowId>` or `tab:<profileId>:<targetId>`. A shared desktop has
 * one view per display.
 */
export type ComputerView = string;

export function computerView(target: ComputerTarget, displayId?: string): ComputerView {
  switch (target.kind) {
    case "desktop":
      return `display:${displayId ?? "primary"}`;
    case "display":
      return `display:${target.displayId}`;
    case "window":
      return `window:${target.pid}:${target.windowId}`;
    case "tab":
      return `tab:${target.profileId}:${target.targetId}`;
  }
}

/** Short human label, e.g. "Safari — Apple", "Studio Display", "Entire desktop". */
export function computerTargetLabel(target: ComputerTarget): string {
  switch (target.kind) {
    case "desktop":
      return "Entire desktop";
    case "display":
      return target.name || `Display ${target.displayId}`;
    case "window":
      return target.title ? `${target.app} — ${target.title}` : target.app;
    case "tab":
      return target.title || target.url || "Browser tab";
  }
}

/** Same shared thing (ignores display names and window titles, which change). */
export function sameComputerTarget(a: ComputerTarget | null | undefined, b: ComputerTarget | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "desktop":
      return true;
    case "display":
      return a.displayId === (b as typeof a).displayId;
    case "window":
      return a.windowId === (b as typeof a).windowId && a.pid === (b as typeof a).pid;
    case "tab":
      return a.profileId === (b as typeof a).profileId && a.targetId === (b as typeof a).targetId;
  }
}
