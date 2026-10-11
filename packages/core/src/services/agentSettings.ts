import { HttpError } from "../util";
import { audit } from "./audit";
import { applyRuntimeSettings } from "./runtime";
import { getSettings, updateSettings } from "./settings";
import { sameSettingShape, settingInRange } from "./settingShape";
import { checkSettingsPatch } from "./settingsPatch";

type Sections = Record<string, unknown>;

/**
 * Settings an agent can read but only the human changes: what guards secrets, opens Godmode to other devices, decides
 * which programs run and what agents may touch on this computer, reaches every agent as instructions (those that read
 * raw secrets too), merges code into Godmode by itself, or caps spending. "*" closes a whole section.
 */
const HUMAN_ONLY: Record<string, "*" | readonly string[]> = {
  security: "*",
  server: "*",
  mobile: "*",
  cloud: "*",
  selfRepair: "*",
  onboardingComplete: "*",
  runner: ["claudePath", "extraArgs", "bypassPermissions", "appendSystemPrompt", "defaultMaxBudgetUsd", "monthlyBudgetUsd"],
  browser: ["enabled", "chromePath", "browserUseCommand"],
  computer: ["enabled", "allowForeground", "cuaDriverCommand"],
  vm: ["isolateHostShell", "vaultFill", "tartPath"],
};

const CHOICES: Record<string, readonly string[]> = {
  "general.theme": ["dark", "light", "system"],
  "memory.backend": ["files", "claude-mem"],
  "voice.sttProvider": ["browser", "openai"],
  "voice.ttsProvider": ["browser", "openai", "elevenlabs"],
};

const FRACTIONS = new Set(["voice.rate"]);
const MAX_TEXT = 500;
const AUDIT_TEXT = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function closed(section: string, key?: string): boolean {
  const rule = HUMAN_ONLY[section];
  return rule === "*" || (key !== undefined && !!rule?.includes(key));
}

export function humanOnlySettings(): string[] {
  return Object.entries(HUMAN_ONLY).flatMap(([section, rule]) => (rule === "*" ? [section] : rule.map((key) => `${section}.${key}`)));
}

export function settingsSections(): string[] {
  return Object.keys(getSettings());
}

/** Why an agent's settings change is refused (null = fine). */
export function agentSettingsRefusal(changes: Record<string, unknown>, human: string): string | null {
  const current = getSettings() as unknown as Sections;
  const guarded = `it guards secrets, access from outside, what agents may do on this computer or spending. ${human} changes it in Settings`;
  if (!Object.keys(changes).length) return "Nothing to change: pass at least one setting.";
  for (const [section, patch] of Object.entries(changes)) {
    if (!Object.hasOwn(current, section)) return `There is no settings section "${section.slice(0, 50)}". settings_get lists them.`;
    if (closed(section)) return `${section} stays with ${human}: ${guarded}.`;
    const now = current[section];
    if (!isObject(now) || !isObject(patch)) return `${section} takes an object of settings, e.g. { "${section}": { ... } }.`;
    for (const [key, value] of Object.entries(patch)) {
      const path = `${section}.${key.slice(0, 50)}`;
      if (!Object.hasOwn(now, key)) return `There is no setting ${path}. settings_get shows what ${section} has.`;
      if (closed(section, key)) return `${path} stays with ${human}: ${guarded}.`;
      if (Array.isArray(now[key])) return `${path} is a list: ${human} changes it in Settings.`;
      const shaped = sameSettingShape(value, now[key], false);
      const whole = typeof value !== "number" || Number.isInteger(value) || FRACTIONS.has(path);
      if (!shaped || !whole || !settingInRange(path, value)) return `Invalid value for ${path}: it is ${JSON.stringify(now[key])} now, keep its type and range.`;
      if (typeof value === "string") {
        const choices = CHOICES[path];
        if (choices && !choices.includes(value)) return `${path} must be one of: ${choices.join(", ")}.`;
        if (value.length > MAX_TEXT) return `${path} is too long (at most ${MAX_TEXT} characters).`;
      }
    }
  }
  return null;
}

export interface SettingChange {
  setting: string;
  from: unknown;
  to: unknown;
}

function leaves(value: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
  if (isObject(value)) for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, out);
  else out.set(path, value);
  return out;
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
    const was = leaves(before[section], section, new Map());
    for (const [setting, to] of leaves(after[section], section, new Map())) {
      const from = was.get(setting);
      if (JSON.stringify(from) !== JSON.stringify(to)) changed.push({ setting, from, to });
    }
  }
  if (changed.length) {
    audit(actor, "settings.update", null, { runId, changes: changed.map((c) => ({ setting: c.setting, from: brief(c.from), to: brief(c.to) })) });
  }
  return changed;
}
