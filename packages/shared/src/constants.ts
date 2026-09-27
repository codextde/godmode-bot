export const APP_NAME = "Godmode Bot";
export const APP_SLUG = "godmode";
export const DEFAULT_PORT = 7777;
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_AGENT_SLUG = "godmode";

/** Models offered in the UI model picker. Any Claude CLI model id/alias is accepted. */
export const MODEL_OPTIONS: { id: string; label: string; hint: string }[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Best for autonomous multi-step work (default)" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "Frontier model, highest capability" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Fast and capable" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest, cheapest" },
];

export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

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
