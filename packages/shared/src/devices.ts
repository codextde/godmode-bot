/**
 * Device groups: several full Godmode apps on different computers that work as one. One computer is the primary: it
 * runs the schedules and is where the apps of the others look while it is there. Every computer keeps a full copy of
 * what is shared (agents, logins, settings, the task board, automations, My tasks, phones) and changes travel both
 * ways, so a secondary keeps every feature while the primary is away and stands in for it: the automations, the board
 * and the phones work there until the primary is back. Any chat can run on any computer and move between them.
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
  /** It stands in for the primary right now (the primary is away). */
  standingIn: boolean;
  /**
   * macOS: whether Godmode there may open the Desktop, Documents and Downloads folders without macOS asking first
   * (Full Disk Access). Without it a command that opens them waits until someone clicks Allow on that computer.
   * null = not a Mac, or not known yet.
   */
  fullDiskAccess: boolean | null;
  /** The same computer is also paired as a runner from an older setup: that runner's id. */
  runnerTwin: ID | null;
}

/**
 * A secondary while its primary is away. `waiting`: it takes over at `takesOverAt`; `active`: it stands in since
 * `since` — automations, the board, messaging and phones work here, and what changes here goes back once the primary
 * is there again.
 */
export interface StandIn {
  state: "off" | "waiting" | "active";
  since: ISODate | null;
  takesOverAt: ISODate | null;
}

/**
 * How browser sign-ins reach the other computers of the group. `own`: each computer signs in by itself with the saved
 * logins, 2FA codes and passkeys (recommended: Google, Microsoft and others sign you out everywhere when the same
 * session shows up on a second computer). `seed`: a computer that has no session for a site yet starts with the
 * primary's, except for sites that bind sessions to one computer.
 */
export type BrowserSignIns = "own" | "seed";

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
  /** Secondaries take over while the primary is away (`standInMinutes` after it went, at once when it said goodbye). */
  standInEnabled: boolean;
  standInMinutes: number;
  /** Secondaries: where this computer stands while its primary is away. */
  standIn: StandIn;
  /** Changes made here that the other computers haven't taken yet. */
  pendingChanges: number;
  browserSignIns: BrowserSignIns;
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
  standInEnabled?: boolean;
  standInMinutes?: number;
  browserSignIns?: BrowserSignIns;
}

/** POST /api/devices/retire-runner: the computer runs the app now, its old runner goes (chats move to the app). */
export interface RetireRunnerInput {
  runnerId: ID;
}

export interface RetireRunnerResult {
  moved: number;
  /** The runner's background service was switched off there too. */
  uninstalled: boolean;
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
