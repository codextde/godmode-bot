/**
 * Mods: Claude Code mods — small plugins of TypeScript function hooks that change what Claude Code does (block or
 * rewrite tool calls, rewrite prompts, edit what the conversation keeps, post notes) — installed in Godmode and loaded
 * into the runs of the agents they are for. Godmode keeps a mod's files, checks them with Claude Code's own validator
 * and hands them to a run with `--plugin-dir`. Only the human switches a mod on.
 */
import type { ID, ISODate } from "./models";

/** Whose runs load a mod: every agent's, or the listed agents'. */
export type ModScope = "all" | "agents";

/** Where a mod came from: the gallery, written by hand, drafted by an agent, or a plugin folder. */
export type ModOrigin = "template" | "custom" | "agent" | "import";

export const MOD_ICONS = [
  "puzzle",
  "shield",
  "file-lock",
  "terminal",
  "eye-off",
  "gauge",
  "timer",
  "git-branch",
  "scroll",
  "bell",
  "filter",
  "wand",
] as const;
export type ModIcon = (typeof MOD_ICONS)[number];

export const MOD_CATEGORIES = ["guardrails", "privacy", "insight", "workflow"] as const;
export type ModCategory = (typeof MOD_CATEGORIES)[number];

export const MOD_CATEGORY_LABELS: Record<ModCategory, string> = {
  guardrails: "Guardrails",
  privacy: "Privacy",
  insight: "Insight",
  workflow: "Workflow",
};

export type ModOptionValue = string | number | boolean | string[];

/** One option a mod declares in its manifest (`userConfig` in `.claude-plugin/plugin.json`). */
export interface ModOption {
  key: string;
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  default: ModOptionValue | null;
  /** A string option that is one of these. */
  choices: string[] | null;
  /** A list of values instead of one. */
  multiple: boolean;
  required: boolean;
  /** A secret: sealed in the vault and never sent back (see `Mod.secretKeys`). */
  sensitive: boolean;
  min: number | null;
  max: number | null;
}

export interface ModProblem {
  /** The file of the mod it is about, e.g. "hooks/register.ts"; "Claude Code" when the check itself failed. */
  where: string;
  message: string;
}

/** One hook a mod registers: the event, and the matcher that narrows it ("tool=Bash") when it has one. */
export interface ModHook {
  event: string;
  matcher: string | null;
}

/** What Claude Code's validator said about a mod's files (`claude plugin validate`). */
export interface ModCheck {
  ok: boolean;
  errors: ModProblem[];
  warnings: ModProblem[];
  hooks: ModHook[];
  /** Everything the mod calls on the engine, e.g. "$.ui.log", "$.fs.write". */
  calls: string[];
  /** The plugin also ships something Claude Code starts as a program: command hooks, MCP or LSP servers, monitors, `bin/`. */
  startsPrograms: boolean;
  /** The Claude Code that checked it; null when the version is unknown. */
  claudeVersion: string | null;
  checkedAt: ISODate;
}

