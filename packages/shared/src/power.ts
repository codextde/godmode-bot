/** Lid-closed mode: a MacBook keeps working with its lid closed (see PowerSettings). */

/** Battery charges the setting offers; 0 = keep going until the battery is empty. */
export const POWER_MIN_BATTERY_OPTIONS = [0, 10, 20, 30, 50] as const;

export type PowerState =
  /** Turned off in Godmode. */
  | "off"
  /** Closing the lid keeps the Mac awake. */
  | "on"
  /** Only while agents work, and none does: the Mac may sleep. */
  | "idle"
  /** On battery at or below the limit: the Mac may sleep until it charges. */
  | "low_battery"
  /** Turned on, but macOS refused the change (see `error`). */
  | "error";

export interface PowerStatus {
  /** A Mac with a lid: the mode exists here. */
  supported: boolean;
  /** The setting. */
  enabled: boolean;
  /** Sleep is disabled right now (by Godmode or by hand). */
  active: boolean;
  state: PowerState;
  /** Godmode turned sleep off (and gives it back), as opposed to a `disablesleep` set by hand. */
  owned: boolean;
  /** Godmode may switch it without asking for the password again. */
  permission: boolean;
  lidClosed: boolean | null;
  battery: { percent: number; charging: boolean } | null;
  error: string | null;
}
