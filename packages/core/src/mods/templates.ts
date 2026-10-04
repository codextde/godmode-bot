/**
 * The mod gallery: mods Godmode ships. Each is one hooks module (`gallery/<id>.ts.txt`, a real Claude Code mod that
 * validates, type-checks and was run against Claude Code) plus the manifest built here.
 */
import type { ModCategory, ModIcon, ModTemplate } from "@godmode/shared";
import { MOD_HOOKS_PATH, MOD_MANIFEST_PATH } from "@godmode/shared";
import { manifestOptions } from "./manifest";
import commandGuard from "./gallery/command-guard.ts.txt";
import promptShortcuts from "./gallery/prompt-shortcuts.ts.txt";
import protectFiles from "./gallery/protect-files.ts.txt";
import secretScrubber from "./gallery/secret-scrubber.ts.txt";
import stepLimit from "./gallery/step-limit.ts.txt";
import turnRecap from "./gallery/turn-recap.ts.txt";

export const MOD_MODULE_PATH = "hooks/register.ts";
const HOOKS_JSON = `${JSON.stringify({ modules: ["./register.ts"] }, null, 2)}\n`;

interface Spec {
  id: string;
  title: string;
  description: string;
  icon: ModIcon;
  category: ModCategory;
  highlights: string[];
  source: string;
  userConfig: Record<string, Record<string, unknown>>;
}

const SPECS: Spec[] = [
  {
    id: "protect-files",
    title: "Protect files",
    description: "Keeps agents away from the files you name: .env files, keys, a secrets folder.",
    icon: "file-lock",
    category: "guardrails",
    highlights: ["Refuses edits and overwrites of protected paths", "Can also refuse reading them and shell commands that name them", "You choose the paths"],
    source: protectFiles,
    userConfig: {
      paths: {
        type: "string",
        multiple: true,
        title: "Protected paths",
        description: "Files and folders to protect. * matches within a name, ** across folders; a folder protects everything in it.",
        default: [".env", ".env.*", "*.pem", "id_rsa", "id_ed25519", "secrets"],
      },
      mode: {
        type: "string",
        title: "Protection",
        description: "writes: the files can't be edited or overwritten. everything: they also can't be read, and shell commands that name them are refused.",
        options: ["writes", "everything"],
        default: "writes",
      },
    },
  },
  {
    id: "command-guard",
    title: "Command guard",
    description: "Refuses shell commands you would never want an agent to run, like a force push or rm -rf on your home folder.",
    icon: "terminal",
    category: "guardrails",
    highlights: ["Blocks force pushes, hard resets, piping downloads into a shell and more", "The agent is told to explain instead of finding another way", "Add patterns of your own"],
    source: commandGuard,
    userConfig: {
      blocked: {
        type: "string",
        multiple: true,
        title: "Blocked commands",
        description: "Regular expressions, matched against the whole command without regard to case.",
        default: [
          String.raw`\brm\s+-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*(/|~|\$HOME)(\s|$)`,
          String.raw`\bgit\s+push\b.*\s(--force|-f)(\s|$)`,
          String.raw`\bgit\s+reset\s+--hard\b`,
          String.raw`\bgit\s+clean\s+-[a-z]*f`,
          String.raw`\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b`,
          String.raw`\bmkfs(\.[a-z0-9]+)?\b`,
          String.raw`\bdd\b.*\bof=/dev/`,
          String.raw`\bdrop\s+(table|database|schema)\b`,
        ],
      },
      message: {
        type: "string",
        title: "What the agent is told",
        description: "The refusal the agent reads in place of the command's output.",
        default:
          'This command is blocked by the "Command guard" mod. Don\'t look for another way to do the same thing: tell the human what you wanted to run and why.',
      },
    },
  },
  {
    id: "step-limit",
    title: "Step limit",
    description: "Stops a turn that keeps calling tools: after the limit, further calls are refused and the agent wraps up.",
    icon: "gauge",
    category: "guardrails",
    highlights: ["Caps the tool calls of one turn, subagents included", "The agent reports what is done and what is left", "Says so in the chat when the limit is hit"],
    source: stepLimit,
    userConfig: {
      maxCalls: {
        type: "number",
        title: "Tool calls per turn",
        description: "How many tool calls one turn may make, its subagents included.",
        default: 200,
        min: 5,
        max: 5000,
      },
    },
  },
  {
    id: "secret-scrubber",
    title: "Secret scrubber",
    description: "Masks keys, tokens and passwords in tool output before the model reads it — also the ones that aren't in your vault.",
    icon: "eye-off",
    category: "privacy",
    highlights: ["Recognises AWS, GitHub, Stripe, Slack and Google keys, JWTs and private keys", "Masks values after password=, token=, api_key=…", "Add patterns for secrets of your own"],
    source: secretScrubber,
    userConfig: {
      assignments: {
        type: "boolean",
        title: "Mask values after password=, token=, api_key=…",
        description: "Also masks whatever follows a name that sounds like a secret, in files like .env and in command output.",
        default: true,
      },
      extra: {
        type: "string",
        multiple: true,
        title: "More patterns",
        description: "Regular expressions for secrets of your own, e.g. an internal token format.",
        default: [],
      },
      notify: {
        type: "boolean",
        title: "Say so in the chat",
        description: "Posts a note whenever something was masked.",
        default: true,
      },
    },
  },
  {
    id: "turn-recap",
    title: "Turn recap",
    description: "Posts a line after each turn: how long it took, which tools it used and how many calls failed.",
    icon: "timer",
    category: "insight",
    highlights: ["Duration and tool calls at a glance", "Counts failed and refused calls", "Only for turns longer than you choose"],
    source: turnRecap,
    userConfig: {
      minSeconds: {
        type: "number",
        title: "Only for turns longer than (seconds)",
        description: "Shorter turns get no line. 0 posts one after every turn.",
        default: 60,
        min: 0,
        max: 86400,
      },
    },
  },
  {
    id: "prompt-shortcuts",
    title: "Prompt shortcuts",
    description: "Type a short word, send a long instruction: !brief, !plan and shortcuts of your own are expanded before the agent reads the message.",
    icon: "wand",
    category: "workflow",
    highlights: ["Write !name anywhere in a message", "Comes with !brief, !plan and !sources", "Works in every chat, automation and task"],
    source: promptShortcuts,
    userConfig: {
      shortcuts: {
        type: "string",
        multiple: true,
        title: "Shortcuts",
        description: "One per row as name = text. Write !name anywhere in a message to send the text instead.",
        default: [
          "brief = Answer in at most five sentences.",
          "plan = Before you change anything, write a short plan and wait for my OK.",
          "sources = Name the source of every fact you state, with a link where there is one.",
        ],
      },
    },
  },
];