export interface Mod {
  id: ID;
  /** The plugin's name: lowercase letters, digits and dashes. Fixed once created (the mod's own code refers to it). */
  name: string;
  title: string;
  description: string;
  icon: ModIcon;
  origin: ModOrigin;
  /** The gallery template it was made from. */
  templateId: string | null;
  /** "user", or "agent:<id>" for a mod an agent drafted. */
  createdBy: string;
  enabled: boolean;
  /** An agent wrote or changed the code and the human hasn't switched it on since. */
  needsReview: boolean;
  scope: ModScope;
  /** With scope "agents": the agents whose runs load it (deleted ones are left out). */
  agentIds: ID[];
  /** Every file of the plugin by its path, e.g. ".claude-plugin/plugin.json", "hooks/register.ts". */
  files: Record<string, string>;
  /** Which code this is: sent back when switching the mod on, so the OK is for the code that was read. */
  digest: string;
  /** The options its manifest declares. */
  options: ModOption[];
  /** Saved option values (never a sensitive one). */
  values: Record<string, ModOptionValue>;
  /** Sensitive options that have a saved value. */
  secretKeys: string[];
  /** null: not checked yet, or Claude Code isn't installed. */
  check: ModCheck | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** POST /api/mods — from a gallery template (`templateId`), or from files (blank when neither is given). */
export interface ModInput {
  templateId?: string;
  title?: string;
  /** Default: made from the title. */
  name?: string;
  description?: string;
  icon?: ModIcon;
  files?: Record<string, string>;
  enabled?: boolean;
  scope?: ModScope;
  agentIds?: ID[];
}

/** PATCH /api/mods/:id */
export interface ModPatch {
  title?: string;
  description?: string;
  icon?: ModIcon;
  /** Refused (409) while the check fails. */
  enabled?: boolean;
  /** With `enabled: true`: the `digest` of the code the human saw. Refused (409) when the code is another by now. */
  digest?: string;
  scope?: ModScope;
  agentIds?: ID[];
  /** The whole set of files; checked again when it changed. */
  files?: Record<string, string>;
  /** Option values by key; null takes a value back to the mod's default. */
  values?: Record<string, ModOptionValue | null>;
}

/** POST /api/mods/check — check files that aren't saved yet. */
export interface ModCheckInput {
  files: Record<string, string>;
}

/** POST /api/mods/import — a Claude Code plugin folder on the computer running Godmode. */
export interface ModImportInput {
  path: string;
}

/** A mod of the gallery: ready to add, made and maintained by Godmode. */
export interface ModTemplate {
  id: string;
  title: string;
  description: string;
  icon: ModIcon;
  category: ModCategory;
  /** What it does, one short line each. */
  highlights: string[];
  files: Record<string, string>;
  options: ModOption[];
}

export const MOD_MANIFEST_PATH = ".claude-plugin/plugin.json";
export const MOD_HOOKS_PATH = "hooks/hooks.json";
export const MOD_NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
export const MAX_MOD_FILES = 40;
export const MAX_MOD_FILE_BYTES = 200_000;
export const MAX_MOD_BYTES = 600_000;

/** broken: the check failed · review: an agent's code the human hasn't switched on · on / off. */
export type ModState = "broken" | "review" | "on" | "off";

export function modState(mod: Pick<Mod, "enabled" | "needsReview" | "check">): ModState {
  if (mod.check && !mod.check.ok) return "broken";
  if (mod.needsReview) return "review";
  return mod.enabled ? "on" : "off";
}

/** Does a run of `agentId` load the mod (when it is switched on and passes its check)? */
export function modAppliesTo(mod: Pick<Mod, "scope" | "agentIds">, agentId: ID): boolean {
  return mod.scope === "all" || mod.agentIds.includes(agentId);
}

/** A plugin name made from a title: "Protect .env files!" → "protect-env-files". */
export function modNameFrom(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : "mod";
}

/** Why a file path can't be part of a mod; null when it can. */
export function modPathProblem(path: string): string | null {
  if (!path || path.length > 200) return "File paths must be 1–200 characters";
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return `"${path}" must be a relative path with forward slashes`;
  const segments = path.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || s === "__proto__" || !/^[A-Za-z0-9._@+-]+$/.test(s))) {
    return `"${path}" has a folder or file name that isn't allowed`;
  }
  // One folder in any spelling on macOS and Windows.
  if (/^\.claude-plugin\/types(\/|$)/i.test(path)) return `"${path}" is written by Claude Code itself`;
  return null;
}

export type ModAbilityLevel = "normal" | "sensitive";

/** Something a mod can do, told from what it hooks and calls. */
export interface ModAbility {
  id: string;
  label: string;
  detail: string;
  /** sensitive: it reaches outside the conversation (files, programs, the network). */
  level: ModAbilityLevel;
}

