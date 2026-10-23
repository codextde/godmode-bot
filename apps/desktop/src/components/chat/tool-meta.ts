import { GATEWAY_DONE } from "@godmode/shared";
import type { LucideIcon } from "lucide-react";
import {
  CreditCard,
  AlarmClock,
  AlarmClockOff,
  AppWindow,
  ArrowLeft,
  Bell,
  Bot,
  BotMessageSquare,
  Box,
  Camera,
  CircleStop,
  Code2,
  Eye,
  FileDown,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  FileUp,
  FolderKanban,
  FolderSearch,
  Globe,
  History,
  Hourglass,
  KeyRound,
  Keyboard,
  Layers,
  Link2,
  ListChecks,
  ListTree,
  MessageCircleQuestion,
  MessageSquareReply,
  Monitor,
  MonitorUp,
  MousePointerClick,
  Move,
  NotebookPen,
  OctagonAlert,
  PackagePlus,
  PanelsTopLeft,
  Play,
  Plug,
  Pointer,
  ScanText,
  ScrollText,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  SquareKanban,
  Terminal,
  Trash2,
  Type,
  UserCog,
  Wand2,
  Workflow,
  Wrench,
  X,
  ZoomIn,
  Zap,
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

/** The `vm` server: shell, files and the whole screen of the VM a run works in. */
function vmMeta(tool: string, input: Input): Omit<ToolMeta, "server" | "tool"> {
  const path = str(input.path);
  switch (tool) {
    case "shell":
      return { kind: "shell", icon: Terminal, title: "Ran a command in the VM", detail: truncate(str(input.command), 120) || undefined };
    case "read_file":
      return { kind: "file", icon: FileText, title: path ? `Read ${basename(path)} in the VM` : "Read a file in the VM", detail: path || undefined };
    case "write_file":
      return { kind: "file", icon: FilePlus2, title: path ? `Wrote ${basename(path)} in the VM` : "Wrote a file in the VM", detail: path || undefined };
    case "edit_file":
      return { kind: "file", icon: FilePen, title: path ? `Edited ${basename(path)} in the VM` : "Edited a file in the VM", detail: path || undefined };
    case "info":
      return { kind: "other", icon: Box, title: "Checked the VM" };
    default:
      return { ...computerMeta(tool, input), kind: "computer" };
  }
}

/** "the server" unless the input names it (a name, not an `ssh_…` id). */
function sshTarget(input: Input): string {
  const server = input.server;
  return typeof server === "string" && server.trim() && !server.startsWith("ssh_") ? server.trim() : "the server";
}

/** The `ssh` server: commands, files and transfers on the user's SSH servers. */
function sshMeta(tool: string, input: Input): Omit<ToolMeta, "server" | "tool"> {
  const on = sshTarget(input);
  const path = str(input.path ?? input.remotePath ?? input.remote_path);
  const local = str(input.localPath ?? input.local_path);
  switch (tool) {
    case "shell":
      return {
        kind: "shell",
        icon: Terminal,
        title: `Ran a command on ${on}${input.sudo === true ? " as root" : ""}`,
        detail: truncate(str(input.command), 120) || undefined,
      };
    case "read_file":
      return { kind: "file", icon: FileText, title: path ? `Read ${basename(path)} on ${on}` : `Read a file on ${on}`, detail: path || undefined };
    case "write_file":
      return { kind: "file", icon: FilePlus2, title: path ? `Wrote ${basename(path)} on ${on}` : `Wrote a file on ${on}`, detail: path || undefined };
    case "edit_file":
      return { kind: "file", icon: FilePen, title: path ? `Edited ${basename(path)} on ${on}` : `Edited a file on ${on}`, detail: path || undefined };
    case "upload": {
      const name = basename(local || path);
      return { kind: "file", icon: FileUp, title: name ? `Uploaded ${name} to ${on}` : `Uploaded a file to ${on}`, detail: path || undefined };
    }
    case "download": {
      const name = basename(path || local);
      return { kind: "file", icon: FileDown, title: name ? `Downloaded ${name} from ${on}` : `Downloaded a file from ${on}`, detail: local || undefined };
    }
    case "list_servers":
      return { kind: "other", icon: Server, title: "Checked SSH servers" };
    default:
      return { kind: "other", icon: Server, title: humanize(tool), detail: on === "the server" ? undefined : on };
  }
}

/** "the phone" unless the input names it (a name, not an `adr_…` id). */
function phoneTarget(input: Input): string {
  const device = input.device;
  return typeof device === "string" && device.trim() && !device.startsWith("adr_") ? device.trim() : "the phone";
}

/** "[540, 1200]" for an `[x, y]` coordinate, "" for anything else. */
function point(v: unknown): string {
  return Array.isArray(v) && v.length === 2 ? `[${v.map((n) => Math.round(Number(n))).join(", ")}]` : "";
}

/** The `android` server: screen, touch, apps, shell and files on the user's Android phones. */
function androidMeta(tool: string, input: Input, ctx: ToolContext): Omit<ToolMeta, "server" | "tool"> {
  const on = phoneTarget(input);
  const named = on === "the phone" ? undefined : on;
  const local = str(input.local_path);
  const remote = str(input.remote_path);
  switch (tool) {
    case "list_devices":
      return { kind: "other", icon: Smartphone, title: "Checked the phones" };
    case "screenshot":
      return { kind: "other", icon: Smartphone, title: "Looked at the screen", detail: named };
    case "ui_elements":
      return { kind: "other", icon: ListTree, title: input.filter ? `Looked for “${truncate(str(input.filter), 40)}” on the screen` : "Read the screen", detail: named };
    case "tap":
      return { kind: "other", icon: Pointer, title: `Tapped ${point(input.coordinate)}`.trim(), detail: named };
    case "long_press":
      return { kind: "other", icon: Pointer, title: `Pressed and held ${point(input.coordinate)}`.trim(), detail: named };
    case "swipe": {
      const path = point(input.start_coordinate) && point(input.coordinate) ? `${point(input.start_coordinate)} → ${point(input.coordinate)}` : "";
      return { kind: "other", icon: Move, title: "Swiped", detail: [path, named].filter(Boolean).join(" · ") || undefined };
    }
    case "scroll":
      return { kind: "other", icon: ScrollText, title: `Scrolled ${str(input.direction) || "down"}`, detail: named };
    case "type_text":
      return { kind: "other", icon: Type, title: "Typed text", detail: truncate(str(input.text), 80) || undefined };
    case "press_key": {
      const key = str(input.key).replace(/^KEYCODE_/i, "").replace(/_/g, " ").toLowerCase();
      return { kind: "other", icon: Keyboard, title: `${input.long === true ? "Held" : "Pressed"} ${truncate(key, 40) || "a key"}`, detail: named };
    }
    case "open_app": {
      const pkg = str(input.package);
      const url = str(input.url);
      // An app link ("myapp://screen") has no website to name.
      const appLink = /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url);
      const host = appLink ? "" : hostOf(url);
      return { kind: "other", icon: AppWindow, title: pkg ? `Opened ${pkg}` : url ? `Opened ${host || "a link"}` : "Opened an app", detail: url || named };
    }
    case "list_apps":
      return { kind: "other", icon: AppWindow, title: "Listed apps", detail: named };
    case "shell":
      return { kind: "shell", icon: Terminal, title: `Ran a command on ${on}`, detail: truncate(str(input.command), 120) || undefined };
    case "install_apk":
      return { kind: "other", icon: PackagePlus, title: local ? `Installed ${basename(local)} on ${on}` : `Installed an app on ${on}` };
    case "push_file": {
      const name = basename(local || remote);
      return { kind: "file", icon: FileUp, title: name ? `Copied ${name} to ${on}` : `Copied a file to ${on}`, detail: remote || undefined };
    }
    case "pull_file": {
      const name = basename(remote || local);
      return { kind: "file", icon: FileDown, title: name ? `Copied ${name} from ${on}` : `Copied a file from ${on}`, detail: local || undefined };
    }
    case "fill_login": {
      const credId = str(input.credentialId);
      const label = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
      const field = str(input.field) === "username" ? "username" : "password";
      return { kind: "vault", icon: KeyRound, title: `Entered ${field}${label ? ` for ${label}` : ""}`, detail: "from vault · never shown to the AI" };
    }
    case "fill_totp": {
      const credId = str(input.credentialId);
      const label = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
      return { kind: "vault", icon: ShieldCheck, title: label ? `Entered 2FA code for ${label}` : "Entered 2FA code", detail: "from vault" };
    }
    default:
      return { kind: "other", icon: Smartphone, title: humanize(tool), detail: named };
  }
}

