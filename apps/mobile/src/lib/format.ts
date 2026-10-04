import { gatewayDone } from "@godmode/shared";
import { format, isThisYear, isToday, isYesterday } from "date-fns";
import type { MessageBlock } from "@godmode/shared";
import type { IconName } from "@/components/icon";

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (isToday(date)) return format(date, "HH:mm");
  if (isYesterday(date)) return "Yesterday";
  return format(date, isThisYear(date) ? "MMM d" : "MMM d, yyyy");
}

export function elapsed(fromIso: string | null | undefined, now = Date.now()): string {
  if (!fromIso) return "";
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
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

function clip(s: string, n = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export interface ToolLabel {
  icon: IconName;
  title: string;
  detail?: string;
}

/** "mcp__browser__browser_navigate" + input → "Opened github.com". */
export function toolLabel(block: Extract<MessageBlock, { type: "tool_use" }>): ToolLabel {
  const rest = block.name.startsWith("mcp__") ? block.name.slice(5) : null;
  const split = rest ? rest.indexOf("__") : -1;
  const server = rest && split > 0 ? rest.slice(0, split) : null;
  const tool = rest && split > 0 ? rest.slice(split + 2) : block.name;
  const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;

  if (server === "browser" || tool.startsWith("browser_")) {
    const t = tool.replace(/^browser_/, "");
    if (t === "navigate") return { icon: "globe", title: hostOf(input.url) ? `Opened ${hostOf(input.url)}` : "Opened a page", detail: str(input.url) };
    if (t === "click") return { icon: "cursor", title: "Clicked on the page" };
    if (t === "type" || t === "input_text") return { icon: "keyboard", title: "Typed text" };
    if (t === "scroll") return { icon: "scroll", title: `Scrolled ${str(input.direction) || "down"}` };
    if (t === "screenshot") return { icon: "camera", title: "Took a screenshot" };
    if (t === "go_back") return { icon: "back", title: "Went back" };
    if (t.includes("extract")) return { icon: "doc", title: "Read the page", detail: clip(str(input.query)) || undefined };
    if (t.includes("state")) return { icon: "doc", title: "Read the page" };
    return { icon: "globe", title: humanize(t) };
  }
  if (server === "computer" || server === "cua" || tool.startsWith("computer")) {
    const action = str(input.action);
    if (action === "screenshot") return { icon: "display", title: "Looked at the screen" };
    if (action.includes("click")) return { icon: "cursor", title: "Clicked" };
    if (action === "type") return { icon: "keyboard", title: "Typed text", detail: clip(str(input.text)) || undefined };
    if (action === "key") return { icon: "keyboard", title: `Pressed ${clip(str(input.text), 30) || "keys"}` };
    if (action === "scroll") return { icon: "scroll", title: "Scrolled" };
    return { icon: "display", title: action ? humanize(action) : "Used the computer" };
  }
  if (server === "vm") {
    if (tool === "shell") return { icon: "terminal", title: "Ran a command in the VM", detail: clip(str(input.command)) || undefined };
    if (tool === "screen") return { icon: "vm", title: str(input.action) === "screenshot" ? "Looked at the VM's screen" : "Used the VM" };
    return { icon: "vm", title: humanize(tool) };
  }
  if (server === "godmode") {
    if (tool.startsWith("vault_fill")) return { icon: "key", title: "Filled a login from the vault" };
    if (tool === "report_missing_login") return { icon: "warning", title: `Needs a login for ${str(input.service) || "a site"}` };
    if (tool === "agent_delegate") return { icon: "agents", title: "Handed a task to another agent", detail: clip(str(input.task)) || undefined };
    if (tool === "notify_user") return { icon: "bell", title: "Sent you a notification", detail: clip(str(input.title)) || undefined };
    if (tool === "ask_human") return { icon: "warning", title: "Asked you", detail: clip(str(input.question)) || undefined };
    if (tool === "request_approval") return { icon: "warning", title: "Asked for your OK", detail: clip(str(input.action)) || undefined };
    if (tool === "tasks_list") return { icon: "tasks", title: "Looked at the board" };
    if (tool === "task_get") return { icon: "tasks", title: "Read a task" };
    if (tool === "task_create") return { icon: "tasks", title: "Filed a task", detail: clip(str(input.title)) || undefined };
    if (tool === "task_update") return { icon: "tasks", title: "Changed a task" };
    if (tool === "task_message") return { icon: "tasks", title: "Sent a message into a task", detail: clip(str(input.content)) || undefined };
    if (tool === "task_note") return { icon: "pencil", title: "Left a note on the task", detail: clip(str(input.text)) || undefined };
    if (tool === "task_report_blocked") return { icon: "warning", title: "Reported what it needs", detail: clip(str(input.reason)) || undefined };
    return { icon: "bolt", title: gatewayDone(tool) };
  }
  switch (tool) {
    case "Bash":
      return { icon: "terminal", title: "Ran a command", detail: clip(str(input.description) || str(input.command)) || undefined };
    case "Read":
      return { icon: "doc", title: `Read ${basename(str(input.file_path))}` };
    case "Write":
      return { icon: "doc", title: `Wrote ${basename(str(input.file_path))}` };
    case "Edit":
    case "MultiEdit":
      return { icon: "pencil", title: `Edited ${basename(str(input.file_path))}` };
    case "Glob":
    case "Grep":
      return { icon: "search", title: "Searched files", detail: clip(str(input.pattern)) || undefined };
    case "WebSearch":
      return { icon: "search", title: "Searched the web", detail: clip(str(input.query)) || undefined };
    case "WebFetch":
      return { icon: "globe", title: `Read ${hostOf(input.url) || "a web page"}` };
    case "Task":
    case "Agent":
      return { icon: "agents", title: "Started a helper", detail: clip(str(input.description)) || undefined };
    case "TodoWrite":
      return { icon: "list", title: "Updated the plan" };
  }
  return { icon: "bolt", title: humanize(tool) };
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || "a file";
}

function humanize(tool: string): string {
  const s = tool.replace(/[_-]+/g, " ").trim();
  const words = s === s.toUpperCase() ? s.toLowerCase() : s;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DOING: [RegExp, string][] = [
  [/navigate|open_tab|go_to/, "Opening a page"],
  [/click/, "Clicking"],
  [/type|input_text|send_keys/, "Typing"],
  [/scroll/, "Scrolling"],
  [/screenshot|screen$/, "Looking at the screen"],
  [/extract|get_state|get_html|read_page/, "Reading the page"],
  [/^Bash$|shell/, "Running a command"],
  [/^(Read|Glob|Grep|LS)$|read_file/, "Reading files"],
  [/^(Write|Edit|MultiEdit)$|write_file|edit_file/, "Editing files"],
  [/WebSearch/, "Searching the web"],
  [/WebFetch/, "Reading a web page"],
  [/vault_fill/, "Signing in"],
  [/delegate|^Task$|^Agent$/, "Handing off to a helper"],
];

/** The core says "Using browser_navigate"; people read "Opening a page". */
export function activityText(label: string | null | undefined): string {
  if (!label) return "Thinking";
  // An older core sends "Using <tool id>" (no "…"); a current one sends plain words ending in "…" ("Using Linear…").
  const tool = /^Using ([\w.-]+)$/.exec(label)?.[1];
  if (!tool) return label.replace(/…$/, "");
  return DOING.find(([re]) => re.test(tool))?.[1] ?? "Working";
}
