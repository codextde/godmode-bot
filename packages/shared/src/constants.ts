import type { ClaudeModel, Effort } from "./models";

export const APP_NAME = "Godmode Bot";
export const APP_SLUG = "godmode";
export const DEFAULT_PORT = 7777;
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_AGENT_SLUG = "godmode";

/** Fallback model list, used until (or when) the installed Claude Code CLI reports its own. */
export const MODEL_OPTIONS: { id: string; label: string; hint: string }[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Best for autonomous multi-step work (default)" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "Frontier model, highest capability" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Fast and capable" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest, cheapest" },
];

export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

export const BUILTIN_MODELS: ClaudeModel[] = MODEL_OPTIONS.map((m) => ({
  id: m.id,
  resolvedModel: m.id,
  label: m.label,
  description: m.hint,
  efforts: [...EFFORT_OPTIONS],
  latest: true,
}));

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const MODEL_ID = /^[A-Za-z0-9][\w.:@/[\]-]{0,199}$/;

/** A `--model` value: alias, model id or provider id (e.g. "us.anthropic.claude-…-v1:0", "claude-opus-4-6[1m]"). */
export function isModelId(value: string): boolean {
  return MODEL_ID.test(value);
}

/** Catalog entry for a `--model` value (alias or full id), matching either form. */
export function findModel<T extends { id: string; resolvedModel: string }>(models: readonly T[], value: string | null | undefined): T | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  return models.find((m) => m.id === v) ?? models.find((m) => m.resolvedModel === v);
}

/** The effort to pass for a model: null when it has none, else the closest supported level at or below `effort` (or its lowest). */
export function effortForModel(efforts: readonly Effort[], effort: Effort | null): Effort | null {
  if (!effort || efforts.length === 0) return null;
  if (efforts.includes(effort)) return effort;
  const rank = EFFORT_OPTIONS.indexOf(effort);
  const below = efforts.filter((e) => EFFORT_OPTIONS.indexOf(e) < rank);
  return below.length ? below[below.length - 1]! : efforts[0]!;
}

/** `/goal ship it` → { name: "goal", args: "ship it" }; null for plain text and paths like `/Users/me`. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([\w][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : null;
}

export const AGENT_COLORS = [
  "violet",
  "indigo",
  "sky",
  "cyan",
  "emerald",
  "lime",
  "amber",
  "orange",
  "rose",
  "fuchsia",
] as const;

/** Name of the MCP server Godmode injects into every agent run. */
export const GODMODE_MCP_NAME = "godmode";
export const BROWSER_MCP_NAME = "browser";
/** MCP server with the computer-use tools of a run that has a screen, window or tab shared. */
export const COMPUTER_MCP_NAME = "computer";
/** MCP server with the tools of a run that works in a macOS VM (shell and files inside the VM). */
export const VM_MCP_NAME = "vm";

/** Longest global, workspace or chat instructions the API accepts. */
export const MAX_INSTRUCTIONS_LENGTH = 20_000;

/** Placeholder the API returns/accepts for stored secret values (MCP env/headers): sending it back keeps the stored value. */
export const SECRET_MASK = "********";
