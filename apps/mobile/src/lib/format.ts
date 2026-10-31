import { gatewayDone } from "@godmode/shared";
import { format, isThisYear, isToday, isTomorrow, isYesterday } from "date-fns";
import type { MessageBlock } from "@godmode/shared";
import type { IconName } from "@/components/icon";
import { dateLocale, t } from "@/lib/i18n";

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return t("system:time.now");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (isToday(date)) return format(date, "p", { locale: dateLocale() });
  if (isYesterday(date)) return t("common:words.yesterday");
  return format(date, isThisYear(date) ? t("system:formats.dayMonth") : t("system:formats.dayMonthYear"), { locale: dateLocale() });
}

/** "today at 16:00", "tomorrow at 09:00", "Thu, Oct 1 at 09:00" */
export function whenText(iso: string): string {
  const date = new Date(iso);
  const time = format(date, "p", { locale: dateLocale() });
  if (isToday(date)) return t("system:time.todayAt", { time });
  if (isTomorrow(date)) return t("system:time.tomorrowAt", { time });
  if (isYesterday(date)) return t("system:time.yesterdayAt", { time });
  const day = format(date, isThisYear(date) ? t("system:formats.weekdayDayMonth") : t("system:formats.weekdayDayMonthYear"), { locale: dateLocale() });
  return t("system:time.dateAt", { date: day, time });
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
  if (h < 5) return t("system:greeting.night");
  if (h < 12) return t("system:greeting.morning");
  if (h < 18) return t("system:greeting.afternoon");
  return t("system:greeting.evening");
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
    const name = tool.replace(/^browser_/, "");
    if (name === "navigate") return { icon: "globe", title: hostOf(input.url) ? t("system:tools.openedHost", { host: hostOf(input.url) }) : t("system:tools.openedPage"), detail: str(input.url) };
    if (name === "click") return { icon: "cursor", title: t("system:tools.clickedPage") };
    if (name === "type" || name === "input_text") return { icon: "keyboard", title: t("system:tools.typedText") };
    if (name === "scroll") return { icon: "scroll", title: t("system:tools.scrolledDirection", { direction: directionLabel(str(input.direction) || "down") }) };
    if (name === "screenshot") return { icon: "camera", title: t("system:tools.tookScreenshot") };
    if (name === "go_back") return { icon: "back", title: t("system:tools.wentBack") };
    if (name.includes("extract")) return { icon: "doc", title: t("system:tools.readPage"), detail: clip(str(input.query)) || undefined };
    if (name.includes("state")) return { icon: "doc", title: t("system:tools.readPage") };
    return { icon: "globe", title: humanize(name) };
  }
  if (server === "computer" || server === "cua" || tool.startsWith("computer")) {
    const action = str(input.action);
    if (action === "screenshot") return { icon: "display", title: t("system:tools.lookedAtScreen") };
    if (action.includes("click")) return { icon: "cursor", title: t("system:tools.clicked") };
    if (action === "type") return { icon: "keyboard", title: t("system:tools.typedText"), detail: clip(str(input.text)) || undefined };
    if (action === "key") {
      const keys = clip(str(input.text), 30);
      return { icon: "keyboard", title: keys ? t("system:tools.pressed", { keys }) : t("system:tools.pressedKeys") };
    }
    if (action === "scroll") return { icon: "scroll", title: t("system:tools.scrolled") };
    return { icon: "display", title: action ? humanize(action) : t("system:tools.usedComputer") };
  }
  if (server === "vm") {
    if (tool === "shell") return { icon: "terminal", title: t("system:tools.ranCommandInVm"), detail: clip(str(input.command)) || undefined };
    if (tool === "screen") return { icon: "vm", title: str(input.action) === "screenshot" ? t("system:tools.lookedAtVmScreen") : t("system:tools.usedVm") };
    return { icon: "vm", title: humanize(tool) };
  }
  if (server === "godmode") {
    if (tool.startsWith("vault_fill")) return { icon: "key", title: t("system:tools.filledLogin") };
    if (tool === "report_missing_login") {
      const service = str(input.service);
      return { icon: "warning", title: service ? t("system:tools.needsLoginFor", { service }) : t("system:tools.needsLoginForSite") };
    }
    if (tool === "agent_delegate") return { icon: "agents", title: t("system:tools.handedTask"), detail: clip(str(input.task)) || undefined };
    if (tool === "notify_user") return { icon: "bell", title: t("system:tools.sentNotification"), detail: clip(str(input.title)) || undefined };
    if (tool === "ask_human") return { icon: "warning", title: t("system:tools.askedYou"), detail: clip(str(input.question)) || undefined };
    if (tool === "request_approval") return { icon: "warning", title: t("system:tools.askedForOk"), detail: clip(str(input.action)) || undefined };
    if (tool === "tasks_list") return { icon: "tasks", title: t("system:tools.lookedAtBoard") };
    if (tool === "task_get") return { icon: "tasks", title: t("system:tools.readTask") };
    if (tool === "task_create") return { icon: "tasks", title: t("system:tools.filedTask"), detail: clip(str(input.title)) || undefined };
    if (tool === "task_update") return { icon: "tasks", title: t("system:tools.changedTask") };
    if (tool === "task_message") return { icon: "tasks", title: t("system:tools.sentTaskMessage"), detail: clip(str(input.content)) || undefined };
    if (tool === "task_note") return { icon: "pencil", title: t("system:tools.leftNote"), detail: clip(str(input.text)) || undefined };
    if (tool === "task_report_blocked") return { icon: "warning", title: t("system:tools.reportedNeeds"), detail: clip(str(input.reason)) || undefined };
    if (tool === "my_routine_set_enabled") {
      return {
        icon: "workflow",
        title: input.enabled === false ? t("system:tools.pausedAutomation") : t("system:tools.enabledAutomation"),
        detail: clip(str(input.reason)) || undefined,
      };
    }
    return { icon: "bolt", title: gatewayDone(tool) };
  }
  switch (tool) {
    case "Bash":
      return { icon: "terminal", title: t("system:tools.ranCommand"), detail: clip(str(input.description) || str(input.command)) || undefined };
    case "Read": {
      const name = basename(str(input.file_path));
      return { icon: "doc", title: name ? t("system:tools.readFile", { name }) : t("system:tools.readAFile") };
    }
    case "Write": {
      const name = basename(str(input.file_path));
      return { icon: "doc", title: name ? t("system:tools.wroteFile", { name }) : t("system:tools.wroteAFile") };
    }
    case "Edit":
    case "MultiEdit": {
      const name = basename(str(input.file_path));
      return { icon: "pencil", title: name ? t("system:tools.editedFile", { name }) : t("system:tools.editedAFile") };
    }
    case "Glob":
    case "Grep":
      return { icon: "search", title: t("system:tools.searchedFiles"), detail: clip(str(input.pattern)) || undefined };
    case "WebSearch":
      return { icon: "search", title: t("system:tools.searchedWeb"), detail: clip(str(input.query)) || undefined };
    case "WebFetch": {
      const host = hostOf(input.url);
      return { icon: "globe", title: host ? t("system:tools.readHost", { host }) : t("system:tools.readWebPage") };
    }
    case "Task":
    case "Agent":
      return { icon: "agents", title: t("system:tools.startedHelper"), detail: clip(str(input.description)) || undefined };
    case "TodoWrite":
      return { icon: "list", title: t("system:tools.updatedPlan") };
  }
  return { icon: "bolt", title: humanize(tool) };
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || "";
}