/** The `cua` server: Cua Driver controlling the apps and windows inside the VM. */
function cuaMeta(tool: string, input: Input): Omit<ToolMeta, "kind" | "server" | "tool"> {
  const app = str(input.app_name ?? input.app ?? input.name ?? input.bundle_id);
  if (/launch|open_app/.test(tool)) return { icon: AppWindow, title: app ? `Opened ${app}` : "Opened an app" };
  if (/list_(windows|apps)/.test(tool)) return { icon: AppWindow, title: tool === "list_apps" ? "Listed apps" : "Listed windows" };
  if (/window_state|desktop_state|accessibility|tree/.test(tool)) return { icon: ListTree, title: "Read the window's controls" };
  if (/screenshot/.test(tool)) return { icon: Camera, title: "Looked at the screen" };
  if (/click/.test(tool)) return { icon: MousePointerClick, title: /double/.test(tool) ? "Double-clicked" : /right/.test(tool) ? "Right-clicked" : "Clicked" };
  if (/type|set_value/.test(tool)) return { icon: Type, title: "Typed text", detail: truncate(str(input.text ?? input.value), 80) || undefined };
  if (/key/.test(tool)) return { icon: Keyboard, title: `Pressed ${truncate(str(input.key ?? input.keys ?? input.text), 40) || "keys"}` };
  if (/scroll/.test(tool)) return { icon: ScrollText, title: "Scrolled" };
  if (/drag|move/.test(tool)) return { icon: Move, title: humanize(tool) };
  return { icon: MonitorUp, title: humanize(tool) };
}

