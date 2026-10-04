/** Reading a mod's manifest (`.claude-plugin/plugin.json`): its name and the options it declares (`userConfig`). */
import type { ModOption, ModOptionValue } from "@godmode/shared";
import { MOD_HOOKS_PATH, MOD_MANIFEST_PATH } from "@godmode/shared";

type Json = Record<string, unknown>;

const OPTION_TYPES = ["string", "number", "boolean", "directory", "file"] as const;
/** Manifest fields and files of a plugin that name programs for Claude Code to start. */
const PROGRAM_FIELDS = ["mcpServers", "lspServers", "monitors"];
const PROGRAM_FILES = /^(\.mcp\.json$|\.lsp\.json$|monitors\/|bin\/)/i;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The manifest as an object; null when the file is missing or isn't a JSON object. */
export function readManifest(files: Record<string, string>): Json | null {
  const parsed = parse(Object.hasOwn(files, MOD_MANIFEST_PATH) ? files[MOD_MANIFEST_PATH] : undefined);
  return isObj(parsed) ? parsed : null;
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** Does `value` fit the option? What Claude Code would take for it. */
export function fitsOption(option: ModOption, value: unknown): value is ModOptionValue {
  if (option.multiple) {
    const list = strings(value);
    return list !== null && (!option.choices || list.every((entry) => option.choices!.includes(entry)));
  }
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

/** A hooks file's content (or the manifest's inline `hooks`): does it declare classic command hooks? `modules` are function hooks. */
function declaresCommandHooks(value: unknown): boolean {
  if (!isObj(value)) return false;
  if ("hooks" in value) return isObj(value.hooks) && Object.keys(value.hooks).length > 0;
  return Object.keys(value).some((key) => key !== "modules");
}

/**
 * Does the plugin ship something Claude Code starts as a program — classic command hooks (in hooks.json, or wherever
 * the manifest's `hooks` points: a path, an inline object or a list of both), MCP or LSP servers, monitors, `bin/`?
 */
export function startsPrograms(files: Record<string, string>): boolean {
  if (Object.keys(files).some((path) => PROGRAM_FILES.test(path))) return true;
  const manifest = readManifest(files);
  if (manifest && PROGRAM_FIELDS.some((field) => manifest[field] !== undefined)) return true;
  const declared = manifest?.hooks;
  const sources: unknown[] = [MOD_HOOKS_PATH, ...(Array.isArray(declared) ? declared : declared === undefined ? [] : [declared])];
  return sources.some((source) => {
    if (typeof source !== "string") return declaresCommandHooks(source);
    const path = source.replace(/^\.\//, "");
    return declaresCommandHooks(parse(Object.hasOwn(files, path) ? files[path] : undefined));
  });
}
