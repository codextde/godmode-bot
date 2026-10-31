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
  FlagOff,
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
import { intlLocale, t } from "@/i18n";

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

const SCROLL_KEY = {
  up: "chat:tools.common.scrolledUp",
  down: "chat:tools.common.scrolledDown",
  left: "chat:tools.common.scrolledLeft",
  right: "chat:tools.common.scrolledRight",
} as const;

function scrolled(direction: string): string {
  const d = direction || "down";
  return d in SCROLL_KEY ? t(SCROLL_KEY[d as keyof typeof SCROLL_KEY]) : t("chat:tools.common.scrolledTo", { direction: d });
}

function pressed(keys: string): string {
  return keys ? t("chat:tools.common.pressed", { keys }) : t("chat:tools.common.pressedKeys");
}

function clicked(kind: "clicked" | "doubleClicked" | "tripleClicked" | "rightClicked", element: boolean, at: string): string {
  if (element) return t(`chat:tools.computer.${kind}Control`);
  return at ? t(`chat:tools.computer.${kind}At`, { at }) : t(`chat:tools.computer.${kind}`);
}

function browserMeta(tool: string, input: Input): Omit<ToolMeta, "kind" | "server" | "tool"> {
  const action = tool.replace(/^browser_/, "");
  const index = str(input.index ?? input.element_index ?? input.element);
  switch (action) {
    case "navigate": {
      const host = hostOf(input.url);
      return { icon: Globe, title: host ? t("chat:tools.common.opened", { name: host }) : t("chat:tools.browser.openedPage"), detail: str(input.url) };
    }
    case "click":
      return {
        icon: MousePointerClick,
        title: index
          ? t("chat:tools.browser.clickedElement", { index })
          : input.coordinate_x != null
            ? t("chat:tools.common.clickedPage")
            : t("chat:tools.computer.clicked"),
      };
    case "type":
    case "input_text":
      return { icon: Type, title: index ? t("chat:tools.browser.typedIntoElement", { index }) : t("chat:tools.common.typedText") };
    case "get_state":
    case "state":
      return { icon: ScanText, title: t("chat:tools.browser.readPage") };
    case "extract_content":
    case "extract":
      return { icon: FileSearch, title: t("chat:tools.browser.extracted"), detail: truncate(str(input.query), 80) || undefined };
    case "get_html":
      return { icon: Code2, title: t("chat:tools.browser.readHtml") };
    case "scroll":
      return { icon: ScrollText, title: scrolled(str(input.direction)) };
    case "go_back":
      return { icon: ArrowLeft, title: t("chat:tools.browser.wentBack") };
    case "screenshot":
      return { icon: Camera, title: t("chat:tools.browser.screenshot") };
    case "list_tabs":
      return { icon: PanelsTopLeft, title: t("chat:tools.browser.listedTabs") };
    case "switch_tab":
      return { icon: PanelsTopLeft, title: t("chat:tools.common.switchedTab") };
    case "close_tab":
      return { icon: X, title: t("chat:tools.common.closedTab") };
    case "send_keys":
      return { icon: Type, title: pressed(str(input.keys)) };
    case "retry_with_browser_use_agent":
      return { icon: Wand2, title: t("chat:tools.browser.browserAgent"), detail: truncate(str(input.task), 80) || undefined };
    default:
      return { icon: Globe, title: humanize(tool) };
  }
}

function computerMeta(tool: string, input: Input): Omit<ToolMeta, "kind" | "server" | "tool"> {
  if (tool === "computer_ui")
    return {
      icon: ListTree,
      title: input.query ? t("chat:tools.computer.lookedForInWindow", { query: truncate(str(input.query), 40) }) : t("chat:tools.common.readControls"),
    };
  if (tool === "computer_info") return { icon: Monitor, title: t("chat:tools.computer.checkedSharedScreen") };
  if (tool === "computer_windows") return { icon: AppWindow, title: input.focus != null ? t("chat:tools.computer.switchedWindow") : t("chat:tools.common.listedWindows") };
  if (tool === "computer_open_app") return { icon: AppWindow, title: str(input.name) ? t("chat:tools.common.opened", { name: str(input.name) }) : t("chat:tools.common.openedApp") };
  const at = Array.isArray(input.coordinate) ? input.coordinate.map((n) => Math.round(Number(n))).join(", ") : "";
  const element = !!input.element;
  switch (str(input.action)) {
    case "screenshot":
      return { icon: Camera, title: t("chat:tools.common.lookedAtScreen"), detail: input.display ? t("chat:tools.computer.display", { display: str(input.display) }) : undefined };
    case "left_click":
      return { icon: MousePointerClick, title: clicked("clicked", element, at) };
    case "double_click":
      return { icon: MousePointerClick, title: clicked("doubleClicked", element, at) };
    case "triple_click":
      return { icon: MousePointerClick, title: clicked("tripleClicked", element, at) };
    case "right_click":
      return { icon: MousePointerClick, title: clicked("rightClicked", element, at) };
    case "middle_click":
      return { icon: MousePointerClick, title: at ? t("chat:tools.computer.middleClickedAt", { at }) : t("chat:tools.computer.middleClicked") };
    case "mouse_move":
      return { icon: Move, title: at ? t("chat:tools.computer.movedPointerAt", { at }) : t("chat:tools.common.movedPointer") };
    case "left_click_drag":
      return { icon: Move, title: t("chat:tools.computer.dragged") };
    case "scroll":
      return { icon: ScrollText, title: scrolled(str(input.scroll_direction)) };
    case "type":
      return { icon: Type, title: element ? t("chat:tools.computer.typedIntoField") : t("chat:tools.common.typedText"), detail: truncate(str(input.text), 80) || undefined };
    case "key":
    case "hold_key":
      return { icon: Keyboard, title: pressed(truncate(str(input.text), 40)) };
    case "wait":
      return { icon: Hourglass, title: t("chat:tools.computer.waited", { seconds: str(input.duration) || "1" }) };
    case "zoom":
      return { icon: ZoomIn, title: t("chat:tools.computer.zoomedIn") };
    case "cursor_position":
      return { icon: MousePointerClick, title: t("chat:tools.computer.checkedPointer") };
    default:
      return { icon: MonitorUp, title: humanize(tool) };
  }
}

