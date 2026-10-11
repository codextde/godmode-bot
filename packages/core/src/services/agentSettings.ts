import { HttpError } from "../util";
import { audit } from "./audit";
import { applyRuntimeSettings } from "./runtime";
import { getSettings, updateSettings } from "./settings";
import { sameSettingShape, settingInRange } from "./settingShape";
import { checkSettingsPatch } from "./settingsPatch";

type Sections = Record<string, unknown>;

/**
 * Settings an agent may change, by section, down to the single setting (`dreaming.model`). The rest is the human's: what
 * guards secrets or names where they are sent, opens Godmode to other devices, decides which programs run and what
 * agents may touch on this computer, shows the human what agents do, ends up in every agent's prompt (the user's name,
 * the instructions for all: agents that read raw secrets follow them too), merges code into Godmode by itself, deletes
 * for good, or brakes and caps agents. A new setting is closed until it is added here.
 */
const AGENT_SETTINGS: Record<string, readonly string[]> = {
  general: ["theme", "minimizeToTray"],
  runner: ["model", "fallbackModel", "effort", "ultracode", "maxConcurrentRuns", "runTimeoutMinutes", "autoContinueOnLimit", "resumeAfterRestart", "stallMinutes", "loopRepeats"],
  browser: ["headless", "keepAliveMinutes", "stealth", "muteAudio"],
  computer: ["agentCursor", "liveViewFps", "screenshotMaxSize"],
  vm: ["onQuit", "idleStopMinutes"],
  voice: ["enabled", "autoSpeak", "language", "sttModel", "ttsModel", "ttsVoice", "elevenlabsVoiceId", "browserVoice", "rate"],
  memory: [
    "autoCommit",
    "reflectAfterRun",
    "injectMemory",
    "dreaming.enabled",
    "dreaming.cron",
    "dreaming.model",
    "dreaming.maxMemoryChars",
    "dreaming.minNewExchanges",
    "dreaming.refreshDays",
    "dreaming.tidyWorkspace",
  ],
  diagnostics: ["verbose"],
  maintenance: ["autoFix", "autoUpdate"],
};

const CHOICES: Record<string, readonly string[]> = {
  "general.theme": ["dark", "light", "system"],
};
const FRACTIONS = new Set(["voice.rate"]);
/** 0 switches the limit off: that is the human's call. */
const AT_LEAST: Record<string, number> = { "runner.runTimeoutMinutes": 1 };
const MAX_TEXT = 200;
const AUDIT_TEXT = 200;
/** Line breaks and control characters: a setting's text is one plain line. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const listed = (section: string): readonly string[] => (Object.hasOwn(AGENT_SETTINGS, section) ? AGENT_SETTINGS[section]! : []);

function leaves(value: unknown, path: string, out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (isObject(value)) for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  else out.set(path, value);
  return out;
}

/** What only the human changes: whole sections by name, single settings as `section.key`. */
export function humanOnlySettings(): string[] {
  return Object.entries(getSettings() as unknown as Sections).flatMap(([section, value]) => {
    const mine = listed(section);
    if (!isObject(value) || !mine.length) return [section];
    return [...leaves(value, "").keys()].filter((key) => !mine.includes(key)).map((key) => `${section}.${key}`);
  });
}

/** The settings an agent may change, as `section.key`. */
export function agentSettingKeys(): string[] {
  return Object.entries(AGENT_SETTINGS).flatMap(([section, keys]) => keys.map((key) => `${section}.${key}`));
}

export function settingsSections(): string[] {
  return Object.keys(getSettings());
}

/** Why an agent's settings change is refused (null = fine). */
export function agentSettingsRefusal(changes: Record<string, unknown>, human: string): string | null {
  const current = getSettings() as unknown as Sections;
  const guarded = `it guards secrets, access from outside, what agents may do on this computer, what every agent is told, or their limits. ${human} changes it in Settings`;
  if (!leaves(changes, "").size) return "Nothing to change: pass at least one setting.";

  const within = (section: string, patch: Record<string, unknown>, now: Record<string, unknown>, group: string): string | null => {
    for (const [key, value] of Object.entries(patch)) {
      const name = group ? `${group}.${key}` : key;
      const path = `${section}.${name.slice(0, 80)}`;
      if (!Object.hasOwn(now, key)) return `There is no setting ${path}. settings_get shows what ${section} has.`;
      const was = now[key];
      if (isObject(was)) {
        if (!listed(section).some((k) => k.startsWith(`${name}.`))) return `${path} stays with ${human}: ${guarded}.`;
        if (!isObject(value)) return `${path} takes an object of settings.`;
        const refusal = within(section, value, was, name);
        if (refusal) return refusal;
        continue;
      }
      if (!listed(section).includes(name) || Array.isArray(was)) return `${path} stays with ${human}: ${guarded}.`;
      const whole = typeof value !== "number" || ((Number.isInteger(value) || FRACTIONS.has(path)) && value >= (AT_LEAST[path] ?? -Infinity));
      if (!sameSettingShape(value, was, false) || !whole || !settingInRange(path, value)) return `Invalid value for ${path}: it is ${JSON.stringify(was)} now, keep its type and range.`;
      if (typeof value === "string") {
        const choices = CHOICES[path];
        if (choices && !choices.includes(value)) return `${path} must be one of: ${choices.join(", ")}.`;
        if (value.length > MAX_TEXT || NOT_ONE_LINE.test(value)) return `${path} takes one line of at most ${MAX_TEXT} characters.`;
      }
    }
    return null;
  };

  for (const [section, patch] of Object.entries(changes)) {
    if (!Object.hasOwn(current, section)) return `There is no settings section "${section.slice(0, 50)}". settings_get lists them.`;
    const now = current[section];
    if (!isObject(now) || !listed(section).length) return `${section} stays with ${human}: ${guarded}.`;
    if (!isObject(patch)) return `${section} takes an object of settings, e.g. { "${section}": { ... } }.`;
    const refusal = within(section, patch, now, "");
    if (refusal) return refusal;
  }
  return null;
}

export interface SettingChange {
  setting: string;
  from: unknown;
  to: unknown;
}

const brief = (v: unknown) => (typeof v === "string" && v.length > AUDIT_TEXT ? `${v.slice(0, AUDIT_TEXT)}…` : v);

/**
 * Saves an agent's settings change (already past agentSettingsRefusal) and returns what really changed. Throws what the
 * app itself would refuse (an unknown model, a cron that isn't one).
 */
export function applyAgentSettings(actor: string, runId: string, changes: Record<string, unknown>): SettingChange[] {
  checkSettingsPatch(changes, () => {
    throw new HttpError(403, "This change needs the vault passphrase: the human makes it in Settings.");
  });
  const before = getSettings() as unknown as Sections;
  const next = updateSettings(changes as never);
  applyRuntimeSettings(next);
  const after = next as unknown as Sections;
  const changed: SettingChange[] = [];
  for (const section of Object.keys(changes)) {
    const was = leaves(before[section], section);
    for (const [setting, to] of leaves(after[section], section)) {
      const from = was.get(setting);
      if (JSON.stringify(from) !== JSON.stringify(to)) changed.push({ setting, from, to });
    }
  }
  if (changed.length) {
    audit(actor, "settings.update", null, { runId, changes: changed.map((c) => ({ setting: c.setting, from: brief(c.from), to: brief(c.to) })) });
  }
  return changed;
}
