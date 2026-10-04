/** Reading a mod's manifest (`.claude-plugin/plugin.json`): its name and the options it declares (`userConfig`). */
import type { ModOption, ModOptionValue } from "@godmode/shared";
import { MOD_HOOKS_PATH, MOD_MANIFEST_PATH } from "@godmode/shared";

type Json = Record<string, unknown>;

const OPTION_TYPES = ["string", "number", "boolean", "directory", "file"] as const;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The manifest as an object; null when the file is missing or isn't a JSON object. */
export function readManifest(files: Record<string, string>): Json | null {
  const text = files[MOD_MANIFEST_PATH];
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** Does `value` fit the option? What Claude Code would take for it. */
export function fitsOption(option: ModOption, value: unknown): value is ModOptionValue {
  if (option.multiple) return strings(value) !== null;
  if (option.type === "boolean") return typeof value === "boolean";
  if (option.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    return (option.min === null || value >= option.min) && (option.max === null || value <= option.max);
  }
  if (typeof value !== "string") return false;
  return !option.choices || option.choices.includes(value);
}

export function manifestOptions(manifest: Json | null): ModOption[] {
  const config = manifest?.userConfig;
  if (!isObj(config)) return [];
  const out: ModOption[] = [];
  for (const [key, raw] of Object.entries(config)) {
    if (!isObj(raw) || !OPTION_TYPES.includes(raw.type as ModOption["type"])) continue;
    const option: ModOption = {
      key,
      type: raw.type as ModOption["type"],
      title: typeof raw.title === "string" && raw.title ? raw.title : key,
      description: typeof raw.description === "string" ? raw.description : "",
      default: null,
      choices: raw.type === "string" ? strings(raw.options) : null,
      multiple: raw.multiple === true,
      required: raw.required === true,
      sensitive: raw.sensitive === true,
      min: typeof raw.min === "number" ? raw.min : null,
      max: typeof raw.max === "number" ? raw.max : null,
    };
    if (fitsOption(option, raw.default)) option.default = raw.default;
    out.push(option);
  }
  return out;
}

/** Classic command hooks: shell commands the plugin has Claude Code run, declared in hooks.json or the manifest. */
export function hasCommandHooks(files: Record<string, string>): boolean {
  const declared = (v: unknown) => isObj(v) && Object.keys(v).length > 0;
  const inline = readManifest(files)?.hooks;
  if (declared(inline) || typeof inline === "string") return true;
  try {
    const parsed: unknown = JSON.parse(files[MOD_HOOKS_PATH] ?? "{}");
    return isObj(parsed) && declared(parsed.hooks);
  } catch {
    return false;
  }
}
