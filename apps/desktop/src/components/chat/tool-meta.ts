import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  Bell,
  Bot,
  BotMessageSquare,
  Camera,
  Code2,
  Eye,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  FolderSearch,
  Globe,
  History,
  KeyRound,
  Keyboard,
  Layers,
  Link2,
  Monitor,
  MonitorUp,
  Move,
  ZoomIn,
  Hourglass,
  AppWindow,
  ListChecks,
  ListTree,
  MousePointerClick,
  PanelsTopLeft,
  Plug,
  ScanText,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Type,
  UserCog,
  Wand2,
  Workflow,
  Wrench,
  X,
} from "lucide-react";

export type ToolKind =
  | "browser"
  | "computer"
  | "vault"
  | "missing-login"
  | "delegate"
  | "agents"
  | "shell"
  | "file"
  | "web"
  | "subagent"
  | "plan"
  | "notify"
  | "mcp"
  | "other";

export interface ToolMeta {
  icon: LucideIcon;
  /** Short human sentence, e.g. "Opened github.com" */
  title: string;
  /** Optional secondary detail (path, query, …) */
  detail?: string;
  kind: ToolKind;
  /** MCP server name when the tool came from one */
  server: string | null;
  /** Bare tool name without the mcp__server__ prefix */
  tool: string;
}

export interface ToolContext {
  agentName?: (id: string) => string | undefined;
  credentialLabel?: (id: string) => string | undefined;
}

/** "mcp__browser__browser_navigate" → { server: "browser", tool: "browser_navigate" } */
export function parseToolName(name: string): { server: string | null; tool: string } {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const idx = rest.indexOf("__");
    if (idx > 0) return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
  }
  return { server: null, tool: name };
}