/** The `vm` server: shell, files and the whole screen of the VM a run works in. */
function vmMeta(tool: string, input: Input): Omit<ToolMeta, "server" | "tool"> {
  const path = str(input.path);
  switch (tool) {
    case "shell":
      return { kind: "shell", icon: Terminal, title: t("chat:tools.vm.ranCommand"), detail: truncate(str(input.command), 120) || undefined };
    case "read_file":
      return { kind: "file", icon: FileText, title: path ? t("chat:tools.vm.readFile", { name: basename(path) }) : t("chat:tools.vm.readAFile"), detail: path || undefined };
    case "write_file":
      return { kind: "file", icon: FilePlus2, title: path ? t("chat:tools.vm.wroteFile", { name: basename(path) }) : t("chat:tools.vm.wroteAFile"), detail: path || undefined };
    case "edit_file":
      return { kind: "file", icon: FilePen, title: path ? t("chat:tools.vm.editedFile", { name: basename(path) }) : t("chat:tools.vm.editedAFile"), detail: path || undefined };
    case "info":
      return { kind: "other", icon: Box, title: t("chat:tools.vm.checked") };
    default:
      return { ...computerMeta(tool, input), kind: "computer" };
  }
}

/** The server's name when the input names it (a name, not an `ssh_…` id), "" otherwise. */
function sshTarget(input: Input): string {
  const server = input.server;
  return typeof server === "string" && server.trim() && !server.startsWith("ssh_") ? server.trim() : "";
}

/** The `ssh` server: commands, files and transfers on the user's SSH servers. */
function sshMeta(tool: string, input: Input): Omit<ToolMeta, "server" | "tool"> {
  const named = sshTarget(input);
  const on = named || t("chat:tools.ssh.theServer");
  const path = str(input.path ?? input.remotePath ?? input.remote_path);
  const local = str(input.localPath ?? input.local_path);
  switch (tool) {
    case "shell":
      return {
        kind: "shell",
        icon: Terminal,
        title: input.sudo === true ? t("chat:tools.ssh.ranCommandRoot", { target: on }) : t("chat:tools.common.ranCommandOn", { target: on }),
        detail: truncate(str(input.command), 120) || undefined,
      };
    case "read_file":
      return {
        kind: "file",
        icon: FileText,
        title: path ? t("chat:tools.common.readFileOn", { name: basename(path), target: on }) : t("chat:tools.common.readAFileOn", { target: on }),
        detail: path || undefined,
      };
    case "write_file":
      return {
        kind: "file",
        icon: FilePlus2,
        title: path ? t("chat:tools.common.wroteFileOn", { name: basename(path), target: on }) : t("chat:tools.common.wroteAFileOn", { target: on }),
        detail: path || undefined,
      };
    case "edit_file":
      return {
        kind: "file",
        icon: FilePen,
        title: path ? t("chat:tools.common.editedFileOn", { name: basename(path), target: on }) : t("chat:tools.common.editedAFileOn", { target: on }),
        detail: path || undefined,
      };
    case "upload": {
      const name = basename(local || path);
      return {
        kind: "file",
        icon: FileUp,
        title: name ? t("chat:tools.ssh.uploaded", { name, target: on }) : t("chat:tools.ssh.uploadedAFile", { target: on }),
        detail: path || undefined,
      };
    }
    case "download": {
      const name = basename(path || local);
      return {
        kind: "file",
        icon: FileDown,
        title: name ? t("chat:tools.ssh.downloaded", { name, target: on }) : t("chat:tools.ssh.downloadedAFile", { target: on }),
        detail: local || undefined,
      };
    }
    case "list_servers":
      return { kind: "other", icon: Server, title: t("chat:tools.ssh.checkedServers") };
    default:
      return { kind: "other", icon: Server, title: humanize(tool), detail: named || undefined };
  }
}