const GODMODE_TOOLS = new Set([
  "vault_list_logins",
  "vault_fill_login",
  "vault_fill_totp",
  "vault_save_login",
  "vault_get_login",
  "vault_get_totp",
  "vault_list_cards",
  "vault_card_purchase",
  "vault_fill_card",
  "vault_card_purchase_result",
  "report_missing_login",
  "agents_list",
  "agent_get",
  "agent_delegate",
  "agent_create",
  "templates_list",
  "team_install",
  "agent_update",
  "agent_delete",
  "routine_create",
  "routine_update",
  "routine_delete",
  "my_routines",
  "my_routine_set_enabled",
  "automation_triggers_list",
  "automation_events_list",
  "automation_check_result",
  "runs_list",
  "run_continue",
  "run_cancel",
  "workspaces_list",
  "workspace_create",
  "workspace_update",
  "project_create",
  "project_update",
  "notify_user",
  "followup_schedule",
  "followup_cancel",
  "ask_human",
  "request_approval",
  "tasks_list",
  "task_get",
  "task_create",
  "task_update",
  "task_message",
  "task_note",
  "task_report_blocked",
  "artifact_create",
  "artifact_update",
  "artifact_get",
  "artifact_list",
]);

/** "task #12" for a task reference ("#12", "12" or an id). */
function taskRef(input: Input): string {
  const ref = str(input.taskId);
  const n = /^#?(\d+)$/.exec(ref)?.[1];
  return n ? `task #${n}` : "the task";
}