export function hostOf(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function truncate(s: string, n = 64): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function humanize(tool: string): string {
  const s = tool.replace(/^browser_/, "").replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Input = Record<string, unknown>;

function browserMeta(tool: string, input: Input): Omit<ToolMeta, "kind" | "server" | "tool"> {
  const t = tool.replace(/^browser_/, "");
  const index = str(input.index ?? input.element_index ?? input.element);
  switch (t) {
    case "navigate": {
      const host = hostOf(input.url);
      return { icon: Globe, title: host ? `Opened ${host}` : "Opened a page", detail: str(input.url) };
    }
    case "click":
      return {
        icon: MousePointerClick,
        title: index ? `Clicked element ${index}` : input.coordinate_x != null ? "Clicked on the page" : "Clicked",
      };
    case "type":
    case "input_text":
      return { icon: Type, title: index ? `Typed text into element ${index}` : "Typed text" };
    case "get_state":
    case "state":
      return { icon: ScanText, title: "Read page" };
    case "extract_content":
    case "extract":
      return { icon: FileSearch, title: "Extracted content", detail: truncate(str(input.query), 80) || undefined };
    case "get_html":
      return { icon: Code2, title: "Read page HTML" };
    case "scroll":
      return { icon: ScrollText, title: `Scrolled ${str(input.direction) || "down"}` };
    case "go_back":
      return { icon: ArrowLeft, title: "Went back" };
    case "screenshot":
      return { icon: Camera, title: "Took a screenshot" };
    case "list_tabs":
      return { icon: PanelsTopLeft, title: "Listed tabs" };
    case "switch_tab":
      return { icon: PanelsTopLeft, title: "Switched tab" };
    case "close_tab":
      return { icon: X, title: "Closed tab" };
    case "send_keys":
      return { icon: Type, title: `Pressed ${str(input.keys) || "keys"}` };
    case "retry_with_browser_use_agent":
      return { icon: Wand2, title: "Ran the browser agent", detail: truncate(str(input.task), 80) || undefined };
    default:
      return { icon: Globe, title: humanize(tool) };
  }
}

function computerMeta(tool: string, input: Input): Omit<ToolMeta, "kind" | "server" | "tool"> {
  if (tool === "computer_ui") return { icon: ListTree, title: input.query ? `Looked for “${truncate(str(input.query), 40)}” in the window` : "Read the window's controls" };
  if (tool === "computer_info") return { icon: Monitor, title: "Checked the shared screen" };
  if (tool === "computer_windows") return { icon: AppWindow, title: input.focus != null ? "Switched window" : "Listed windows" };
  if (tool === "computer_open_app") return { icon: AppWindow, title: `Opened ${str(input.name) || "an app"}` };
  const at = Array.isArray(input.coordinate) ? ` at ${input.coordinate.map((n) => Math.round(Number(n))).join(", ")}` : "";
  const element = input.element ? " a control" : "";
  switch (str(input.action)) {
    case "screenshot":
      return { icon: Camera, title: "Looked at the screen", detail: input.display ? `display ${str(input.display)}` : undefined };
    case "left_click":
      return { icon: MousePointerClick, title: element ? "Clicked a control" : `Clicked${at}` };
    case "double_click":
      return { icon: MousePointerClick, title: `Double-clicked${element || at}` };
    case "triple_click":
      return { icon: MousePointerClick, title: `Triple-clicked${element || at}` };
    case "right_click":
      return { icon: MousePointerClick, title: `Right-clicked${element || at}` };
    case "middle_click":
      return { icon: MousePointerClick, title: `Middle-clicked${at}` };
    case "mouse_move":
      return { icon: Move, title: `Moved the pointer${at}` };
    case "left_click_drag":
      return { icon: Move, title: "Dragged" };
    case "scroll":
      return { icon: ScrollText, title: `Scrolled ${str(input.scroll_direction) || "down"}` };
    case "type":
      return { icon: Type, title: element ? "Typed into a field" : "Typed text", detail: truncate(str(input.text), 80) || undefined };
    case "key":
    case "hold_key":
      return { icon: Keyboard, title: `Pressed ${truncate(str(input.text), 40) || "keys"}` };
    case "wait":
      return { icon: Hourglass, title: `Waited ${str(input.duration) || "1"}s` };
    case "zoom":
      return { icon: ZoomIn, title: "Zoomed in" };
    case "cursor_position":
      return { icon: MousePointerClick, title: "Checked the pointer position" };
    default:
      return { icon: MonitorUp, title: humanize(tool) };
  }
}

const GODMODE_TOOLS = new Set([
  "vault_list_logins",
  "vault_fill_login",
  "vault_fill_totp",
  "vault_get_login",
  "vault_get_totp",
  "report_missing_login",
  "agents_list",
  "agent_get",
  "agent_delegate",
  "agent_create",
  "agent_update",
  "agent_delete",
  "routine_create",
  "routine_update",
  "routine_delete",
  "automation_triggers_list",
  "automation_events_list",
  "automation_check_result",
  "runs_list",
  "workspaces_list",
  "notify_user",
]);

/** What starts an automation, for routine_create / routine_update: the app event, the condition or the cron. */
function automationDetail(input: Input): string | undefined {
  const trigger = input.trigger;
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const t = trigger as Input;
    if (t.type === "app") return str(t.triggerName) || "On an app event";
    if (t.type === "condition") return truncate(`When ${str(t.condition)}`, 120);
    if (t.type === "webhook") return "When its webhook is called";
  }
  return str(input.cron) || undefined;
}

function godmodeMeta(tool: string, input: Input, ctx: ToolContext): Omit<ToolMeta, "server" | "tool"> | null {
  const credId = str(input.credentialId);
  const credLabel = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
  const agentId = str(input.agentId ?? input.id);
  const agentName = agentId ? (ctx.agentName?.(agentId) ?? "") : "";
  switch (tool) {
    case "vault_list_logins":
      return { kind: "vault", icon: KeyRound, title: input.domain ? `Looked up logins for ${hostOf(input.domain)}` : "Looked up saved logins" };
    case "vault_fill_login": {
      const field = str(input.field) || "password";
      const target = credLabel ? ` for ${credLabel}` : "";
      return { kind: "vault", icon: KeyRound, title: `Filled ${field}${target}`, detail: "from vault · never shown to the AI" };
    }
    case "vault_fill_totp":
      return { kind: "vault", icon: ShieldCheck, title: credLabel ? `Entered 2FA code for ${credLabel}` : "Entered 2FA code", detail: "from vault" };
    case "vault_get_login":
      return { kind: "vault", icon: Eye, title: credLabel ? `Revealed login for ${credLabel}` : "Revealed a login", detail: "audited" };
    case "vault_get_totp":
      return { kind: "vault", icon: Eye, title: "Read a 2FA code", detail: "audited" };
    case "report_missing_login": {
      const service = str(input.service) || hostOf(input.url) || "a service";
      return { kind: "missing-login", icon: ShieldAlert, title: `Needs a login for ${service}`, detail: str(input.reason) || undefined };
    }
    case "agents_list":
      return { kind: "agents", icon: Bot, title: "Looked up agents" };
    case "agent_get":
      return { kind: "agents", icon: Bot, title: agentName ? `Looked up ${agentName}` : "Looked up an agent" };
    case "agent_delegate":
      return {
        kind: "delegate",
        icon: BotMessageSquare,
        title: `Delegated to ${agentName || "an agent"}`,
        detail: truncate(str(input.task), 120) || undefined,
      };
    case "agent_create":
      return { kind: "agents", icon: UserCog, title: `Created agent ${str(input.name)}`.trim() };
    case "agent_update":
      return { kind: "agents", icon: UserCog, title: agentName ? `Updated ${agentName}` : "Updated an agent" };
    case "agent_delete":
      return { kind: "agents", icon: Trash2, title: agentName ? `Deleted ${agentName}` : "Deleted an agent" };
    case "routine_create":
      return { kind: "agents", icon: Workflow, title: `Created automation ${str(input.name)}`.trim(), detail: automationDetail(input) };
    case "routine_update":
      return { kind: "agents", icon: Workflow, title: "Updated an automation", detail: automationDetail(input) };
    case "routine_delete":
      return { kind: "agents", icon: Trash2, title: "Deleted an automation" };
    case "automation_triggers_list":
      return { kind: "agents", icon: Workflow, title: "Looked up app events it can react to" };
    case "automation_events_list":
      return { kind: "agents", icon: History, title: "Checked recent automation events" };
    case "automation_check_result":
      return {
        kind: "agents",
        icon: ScanText,
        title: input.met === true ? "Condition met" : "Condition not met yet",
        detail: truncate(str(input.summary ?? input.observation), 120) || undefined,
      };
    case "runs_list":
      return { kind: "agents", icon: History, title: "Checked recent runs" };
    case "workspaces_list":
      return { kind: "agents", icon: Layers, title: "Listed workspaces" };
    case "notify_user":
      return { kind: "notify", icon: Bell, title: "Sent you a notification", detail: str(input.title) || undefined };
    default:
      return null;
  }
}

function builtinMeta(tool: string, input: Input): Omit<ToolMeta, "server" | "tool"> | null {
  const path = str(input.file_path ?? input.path ?? input.notebook_path);
  switch (tool) {
    case "Bash":
      return {
        kind: "shell",
        icon: Terminal,
        title: str(input.description) || "Ran a command",
        detail: truncate(str(input.command), 120) || undefined,
      };
    case "BashOutput":
    case "Monitor":
      return { kind: "shell", icon: Terminal, title: "Checked command output" };
    case "Read":
      return { kind: "file", icon: FileText, title: path ? `Read ${basename(path)}` : "Read a file", detail: path || undefined };
    case "Write":
      return { kind: "file", icon: FilePlus2, title: path ? `Wrote ${basename(path)}` : "Wrote a file", detail: path || undefined };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "file", icon: FilePen, title: path ? `Edited ${basename(path)}` : "Edited a file", detail: path || undefined };
    case "Glob":
      return { kind: "file", icon: FolderSearch, title: "Searched files", detail: str(input.pattern) || undefined };
    case "Grep":
      return { kind: "file", icon: Search, title: `Searched for “${truncate(str(input.pattern), 40)}”` };
    case "LS":
      return { kind: "file", icon: ListTree, title: path ? `Listed ${basename(path)}` : "Listed files" };
    case "WebFetch": {
      const host = hostOf(input.url);
      return { kind: "web", icon: Link2, title: host ? `Fetched ${host}` : "Fetched a page", detail: str(input.url) || undefined };
    }
    case "WebSearch":
      return { kind: "web", icon: Search, title: `Searched the web for “${truncate(str(input.query), 60)}”` };
    case "Task":
    case "Agent": {
      const who = str(input.subagent_type);
      return {
        kind: "subagent",
        icon: Bot,
        title: str(input.description) || (who ? `Asked ${who}` : "Ran a subagent"),
        detail: who && who !== "general-purpose" ? who : undefined,
      };
    }
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { kind: "plan", icon: ListChecks, title: "Updated the plan" };
    default:
      return null;
  }
}