/** The phone's name when the input names it (a name, not an `adr_…` id), "" otherwise. */
function phoneTarget(input: Input): string {
  const device = input.device;
  return typeof device === "string" && device.trim() && !device.startsWith("adr_") ? device.trim() : "";
}

/** "[540, 1200]" for an `[x, y]` coordinate, "" for anything else. */
function point(v: unknown): string {
  return Array.isArray(v) && v.length === 2 ? `[${v.map((n) => Math.round(Number(n))).join(", ")}]` : "";
}

/** The `android` server: screen, touch, apps, shell and files on the user's Android phones. */
function androidMeta(tool: string, input: Input, ctx: ToolContext): Omit<ToolMeta, "server" | "tool"> {
  const named = phoneTarget(input) || undefined;
  const on = named ?? t("chat:tools.android.thePhone");
  const local = str(input.local_path);
  const remote = str(input.remote_path);
  switch (tool) {
    case "list_devices":
      return { kind: "other", icon: Smartphone, title: t("chat:tools.android.checkedPhones") };
    case "screenshot":
      return { kind: "other", icon: Smartphone, title: t("chat:tools.common.lookedAtScreen"), detail: named };
    case "ui_elements":
      return {
        kind: "other",
        icon: ListTree,
        title: input.filter ? t("chat:tools.android.lookedForOnScreen", { query: truncate(str(input.filter), 40) }) : t("chat:tools.android.readScreen"),
        detail: named,
      };
    case "tap":
      return { kind: "other", icon: Pointer, title: point(input.coordinate) ? t("chat:tools.android.tappedAt", { at: point(input.coordinate) }) : t("chat:tools.android.tapped"), detail: named };
    case "long_press":
      return { kind: "other", icon: Pointer, title: point(input.coordinate) ? t("chat:tools.android.heldAt", { at: point(input.coordinate) }) : t("chat:tools.android.held"), detail: named };
    case "swipe": {
      const path = point(input.start_coordinate) && point(input.coordinate) ? `${point(input.start_coordinate)} → ${point(input.coordinate)}` : "";
      return { kind: "other", icon: Move, title: t("chat:tools.android.swiped"), detail: [path, named].filter(Boolean).join(" · ") || undefined };
    }
    case "scroll":
      return { kind: "other", icon: ScrollText, title: scrolled(str(input.direction)), detail: named };
    case "type_text":
      return { kind: "other", icon: Type, title: t("chat:tools.common.typedText"), detail: truncate(str(input.text), 80) || undefined };
    case "press_key": {
      const key = truncate(str(input.key).replace(/^KEYCODE_/i, "").replace(/_/g, " ").toLowerCase(), 40);
      const title = input.long === true
        ? key ? t("chat:tools.android.heldKey", { key }) : t("chat:tools.android.heldAKey")
        : key ? t("chat:tools.common.pressed", { keys: key }) : t("chat:tools.common.pressedAKey");
      return { kind: "other", icon: Keyboard, title, detail: named };
    }
    case "open_app": {
      const pkg = str(input.package);
      const url = str(input.url);
      // An app link ("myapp://screen") has no website to name.
      const appLink = /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url);
      const host = appLink ? "" : hostOf(url);
      const title = pkg
        ? t("chat:tools.common.opened", { name: pkg })
        : url
          ? host ? t("chat:tools.common.opened", { name: host }) : t("chat:tools.android.openedLink")
          : t("chat:tools.common.openedApp");
      return { kind: "other", icon: AppWindow, title, detail: url || named };
    }
    case "list_apps":
      return { kind: "other", icon: AppWindow, title: t("chat:tools.common.listedApps"), detail: named };
    case "shell":
      return { kind: "shell", icon: Terminal, title: t("chat:tools.common.ranCommandOn", { target: on }), detail: truncate(str(input.command), 120) || undefined };
    case "install_apk":
      return {
        kind: "other",
        icon: PackagePlus,
        title: local ? t("chat:tools.android.installed", { name: basename(local), target: on }) : t("chat:tools.android.installedApp", { target: on }),
      };
    case "push_file": {
      const name = basename(local || remote);
      return {
        kind: "file",
        icon: FileUp,
        title: name ? t("chat:tools.android.copiedTo", { name, target: on }) : t("chat:tools.android.copiedAFileTo", { target: on }),
        detail: remote || undefined,
      };
    }
    case "pull_file": {
      const name = basename(remote || local);
      return {
        kind: "file",
        icon: FileDown,
        title: name ? t("chat:tools.android.copiedFrom", { name, target: on }) : t("chat:tools.android.copiedAFileFrom", { target: on }),
        detail: local || undefined,
      };
    }
    case "fill_login": {
      const credId = str(input.credentialId);
      const label = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
      const title =
        str(input.field) === "username"
          ? label ? t("chat:tools.android.enteredUsernameFor", { label }) : t("chat:tools.android.enteredUsername")
          : label ? t("chat:tools.android.enteredPasswordFor", { label }) : t("chat:tools.android.enteredPassword");
      return { kind: "vault", icon: KeyRound, title, detail: t("chat:tools.common.fromVaultHidden") };
    }
    case "fill_totp": {
      const credId = str(input.credentialId);
      const label = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
      return { kind: "vault", icon: ShieldCheck, title: label ? t("chat:tools.common.entered2faFor", { label }) : t("chat:tools.common.entered2fa"), detail: t("chat:tools.common.fromVault") };
    }
    default:
      return { kind: "other", icon: Smartphone, title: humanize(tool), detail: named };
  }
}

