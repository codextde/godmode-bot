import { INTERFACE_MODES, THEMES } from "@godmode/shared";

/** Ranges for the numbers a phone or an agent may set (as in the app); for text, the maximum length. */
const SETTING_LIMITS: Record<string, [min: number, max: number]> = {
  "runner.maxConcurrentRuns": [1, 32],
  "runner.runTimeoutMinutes": [0, 1440],
  "runner.stallMinutes": [3, 240],
  "runner.loopRepeats": [3, 50],
  "runner.autoCompactPercent": [0, 95],
  "browser.keepAliveMinutes": [0, 1440],
  "computer.liveViewFps": [1, 10],
  "computer.screenshotMaxSize": [640, 1568],
  "vm.idleStopMinutes": [0, 1440],
  "voice.rate": [0.5, 2],
  "phone.maxMinutes": [1, 60],
  "general.userName": [0, 80],
};

/** Settings that take one of a few words. */
export const SETTING_CHOICES: Record<string, readonly string[]> = {
  "general.theme": THEMES,
  "general.mode": INTERFACE_MODES,
};

export function settingInRange(key: string, value: unknown): boolean {
  const choices = SETTING_CHOICES[key];
  if (choices && typeof value === "string") return choices.includes(value);
  const limit = SETTING_LIMITS[key];
  if (!limit || value === null) return true;
  const [min, max] = limit;
  if (typeof value === "string") return value.length <= max;
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function sameSettingShape(value: unknown, current: unknown, nullable: boolean): boolean {
  if (value === null) return nullable || current === null;
  if (current === null || current === undefined) return nullable && typeof value === "number";
  if (typeof current !== "object" || Array.isArray(current)) return typeof value === typeof current;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const shape = current as Record<string, unknown>;
  return Object.entries(value as Record<string, unknown>).every(([k, v]) => Object.hasOwn(shape, k) && sameSettingShape(v, shape[k], false));
}