const BLANK_SOURCE = `import type { Register } from 'claude-code'

// Every hook is ($, e, next): \`e\` is the event's input, \`next(e)\` lets it happen and resolves to its result,
// and \`$\` reaches the engine ($.ui.log posts a note into the chat).
export const register: Register = on => {
  // Runs before every Bash call. Return { deny: 'why' } to refuse it, or next({ ...e, command }) to rewrite it.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => next(e))
}
`;

export function manifestJson(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function filesOf(spec: Spec): Record<string, string> {
  return {
    [MOD_MANIFEST_PATH]: manifestJson({
      name: spec.id,
      version: "1.0.0",
      description: spec.description,
      author: { name: "Godmode" },
      userConfig: spec.userConfig,
    }),
    [MOD_HOOKS_PATH]: HOOKS_JSON,
    [MOD_MODULE_PATH]: spec.source,
  };
}

const TEMPLATES: ModTemplate[] = SPECS.map((spec) => ({
  id: spec.id,
  title: spec.title,
  description: spec.description,
  icon: spec.icon,
  category: spec.category,
  highlights: spec.highlights,
  files: filesOf(spec),
  options: manifestOptions({ userConfig: spec.userConfig }),
}));

export function listModTemplates(): ModTemplate[] {
  return TEMPLATES;
}

export function findModTemplate(id: string): ModTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

/** A mod that hooks one event and changes nothing: where "Start from scratch" begins. */
export function blankModFiles(name: string, description: string): Record<string, string> {
  return {
    [MOD_MANIFEST_PATH]: manifestJson({ name, version: "0.1.0", description }),
    [MOD_HOOKS_PATH]: HOOKS_JSON,
    [MOD_MODULE_PATH]: BLANK_SOURCE,
  };
}