/** The `cua` server: Cua Driver controlling the apps and windows inside the VM. */
function cuaMeta(tool: string, input: Input): Omit<ToolMeta, "kind" | "server" | "tool"> {
  const app = str(input.app_name ?? input.app ?? input.name ?? input.bundle_id);
  if (/launch|open_app/.test(tool)) return { icon: AppWindow, title: app ? t("chat:tools.common.opened", { name: app }) : t("chat:tools.common.openedApp") };
  if (/list_(windows|apps)/.test(tool)) return { icon: AppWindow, title: tool === "list_apps" ? t("chat:tools.common.listedApps") : t("chat:tools.common.listedWindows") };
  if (/window_state|desktop_state|accessibility|tree/.test(tool)) return { icon: ListTree, title: t("chat:tools.common.readControls") };
  if (/screenshot/.test(tool)) return { icon: Camera, title: t("chat:tools.common.lookedAtScreen") };
  if (/click/.test(tool))
    return {
      icon: MousePointerClick,
      title: /double/.test(tool) ? t("chat:tools.computer.doubleClicked") : /right/.test(tool) ? t("chat:tools.computer.rightClicked") : t("chat:tools.computer.clicked"),
    };
  if (/type|set_value/.test(tool)) return { icon: Type, title: t("chat:tools.common.typedText"), detail: truncate(str(input.text ?? input.value), 80) || undefined };
  if (/key/.test(tool)) return { icon: Keyboard, title: pressed(truncate(str(input.key ?? input.keys ?? input.text), 40)) };
  if (/scroll/.test(tool)) return { icon: ScrollText, title: t("chat:tools.common.scrolled") };
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
  "project_delete",
  "notify_user",
  "followup_schedule",
  "followup_cancel",
  "goal_clear",
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

/** The number of a task reference ("#12", "12"), "" for an id. */
function taskNumber(input: Input): string {
  return /^#?(\d+)$/.exec(str(input.taskId))?.[1] ?? "";
}

/** "in 90 min" or the `at` time of a followup_schedule call. */
function followupTime(input: Input): string {
  if (typeof input.inMinutes === "number") {
    const m = input.inMinutes;
    return m < 90
      ? t("chat:tools.followup.inMinutes", { count: m })
      : m < 48 * 60
        ? t("chat:tools.followup.inHours", { count: Math.round(m / 60) })
        : t("chat:tools.followup.inDays", { count: Math.round(m / 1440) });
  }
  const at = new Date(str(input.at).replace(" ", "T"));
  if (Number.isNaN(at.getTime())) return t("chat:tools.followup.later");
  return t("chat:tools.followup.on", {
    date: at.toLocaleString(intlLocale(), { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  });
}

/** What starts an automation, for routine_create / routine_update: the app event, the condition or the cron. */
function automationDetail(input: Input): string | undefined {
  const trigger = input.trigger;
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const trg = trigger as Input;
    if (trg.type === "app") return str(trg.triggerName) || t("chat:tools.godmode.onAppEvent");
    if (trg.type === "condition") return truncate(t("chat:tools.godmode.whenCondition", { condition: str(trg.condition) }), 120);
    if (trg.type === "webhook") return t("chat:tools.godmode.onWebhook");
  }
  return str(input.cron) || undefined;
}

function godmodeMeta(tool: string, input: Input, ctx: ToolContext): Omit<ToolMeta, "server" | "tool"> | null {
  const credId = str(input.credentialId);
  const credLabel = credId ? (ctx.credentialLabel?.(credId) ?? "") : "";
  const agentId = str(input.agentId ?? input.id);
  const agentName = agentId ? (ctx.agentName?.(agentId) ?? "") : "";
  const taskN = taskNumber(input);
  const name = str(input.name);
  switch (tool) {
    case "vault_list_logins":
      return {
        kind: "vault",
        icon: KeyRound,
        title: input.domain ? t("chat:tools.godmode.lookedUpLoginsFor", { host: hostOf(input.domain) }) : t("chat:tools.godmode.lookedUpLogins"),
      };
    case "vault_fill_login": {
      const field = str(input.field) || "password";
      const title =
        field === "username"
          ? credLabel ? t("chat:tools.godmode.filledUsernameFor", { label: credLabel }) : t("chat:tools.godmode.filledUsername")
          : field === "password"
            ? credLabel ? t("chat:tools.godmode.filledPasswordFor", { label: credLabel }) : t("chat:tools.godmode.filledPassword")
            : credLabel ? t("chat:tools.godmode.filledFieldFor", { field, label: credLabel }) : t("chat:tools.godmode.filledField", { field });
      return { kind: "vault", icon: KeyRound, title, detail: t("chat:tools.common.fromVaultHidden") };
    }
    case "vault_fill_totp":
      return {
        kind: "vault",
        icon: ShieldCheck,
        title: credLabel ? t("chat:tools.common.entered2faFor", { label: credLabel }) : t("chat:tools.common.entered2fa"),
        detail: t("chat:tools.common.fromVault"),
      };
    case "vault_save_login": {
      const site = hostOf(input.url);
      const user = str(input.username);
      return {
        kind: "vault",
        icon: KeyRound,
        title: site ? t("chat:tools.godmode.savedLoginFor", { site }) : t("chat:tools.godmode.savedLogin"),
        detail: [user, input.generatePassword ? t("chat:tools.godmode.newPasswordHidden") : t("chat:tools.godmode.passwordEncrypted")].filter(Boolean).join(" · "),
      };
    }
    case "vault_get_login":
      return {
        kind: "vault",
        icon: Eye,
        title: credLabel ? t("chat:tools.godmode.revealedLoginFor", { label: credLabel }) : t("chat:tools.godmode.revealedLogin"),
        detail: t("chat:tools.godmode.audited"),
      };
    case "vault_get_totp":
      return { kind: "vault", icon: Eye, title: t("chat:tools.godmode.read2fa"), detail: t("chat:tools.godmode.audited") };
    case "vault_list_cards":
      return { kind: "vault", icon: CreditCard, title: t("chat:tools.godmode.lookedUpCards") };
    case "vault_card_purchase": {
      const amount = typeof input.amount === "number" ? `${str(input.currency).toUpperCase()} ${input.amount.toFixed(2)}`.trim() : "";
      const merchant = str(input.merchant);
      const ask = amount ? t("chat:tools.godmode.askedToPayAmount", { amount }) : t("chat:tools.godmode.askedToPay");
      return { kind: "vault", icon: CreditCard, title: `${ask}${merchant ? ` · ${truncate(merchant, 60)}` : ""}`, detail: str(input.description) || undefined };
    }
    case "vault_fill_card": {
      const field = str(input.field).replace(/_/g, " ");
      return {
        kind: "vault",
        icon: CreditCard,
        title: field ? t("chat:tools.godmode.enteredCardField", { field }) : t("chat:tools.godmode.enteredCardDetails"),
        detail: t("chat:tools.common.fromVaultHidden"),
      };
    }
    case "vault_card_purchase_result":
      return {
        kind: "vault",
        icon: CreditCard,
        title: str(input.outcome) === "failed" ? t("chat:tools.godmode.paymentFailed") : t("chat:tools.godmode.paymentDone"),
        detail: str(input.note) || undefined,
      };
    case "report_missing_login": {
      const service = str(input.service) || hostOf(input.url);
      return {
        kind: "missing-login",
        icon: ShieldAlert,
        title: service ? t("chat:tools.godmode.needsLoginFor", { service }) : t("chat:tools.godmode.needsLogin"),
        detail: str(input.reason) || undefined,
      };
    }
    case "agents_list":
      return { kind: "agents", icon: Bot, title: t("chat:tools.godmode.lookedUpAgents") };
    case "agent_get":
      return { kind: "agents", icon: Bot, title: agentName ? t("chat:tools.godmode.lookedUpNamed", { name: agentName }) : t("chat:tools.godmode.lookedUpAgent") };
    case "agent_delegate":
      return {
        kind: "delegate",
        icon: BotMessageSquare,
        title: agentName ? t("chat:tools.godmode.delegatedTo", { name: agentName }) : t("chat:tools.godmode.delegatedToAgent"),
        detail: truncate(str(input.task), 120) || undefined,
      };
    case "agent_create":
      return {
        kind: "agents",
        icon: UserCog,
        title: name ? t("chat:tools.godmode.createdAgentNamed", { name }) : t("chat:tools.godmode.createdAgent"),
        detail: str(input.template) ? t("chat:tools.godmode.fromTemplate", { template: humanize(str(input.template)) }) : undefined,
      };
    case "templates_list":
      return { kind: "agents", icon: Bot, title: t("chat:tools.godmode.lookedAtTemplates") };
    case "team_install": {
      const workspace = str((input.newWorkspace as Input | undefined)?.name);
      const team = humanize(str(input.template));
      return {
        kind: "agents",
        icon: UserCog,
        title: team ? t("chat:tools.godmode.hired", { name: team }) : t("chat:tools.godmode.hiredTeam"),
        detail: workspace ? t("chat:tools.godmode.inNewWorkspace", { name: workspace }) : undefined,
      };
    }
    case "agent_update":
      return { kind: "agents", icon: UserCog, title: agentName ? t("chat:tools.godmode.updatedNamed", { name: agentName }) : t("chat:tools.godmode.updatedAgent") };
    case "agent_delete":
      return { kind: "agents", icon: Trash2, title: agentName ? t("chat:tools.godmode.deletedNamed", { name: agentName }) : t("chat:tools.godmode.deletedAgent") };
    case "routine_create":
      return {
        kind: "agents",
        icon: Workflow,
        title: name ? t("chat:tools.godmode.createdAutomationNamed", { name }) : t("chat:tools.godmode.createdAutomation"),
        detail: automationDetail(input),
      };
    case "routine_update":
      return { kind: "agents", icon: Workflow, title: t("chat:tools.godmode.updatedAutomation"), detail: automationDetail(input) };
    case "routine_delete":
      return { kind: "agents", icon: Trash2, title: t("chat:tools.godmode.deletedAutomation") };
    case "my_routines":
      return { kind: "agents", icon: Workflow, title: t("chat:tools.godmode.lookedAtAutomations") };
    case "my_routine_set_enabled":
      return {
        kind: "agents",
        icon: Workflow,
        title: input.enabled === false ? t("chat:tools.godmode.pausedAutomation") : t("chat:tools.godmode.enabledAutomation"),
        detail: truncate(str(input.reason), 120) || undefined,
      };
    case "automation_triggers_list":
      return { kind: "agents", icon: Workflow, title: t("chat:tools.godmode.lookedUpTriggers") };
    case "automation_events_list":
      return { kind: "agents", icon: History, title: t("chat:tools.godmode.checkedAutomationEvents") };
    case "automation_check_result":
      return {
        kind: "agents",
        icon: ScanText,
        title: input.met === true ? t("chat:tools.godmode.conditionMet") : t("chat:tools.godmode.conditionNotMet"),
        detail: truncate(str(input.summary ?? input.observation), 120) || undefined,
      };
    case "runs_list":
      return { kind: "agents", icon: History, title: t("chat:tools.godmode.checkedRuns") };
    case "run_continue":
      return { kind: "agents", icon: Play, title: t("chat:tools.godmode.continuedRun") };
    case "run_cancel":
      return { kind: "agents", icon: CircleStop, title: t("chat:tools.godmode.stoppedRun"), detail: truncate(str(input.reason), 120) || undefined };
    case "workspaces_list":
      return { kind: "agents", icon: Layers, title: t("chat:tools.godmode.listedWorkspaces") };
    case "workspace_create":
      return {
        kind: "agents",
        icon: Layers,
        title: name ? t("chat:tools.godmode.createdWorkspaceNamed", { name }) : t("chat:tools.godmode.createdWorkspace"),
        detail: truncate(str(input.description), 120) || undefined,
      };
    case "workspace_update":
      return { kind: "agents", icon: Layers, title: t("chat:tools.godmode.updatedWorkspace") };
    case "project_create":
      return {
        kind: "agents",
        icon: FolderKanban,
        title: name ? t("chat:tools.godmode.createdProjectNamed", { name }) : t("chat:tools.godmode.createdProject"),
        detail: truncate(str(input.description), 120) || undefined,
      };
    case "project_update":
      return { kind: "agents", icon: FolderKanban, title: t("chat:tools.godmode.updatedProject") };
    case "project_delete":
      return { kind: "agents", icon: FolderKanban, title: t("chat:tools.godmode.deletedProject") };
    case "notify_user":
      return { kind: "notify", icon: Bell, title: t("chat:tools.godmode.sentNotification"), detail: str(input.title) || undefined };
    case "followup_schedule":
      return { kind: "notify", icon: AlarmClock, title: t("chat:tools.godmode.willContinue", { when: followupTime(input) }), detail: truncate(str(input.note), 120) || undefined };
    case "followup_cancel":
      return { kind: "notify", icon: AlarmClockOff, title: t("chat:tools.godmode.cancelledFollowup") };
    case "goal_clear":
      return { kind: "notify", icon: FlagOff, title: t("chat:tools.godmode.endedGoal"), detail: truncate(str(input.reason), 120) || undefined };
    case "ask_human":
      return { kind: "agents", icon: MessageCircleQuestion, title: t("chat:tools.godmode.askedYou"), detail: truncate(str(input.question), 120) || undefined };
    case "request_approval":
      return { kind: "agents", icon: ShieldCheck, title: t("chat:tools.godmode.askedOk"), detail: truncate(str(input.action), 120) || undefined };
    case "tasks_list":
      return { kind: "agents", icon: SquareKanban, title: t("chat:tools.godmode.lookedAtBoard") };
    case "task_get":
      return { kind: "agents", icon: SquareKanban, title: taskN ? t("chat:tools.godmode.readTaskN", { n: taskN }) : t("chat:tools.godmode.readTask") };
    case "task_create":
      return { kind: "agents", icon: SquareKanban, title: t("chat:tools.godmode.filedTask"), detail: truncate(str(input.title), 120) || undefined };
    case "task_update":
      return { kind: "agents", icon: SquareKanban, title: taskN ? t("chat:tools.godmode.changedTaskN", { n: taskN }) : t("chat:tools.godmode.changedTask") };
    case "task_message":
      return {
        kind: "agents",
        icon: MessageSquareReply,
        title: taskN ? t("chat:tools.godmode.messagedTaskN", { n: taskN }) : t("chat:tools.godmode.messagedTask"),
        detail: truncate(str(input.content), 120) || undefined,
      };
    case "task_note":
      return { kind: "agents", icon: NotebookPen, title: t("chat:tools.godmode.leftNote"), detail: truncate(str(input.text), 120) || undefined };
    case "artifact_create":
      return { kind: "other", icon: AppWindow, title: str(input.title) ? t("chat:tools.godmode.built", { title: str(input.title) }) : t("chat:tools.godmode.builtArtifact") };
    case "artifact_update":
      return { kind: "other", icon: AppWindow, title: t("chat:tools.godmode.changedArtifact"), detail: truncate(str(input.note), 120) || undefined };
    case "artifact_get":
      return { kind: "other", icon: AppWindow, title: t("chat:tools.godmode.readArtifact") };
    case "artifact_list":
      return { kind: "other", icon: AppWindow, title: t("chat:tools.godmode.lookedAtArtifacts") };
    case "task_report_blocked":
      return { kind: "agents", icon: OctagonAlert, title: t("chat:tools.godmode.reportedBlocked"), detail: truncate(str(input.reason), 120) || undefined };
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
        title: str(input.description) || t("chat:tools.builtin.ranCommand"),
        detail: truncate(str(input.command), 120) || undefined,
      };
    case "BashOutput":
    case "Monitor":
      return { kind: "shell", icon: Terminal, title: t("chat:tools.builtin.checkedOutput") };
    case "Read":
      return { kind: "file", icon: FileText, title: path ? t("chat:tools.builtin.read", { name: basename(path) }) : t("chat:tools.common.readAFile"), detail: path || undefined };
    case "Write":
      return { kind: "file", icon: FilePlus2, title: path ? t("chat:tools.builtin.wrote", { name: basename(path) }) : t("chat:tools.builtin.wroteAFile"), detail: path || undefined };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "file", icon: FilePen, title: path ? t("chat:tools.builtin.edited", { name: basename(path) }) : t("chat:tools.builtin.editedAFile"), detail: path || undefined };
    case "Glob":
      return { kind: "file", icon: FolderSearch, title: t("chat:tools.builtin.searchedFiles"), detail: str(input.pattern) || undefined };
    case "Grep":
      return { kind: "file", icon: Search, title: t("chat:tools.builtin.searchedFor", { pattern: truncate(str(input.pattern), 40) }) };
    case "LS":
      return { kind: "file", icon: ListTree, title: path ? t("chat:tools.builtin.listed", { name: basename(path) }) : t("chat:tools.builtin.listedFiles") };
    case "WebFetch": {
      const host = hostOf(input.url);
      return { kind: "web", icon: Link2, title: host ? t("chat:tools.builtin.fetched", { host }) : t("chat:tools.builtin.fetchedPage"), detail: str(input.url) || undefined };
    }
    case "WebSearch":
      return { kind: "web", icon: Search, title: t("chat:tools.builtin.searchedWebFor", { query: truncate(str(input.query), 60) }) };
    case "Task":
    case "Agent": {
      const who = str(input.subagent_type);
      return {
        kind: "subagent",
        icon: Bot,
        title: str(input.description) || (who ? t("chat:tools.builtin.asked", { name: who }) : t("chat:tools.builtin.ranSubagent")),
        detail: who && who !== "general-purpose" ? who : undefined,
      };
    }
    case "Workflow":
      return { kind: "subagent", icon: Workflow, title: str(input.name) ? t("chat:tools.builtin.ranWorkflowNamed", { name: str(input.name) }) : t("chat:tools.builtin.ranWorkflow") };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { kind: "plan", icon: ListChecks, title: t("chat:tools.builtin.updatedPlan") };
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
  
  if (kind === "browser") {
    switch (tool.replace(/^browser_/, "")) {
      case "click":
        return { title: t("chat:tools.common.clickedPage") };
      case "type":
      case "input_text":
        return { title: t("chat:tools.common.typedText") };
      case "get_state":
      case "state":
      case "get_html":
        return { title: t("chat:tools.easy.lookedAtPage") };
      case "extract_content":
      case "extract":
        return { title: t("chat:tools.easy.readPage"), detail: meta.detail };
      case "scroll":
        return { title: t("chat:tools.easy.scrolledPage") };
      case "send_keys":
        return { title: t("chat:tools.common.pressedAKey") };
      case "list_tabs":
        return { title: t("chat:tools.easy.checkedTabs") };
      case "switch_tab":
        return { title: t("chat:tools.common.switchedTab") };
      case "close_tab":
        return { title: t("chat:tools.common.closedTab") };
      case "retry_with_browser_use_agent":
        return { title: t("chat:tools.easy.askedBrowserHelper"), detail: meta.detail };
      default:
        return null;
    }
  }
  if (kind === "computer") {
    const action = str(input.action) || tool;
    if (/screenshot/.test(action)) return { title: t("chat:tools.common.lookedAtScreen") };
    if (/drag|mouse_move|move_(cursor|mouse|pointer)/.test(action)) return { title: t("chat:tools.common.movedPointer") };
    if (/click/.test(action)) return {
        title: /double/.test(action)
          ? t("chat:tools.easy.doubleClickedScreen")
          : /right/.test(action)
            ? t("chat:tools.easy.rightClickedScreen")
            : t("chat:tools.easy.clickedScreen"),
      };
    if (/key/.test(action)) return { title: t("chat:tools.common.pressedAKey") };
    if (/type|set_value/.test(action)) return { title: t("chat:tools.common.typedText") };
    if (/scroll/.test(action)) return { title: t("chat:tools.common.scrolled") };
    return null;
  }
  if (kind === "shell") return { title: tool === "BashOutput" || tool === "Monitor" ? t("chat:tools.easy.checkedCommand") : t("chat:tools.builtin.ranCommand") };
  if (kind === "file") {
    if (/^(Read|read_file)$/.test(tool)) return { title: memory ? t("chat:tools.easy.checkedMemory") : t("chat:tools.common.readAFile") };
    if (/^(Write|write_file)$/.test(tool)) return { title: memory ? t("chat:tools.easy.updatedMemory") : t("chat:tools.easy.savedFile") };
    if (/^(Edit|MultiEdit|NotebookEdit|edit_file)$/.test(tool)) return { title: memory ? t("chat:tools.easy.updatedMemory") : t("chat:tools.easy.changedFile") };
    if (tool === "Glob") return { title: t("chat:tools.easy.lookedForFiles") };
    if (tool === "Grep") return { title: t("chat:tools.easy.searchedFiles") };
    if (tool === "LS") return { title: t("chat:tools.easy.lookedThroughFolder") };
    if (tool === "upload") return { title: t("chat:tools.easy.uploadedFile") };
    if (tool === "download") return { title: t("chat:tools.easy.downloadedFile") };
    if (tool === "push_file") return { title: t("chat:tools.easy.copiedToPhone") };
    if (tool === "pull_file") return { title: t("chat:tools.easy.copiedFromPhone") };
    return { title: t("chat:tools.easy.workedWithFile") };
  }
  if (tool === "WebFetch") {
    const host = hostOf(input.url);
    return { title: host ? t("chat:tools.easy.lookedAtHost", { host }) : t("chat:tools.easy.lookedAtWebPage") };
  }
  if (tool === "WebSearch") return { title: t("chat:tools.easy.searchedWeb"), detail: truncate(str(input.query), 80) || undefined };
  if (kind === "plan") return { title: t("chat:tools.easy.updatedTodos") };
  if (tool === "Task" || tool === "Agent") return { title: str(input.description) || t("chat:tools.easy.askedHelper") };
  if (tool === "Workflow") return { title: t("chat:tools.easy.startedTeamTask") };
  if (server === "android") {
    if (tool === "tap") return { title: t("chat:tools.easy.tappedScreen") };
    if (tool === "long_press") return { title: t("chat:tools.easy.heldScreen") };
    if (tool === "open_app" && str(input.package)) return { title: t("chat:tools.common.openedApp") };
  }
  switch (tool) {
    case "vault_fill_login":
    case "fill_login":
      return { title: credLabel ? t("chat:tools.easy.filledLoginFor", { label: credLabel }) : t("chat:tools.easy.filledLogin"), detail: meta.detail };
    case "vault_fill_totp":
    case "fill_totp":
      return { title: credLabel ? t("chat:tools.easy.enteredCodeFor", { label: credLabel }) : t("chat:tools.easy.enteredCode"), detail: meta.detail };
    case "vault_get_login":
      return { title: credLabel ? t("chat:tools.easy.lookedUpLoginFor", { label: credLabel }) : t("chat:tools.easy.lookedUpLogin") };
    case "vault_get_totp":
      return { title: t("chat:tools.easy.lookedUpCode") };
    case "agents_list":
      return { title: t("chat:tools.easy.lookedUpTeammates") };
    case "agent_delegate": {
      const agentId = str(input.agentId);
      const name = agentId ? (ctx.agentName?.(agentId) ?? "") : "";
      return { title: name ? t("chat:tools.easy.askedForHelp", { name }) : t("chat:tools.easy.askedTeammate"), detail: meta.detail };
    }
    case "runs_list":
      return { title: t("chat:tools.easy.checkedRecentWork") };
    case "run_continue":
      return { title: t("chat:tools.easy.pickedUp") };
    case "run_cancel":
      return { title: t("chat:tools.easy.stoppedTeammateRun") };
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