/** Human-friendly presentation for a tool call. */
export function describeTool(name: string, rawInput: unknown, ctx: ToolContext = {}): ToolMeta {
  const { server, tool } = parseToolName(name);
  const input: Input = rawInput && typeof rawInput === "object" ? (rawInput as Input) : {};

  if (server === "browser" || tool.startsWith("browser_")) {
    return { ...browserMeta(tool, input), kind: "browser", server, tool };
  }
  if (server === "computer") {
    return { ...computerMeta(tool, input), kind: "computer", server, tool };
  }
  if (server === "godmode" || (server === null && GODMODE_TOOLS.has(tool)) || GODMODE_TOOLS.has(tool)) {
    const m = godmodeMeta(tool, input, ctx);
    if (m) return { ...m, server, tool };
  }
  if (!server) {
    const m = builtinMeta(tool, input);
    if (m) return { ...m, server, tool };
    return { kind: "other", icon: Wrench, title: humanize(tool), server, tool };
  }
  return { kind: "mcp", icon: Plug, title: humanize(tool), detail: server, server, tool };
}

/** Plan items from TodoWrite input, if present. */
export function todoItems(input: unknown): { content: string; status: string }[] | null {
  if (!input || typeof input !== "object") return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  return todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ content: str(t.content ?? t.activeForm ?? t.subject), status: str(t.status) || "pending" }));
}

/** Pretty-print a tool input for the monospace panel. */
export function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
