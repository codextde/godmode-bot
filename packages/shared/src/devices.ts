/**
 * Device groups: several full Godmode apps on different computers that work as one. One computer is the primary: it
 * holds what is shared (agents, logins, settings, the task board, automations, My tasks) and runs the schedules. The
 * others are secondaries: their app shows the primary's Godmode, and the chats that work on them stay theirs. Any chat
 * can run on any computer of the group and move between them.
 */
import type { RunnerState } from "./remote";
import type { ID, ISODate } from "./models";

export type DeviceRole = "primary" | "secondary";

/** One computer of the group. */
export interface GroupDevice {
  /** Its id in the primary's runner list (what `runnerId` names); null for the primary itself. */
  id: ID | null;
  name: string;
  role: DeviceRole;
  /** The computer this app runs on. */
  self: boolean;
  state: RunnerState;
  platform: string | null;
  version: string | null;
  lastSeenAt: ISODate | null;
  latencyMs: number | null;
  /** Runs working there right now. */
  activeRuns: number;
  /** Chats that live there. */
  conversations: number;
}

export interface DeviceGroup {
  /** This computer's role; null when it isn't part of a group. */
  role: DeviceRole | null;
  primaryName: string | null;
  /** Secondaries: whether the primary can be reached now. Everything shared waits for it while it can't. */
  primaryOnline: boolean;
  /** Secondaries: why the primary can't be reached, when it can't. */
  primaryError: string | null;
  /** This computer's id in the primary's runner list (null on the primary or alone). */
  selfId: ID | null;
  devices: GroupDevice[];
  /** Where a new chat started on this computer runs unless picked otherwise: null = here. */
  defaultRunOn: ID | null;
  /** The port this computer listens on for the other computers of the group. */
  port: number | null;
  /**
   * The primary continues the work of a computer that went away while chats worked there (its lid closed) after
   * `failoverMinutes`. Without its Claude session the agent picks up from a recap; a hand-off before keeps the session.
   */
  failover: boolean;
  failoverMinutes: number;
}

/** POST /api/devices/invite */
export interface DeviceInvite {
  /** `gmd1.…`, pasted on the computer that joins. */
  code: string;
  primaryName: string;
  addresses: string[];
  port: number;
  expiresAt: ISODate;
}

/** POST /api/devices/join */
export interface JoinGroupInput {
  code: string;
}

/** PATCH /api/devices */
export interface DeviceGroupPatch {
  /** Runner id of a device of the group, "primary", or null for this computer. */
  defaultRunOn?: ID | null;
  /** Primary only. */
  failover?: boolean;
  failoverMinutes?: number;
}

/** POST /api/conversations/:id/move */
export interface MoveChatInput {
  /** The device to move it to (its runner id), or null for the primary. */
  to: ID | null;
  /**
   * Also when a run works there: it stops, the chat moves with everything it did so far, and the agent continues on
   * the other computer.
   */
  force?: boolean;
}

/** POST /api/devices/handoff */
export interface HandoffInput {
  /** The device whose chats move (its runner id), or null for the primary. */
  from: ID | null;
  to: ID | null;
}

export interface HandoffResult {
  moved: ID[];
  failed: { id: ID; title: string; error: string }[];
}