const DIRECTIONS = ["up", "down", "left", "right"] as const;

function directionLabel(direction: string): string {
  const known = DIRECTIONS.find((d) => d === direction);
  return known ? t(`system:tools.direction.${known}`) : direction;
}

function humanize(tool: string): string {
  const s = tool.replace(/[_-]+/g, " ").trim();
  const words = s === s.toUpperCase() ? s.toLowerCase() : s;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DOING = [
  [/navigate|open_tab|go_to/, "system:doing.openingPage"],
  [/click/, "system:doing.clicking"],
  [/type|input_text|send_keys/, "system:doing.typing"],
  [/scroll/, "system:doing.scrolling"],
  [/screenshot|screen$/, "system:doing.lookingAtScreen"],
  [/extract|get_state|get_html|read_page/, "system:doing.readingPage"],
  [/^Bash$|shell/, "system:doing.runningCommand"],
  [/^(Read|Glob|Grep|LS)$|read_file/, "system:doing.readingFiles"],
  [/^(Write|Edit|MultiEdit)$|write_file|edit_file/, "system:doing.editingFiles"],
  [/WebSearch/, "system:doing.searchingWeb"],
  [/WebFetch/, "system:doing.readingWebPage"],
  [/vault_fill/, "system:doing.signingIn"],
  [/delegate|^Task$|^Agent$/, "system:doing.handingOff"],
] as const;

/** The core says "Using browser_navigate"; people read "Opening a page". */
export function activityText(label: string | null | undefined): string {
  if (!label) return t("system:doing.thinking");
  // An older core sends "Using <tool id>" (no "…"); a current one sends plain words ending in "…" ("Using Linear…").
  const tool = /^Using ([\w.-]+)$/.exec(label)?.[1];
  if (!tool) return label.replace(/…$/, "");
  return t(DOING.find(([re]) => re.test(tool))?.[1] ?? "system:doing.working");
}