/** "in 90 min" or the `at` time of a followup_schedule call. */
function followupTime(input: Input): string {
  if (typeof input.inMinutes === "number") {
    const m = input.inMinutes;
    return m < 90 ? `in ${m} min` : m < 48 * 60 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} days`;
  }
  const at = new Date(str(input.at).replace(" ", "T"));
  if (Number.isNaN(at.getTime())) return "later";
  return `on ${at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

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
    case "vault_save_login": {
      const site = hostOf(input.url);
      const user = str(input.username);
      return {
        kind: "vault",
        icon: KeyRound,
        title: site ? `Saved login for ${site}` : "Saved a login",
        detail: [user, input.generatePassword ? "new password, never shown to the AI" : "password stored encrypted"].filter(Boolean).join(" · "),
      };
    }
    case "vault_get_login":
      return { kind: "vault", icon: Eye, title: credLabel ? `Revealed login for ${credLabel}` : "Revealed a login", detail: "audited" };
    case "vault_get_totp":
      return { kind: "vault", icon: Eye, title: "Read a 2FA code", detail: "audited" };
    case "vault_list_cards":
      return { kind: "vault", icon: CreditCard, title: "Looked up saved cards" };
    case "vault_card_purchase": {
      const amount = typeof input.amount === "number" ? `${str(input.currency).toUpperCase()} ${input.amount.toFixed(2)}`.trim() : "";
      const merchant = str(input.merchant);
      return { kind: "vault", icon: CreditCard, title: `Asked to pay${amount ? ` ${amount}` : ""}${merchant ? ` · ${truncate(merchant, 60)}` : ""}`, detail: str(input.description) || undefined };
    }
    case "vault_fill_card":
      return { kind: "vault", icon: CreditCard, title: `Entered card ${str(input.field).replace(/_/g, " ") || "details"}`, detail: "from vault · never shown to the AI" };
    case "vault_card_purchase_result":
      return { kind: "vault", icon: CreditCard, title: str(input.outcome) === "failed" ? "Payment failed" : "Payment done", detail: str(input.note) || undefined };
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
      return { kind: "agents", icon: UserCog, title: `Created agent ${str(input.name)}`.trim(), detail: str(input.template) ? `From the ${humanize(str(input.template))} template` : undefined };
    case "templates_list":
      return { kind: "agents", icon: Bot, title: "Looked at ready-made roles and teams" };
    case "team_install": {
      const workspace = str((input.newWorkspace as Input | undefined)?.name);
      return { kind: "agents", icon: UserCog, title: `Hired ${humanize(str(input.template)) || "a team"}`, detail: workspace ? `In the new workspace ${workspace}` : undefined };
    }
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
    case "my_routines":
      return { kind: "agents", icon: Workflow, title: "Looked at its automations" };
    case "my_routine_set_enabled":
      return { kind: "agents", icon: Workflow, title: input.enabled === false ? "Paused one of its automations" : "Switched one of its automations on", detail: truncate(str(input.reason), 120) || undefined };
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
    case "run_continue":
      return { kind: "agents", icon: Play, title: "Continued work a restart cut off" };
    case "run_cancel":
      return { kind: "agents", icon: CircleStop, title: "Stopped a run", detail: truncate(str(input.reason), 120) || undefined };
    case "workspaces_list":
      return { kind: "agents", icon: Layers, title: "Listed workspaces" };
    case "workspace_create":
      return { kind: "agents", icon: Layers, title: `Created workspace ${str(input.name)}`.trim(), detail: truncate(str(input.description), 120) || undefined };
    case "workspace_update":
      return { kind: "agents", icon: Layers, title: "Updated a workspace" };
    case "project_create":
      return { kind: "agents", icon: FolderKanban, title: `Created project ${str(input.name)}`.trim(), detail: truncate(str(input.description), 120) || undefined };
    case "project_update":
      return { kind: "agents", icon: FolderKanban, title: "Updated a project" };
    case "notify_user":
      return { kind: "notify", icon: Bell, title: "Sent you a notification", detail: str(input.title) || undefined };
    case "followup_schedule":
      return { kind: "notify", icon: AlarmClock, title: `Will continue ${followupTime(input)}`, detail: truncate(str(input.note), 120) || undefined };
    case "followup_cancel":
      return { kind: "notify", icon: AlarmClockOff, title: "Cancelled its follow-up" };
    case "ask_human":
      return { kind: "agents", icon: MessageCircleQuestion, title: "Asked you", detail: truncate(str(input.question), 120) || undefined };
    case "request_approval":
      return { kind: "agents", icon: ShieldCheck, title: "Asked for your OK", detail: truncate(str(input.action), 120) || undefined };
    case "tasks_list":
      return { kind: "agents", icon: SquareKanban, title: "Looked at the board" };
    case "task_get":
      return { kind: "agents", icon: SquareKanban, title: `Read ${taskRef(input)}` };
    case "task_create":
      return { kind: "agents", icon: SquareKanban, title: "Filed a task", detail: truncate(str(input.title), 120) || undefined };
    case "task_update":
      return { kind: "agents", icon: SquareKanban, title: `Changed ${taskRef(input)}` };
    case "task_message":
      return { kind: "agents", icon: MessageSquareReply, title: `Sent a message into ${taskRef(input)}`, detail: truncate(str(input.content), 120) || undefined };
    case "task_note":
      return { kind: "agents", icon: NotebookPen, title: "Left a note on the task", detail: truncate(str(input.text), 120) || undefined };
    case "artifact_create":
      return { kind: "other", icon: AppWindow, title: `Built ${str(input.title) || "an artifact"}` };
    case "artifact_update":
      return { kind: "other", icon: AppWindow, title: "Changed an artifact", detail: truncate(str(input.note), 120) || undefined };
    case "artifact_get":
      return { kind: "other", icon: AppWindow, title: "Read an artifact" };
    case "artifact_list":
      return { kind: "other", icon: AppWindow, title: "Looked at its artifacts" };
    case "task_report_blocked":
      return { kind: "agents", icon: OctagonAlert, title: "Reported what it needs", detail: truncate(str(input.reason), 120) || undefined };
    default:
      // A Godmode tool without its own card: the shared past-tense title, never its raw name.
      return GATEWAY_DONE[tool] ? { kind: "other", icon: Zap, title: GATEWAY_DONE[tool]! } : null;
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
    case "Workflow":
      return { kind: "subagent", icon: Workflow, title: str(input.name) ? `Ran the workflow ${str(input.name)}` : "Ran a workflow" };
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
  if (server === "vm") return { ...vmMeta(tool, input), server, tool };
  if (server === "ssh") return { ...sshMeta(tool, input), server, tool };
  if (server === "android") return { ...androidMeta(tool, input, ctx), server, tool };
  if (server === "cua") return { ...cuaMeta(tool, input), kind: "computer", server, tool };
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

/** Kinds whose secondary line is already plain language (a reason, a task title); the rest show paths, commands or ids. */
const EASY_DETAIL_KINDS = new Set<ToolKind>(["vault", "missing-login", "delegate", "notify", "agents"]);

const MEMORY_FILE = /(^|[\\/])(MEMORY\.md$|memory[\\/])/i;

/** Easy-mode wording for the calls whose regular title names a file, a command, a coordinate or an element number. */
function easyMeta(meta: ToolMeta, input: Input, ctx: ToolContext): { title: string; detail?: string } | null {
  const { server, tool, kind } = meta;
  const path = str(input.file_path ?? input.path ?? input.notebook_path ?? input.remotePath ?? input.remote_path);
  const memory = MEMORY_FILE.test(path);
  const credId = str(input.credentialId);
  const credLabel = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
  const forSite = credLabel ? ` for ${credLabel}` : "";

  if (kind === "browser") {
    switch (tool.replace(/^browser_/, "")) {
      case "click":
        return { title: "Clicked on the page" };
      case "type":
      case "input_text":
        return { title: "Typed text" };
      case "get_state":
      case "state":
      case "get_html":
        return { title: "Looked at the page" };
      case "extract_content":
      case "extract":
        return { title: "Read the page", detail: meta.detail };
      case "scroll":
        return { title: "Scrolled the page" };
      case "send_keys":
        return { title: "Pressed a key" };
      case "list_tabs":
        return { title: "Checked the open tabs" };
      case "switch_tab":
        return { title: "Switched tabs" };
      case "close_tab":
        return { title: "Closed a tab" };
      case "retry_with_browser_use_agent":
        return { title: "Asked a browser helper", detail: meta.detail };
      default:
        return null;
    }
  }
  if (kind === "computer") {
    const action = str(input.action) || tool;
    if (/screenshot/.test(action)) return { title: "Looked at the screen" };
    if (/drag|mouse_move|move_(cursor|mouse|pointer)/.test(action)) return { title: "Moved the pointer" };
    if (/click/.test(action)) return { title: /double/.test(action) ? "Double-clicked on the screen" : /right/.test(action) ? "Right-clicked on the screen" : "Clicked on the screen" };
    if (/key/.test(action)) return { title: "Pressed a key" };
    if (/type|set_value/.test(action)) return { title: "Typed text" };
    if (/scroll/.test(action)) return { title: "Scrolled" };
    return null;
  }
  if (kind === "shell") return { title: tool === "BashOutput" || tool === "Monitor" ? "Checked on a command" : "Ran a command" };
  if (kind === "file") {
    if (/^(Read|read_file)$/.test(tool)) return { title: memory ? "Checked its memory" : "Read a file" };
    if (/^(Write|write_file)$/.test(tool)) return { title: memory ? "Updated its memory" : "Saved a file" };
    if (/^(Edit|MultiEdit|NotebookEdit|edit_file)$/.test(tool)) return { title: memory ? "Updated its memory" : "Changed a file" };
    if (tool === "Glob") return { title: "Looked for files" };
    if (tool === "Grep") return { title: "Searched through files" };
    if (tool === "LS") return { title: "Looked through a folder" };
    if (tool === "upload") return { title: "Uploaded a file" };
    if (tool === "download") return { title: "Downloaded a file" };
    if (tool === "push_file") return { title: "Copied a file to the phone" };
    if (tool === "pull_file") return { title: "Copied a file from the phone" };
    return { title: "Worked with a file" };
  }
  if (tool === "WebFetch") {
    const host = hostOf(input.url);
    return { title: host ? `Looked at ${host}` : "Looked at a web page" };
  }
  if (tool === "WebSearch") return { title: "Searched the web", detail: truncate(str(input.query), 80) || undefined };
  if (kind === "plan") return { title: "Updated its to-do list" };
  if (tool === "Task" || tool === "Agent") return { title: str(input.description) || "Asked a helper" };
  if (tool === "Workflow") return { title: "Started a team task" };
  if (server === "android") {
    if (tool === "tap") return { title: "Tapped the screen" };
    if (tool === "long_press") return { title: "Pressed and held on the screen" };
    if (tool === "open_app" && str(input.package)) return { title: "Opened an app" };
  }
  switch (tool) {
    case "vault_fill_login":
    case "fill_login":
      return { title: `Filled in your login${forSite}`, detail: meta.detail };
    case "vault_fill_totp":
    case "fill_totp":
      return { title: `Entered your sign-in code${forSite}`, detail: meta.detail };
    case "vault_get_login":
      return { title: `Looked up a saved login${forSite}` };
    case "vault_get_totp":
      return { title: "Looked up a sign-in code" };
    case "agents_list":
      return { title: "Looked up its teammates" };
    case "agent_delegate": {
      const agentId = str(input.agentId);
      const name = agentId ? (ctx.agentName?.(agentId) ?? "") : "";
      return { title: name ? `Asked ${name} for help` : "Asked a teammate", detail: meta.detail };
    }
    case "runs_list":
      return { title: "Checked recent work" };
    case "run_continue":
      return { title: "Picked up where it left off" };
    case "run_cancel":
      return { title: "Stopped a teammate's run" };
    case "routine_create":
    case "routine_update":
      // The detail is the cron line or the trigger's name.
      return { title: meta.title };
    default:
      return null;
  }
}

/** Easy mode: what a call did in everyday words, without tool names, commands, paths or ids. Icon and kind stay. */
export function describeToolEasy(name: string, rawInput: unknown, ctx: ToolContext = {}): ToolMeta {
  const meta = describeTool(name, rawInput, ctx);
  const input: Input = rawInput && typeof rawInput === "object" ? (rawInput as Input) : {};
  const plain = easyMeta(meta, input, ctx);
  if (plain) return { ...meta, title: plain.title, detail: plain.detail };
  return { ...meta, detail: EASY_DETAIL_KINDS.has(meta.kind) ? meta.detail : undefined };
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