const ABILITIES: { id: string; label: string; detail: string; level: ModAbilityLevel; hooks?: RegExp; calls?: RegExp }[] = [
  {
    id: "tools",
    label: "Sees and changes tool calls",
    detail: "It can block a tool call, rewrite its input or act on its result.",
    level: "normal",
    hooks: /^tool\.(call|check|describe)$/,
    calls: /^\$\.tool\.(call|check|register)$/,
  },
  {
    id: "prompts",
    label: "Reads and rewrites prompts",
    detail: "It sees what is sent to the agent and can change it, the system prompt included.",
    level: "normal",
    hooks: /^prompt\./,
    calls: /^\$\.prompt\.(submit|compose|context|section|attachment|edit)$/,
  },
  {
    id: "transcript",
    label: "Edits what the conversation keeps",
    detail: "It can rewrite messages and tool results before the model reads them.",
    level: "normal",
    hooks: /^session\.(append|compact|receive)$/,
    calls: /^\$\.session\.(append|compact|send|messages)$/,
  },
  {
    id: "turns",
    label: "Follows the agent's turns",
    detail: "It is told when a turn starts, takes a step and ends.",
    level: "normal",
    hooks: /^(turn\.|session\.(start|end)$)/,
  },
  {
    id: "notes",
    label: "Posts notes into the chat",
    detail: "Its log lines, toasts and status show up in the chat as notes from the mod.",
    level: "normal",
    calls: /^\$\.ui\.(log|toast|status|notice|message)$/,
  },
  {
    id: "panes",
    label: "Draws panes and bands",
    detail: "These show in Claude Code's own terminal and desktop app — not in Godmode's chats.",
    level: "normal",
    hooks: /^ui\.render$/,
    calls: /^\$\.ui\.(open|close|blit|focus|invalidate)$/,
  },
  {
    id: "model",
    label: "Calls the model",
    detail: "It can ask Claude questions of its own, which costs tokens.",
    level: "normal",
    calls: /^\$\.(model\.|agent\.spawn$)/,
  },
  {
    id: "store",
    label: "Remembers things between chats",
    detail: "It keeps values of its own across sessions.",
    level: "normal",
    calls: /^\$\.store\.(set|delete)$/,
  },
  {
    id: "files-read",
    label: "Reads files on this computer",
    detail: "It can read any file the agent's run can read.",
    level: "sensitive",
    calls: /^\$\.fs\.(read|list|stat|exists|ancestors)$/,
  },
  {
    id: "files-write",
    label: "Writes files on this computer",
    detail: "It can create and overwrite files.",
    level: "sensitive",
    calls: /^\$\.fs\.write$/,
  },
  {
    id: "process",
    label: "Runs programs on this computer",
    detail: "It can start commands of its own, outside the agent's tools.",
    level: "sensitive",
    calls: /^\$\.process\./,
  },
  {
    id: "network",
    label: "Talks to the internet",
    detail: "It can send requests to any server.",
    level: "sensitive",
    calls: /^\$\.(http\.fetch|mcp\.(call|connect))$/,
  },
  {
    id: "env",
    label: "Reads environment variables",
    detail: "These can hold API keys.",
    level: "sensitive",
    calls: /^\$\.(env\.|settings\.read$)/,
  },
];

/** What a checked mod can do, sensitive abilities last. */
export function modAbilities(check: Pick<ModCheck, "hooks" | "calls" | "startsPrograms">): ModAbility[] {
  const out: ModAbility[] = [];
  for (const a of ABILITIES) {
    const hooked = !!a.hooks && check.hooks.some((h) => a.hooks!.test(h.event));
    const called = !!a.calls && check.calls.some((c) => a.calls!.test(c));
    if (hooked || called) out.push({ id: a.id, label: a.label, detail: a.detail, level: a.level });
  }
  if (check.startsPrograms) {
    out.push({
      id: "programs",
      label: "Starts programs of its own",
      detail: "It ships command hooks, servers, monitors or scripts that Claude Code runs on this computer.",
      level: "sensitive",
    });
  }
  return out;
}

/** "tool.call" → "Tool call"; the event names Claude Code uses, in words. */
export function modHookLabel(hook: ModHook): string {
  const tool = hook.matcher ? /(?:^|,\s*)tool=([^,]+)/.exec(hook.matcher)?.[1] : null;
  const names: Record<string, string> = {
    "tool.call": tool ? `${tool} calls` : "Every tool call",
    "tool.check": "Permission checks",
    "tool.describe": "Tool descriptions",
    "prompt.submit": "Prompts",
    "prompt.compose": "The system prompt",
    "prompt.context": "Prompt context",
    "session.start": "Session start",
    "session.end": "Session end",
    "session.append": "Conversation rows",
    "session.compact": "Compaction",
    "turn.start": "Turn start",
    "turn.step": "Model requests",
    "turn.complete": "Turn end",
    "ui.render": "Drawing",
    "command.run": "Slash commands",
  };
  return names[hook.event] ?? hook.event;
}
