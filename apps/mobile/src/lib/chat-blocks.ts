import type { Href } from "expo-router";
import { WORKFLOW_TOOL, type MessageBlock } from "@godmode/shared";

type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;

/** A tool's own name, without its MCP server ("mcp__godmode__agent_delegate" → "agent_delegate"). */
export const bareTool = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name);

export type CardKind = "artifact" | "handoff" | "delegate" | "workflow" | "missing-login";

/** Tool calls that show as their own card in a reply instead of a line in its steps. */
export function cardKindOf(name: string): CardKind | null {
  const bare = bareTool(name);
  if (bare === "report_missing_login") return "missing-login";
  if (bare === "chat_handoff") return "handoff";
  if (bare === "artifact_create" || bare === "artifact_update") return "artifact";
  if (bare === "agent_delegate") return "delegate";
  if (name === WORKFLOW_TOOL) return "workflow";
  return null;
}

/** The chat a `chat_handoff` call opened. */
export function handoffChatOf(block: ToolUse): string | null {
  return block.isError ? null : (/\((cnv_[A-Za-z0-9_-]+)\)/.exec(block.result ?? "")?.[1] ?? null);
}

/** The run and chat an `agent_delegate` call started, as its result names them. */
export function delegationOf(result: string | undefined): { runId: string; conversationId: string } | null {
  const m = /\(run (run_[A-Za-z0-9_-]+), conversation (cnv_[A-Za-z0-9_-]+)\)/.exec(result ?? "");
  return m ? { runId: m[1]!, conversationId: m[2]! } : null;
}

/** What the other agent answered, without the note Godmode wraps around it for the agent that delegated. */
export function agentAnswerOf(result: string): string {
  const m = /<agent-answer id="([^"]+)">\n?([\s\S]*?)\n?<\/agent-answer id="\1">/.exec(result);
  return m ? m[2]!.trim() : result.trim();
}

const param = (query: string, key: string) => {
  const raw = new RegExp(`(?:^|&)${key}=([^&#]+)`).exec(query)?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const part = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Where a link to a page of Godmode ("/chat/…", "/tasks?task=…", "/inbox") leads on the phone; null when it has no such screen. */
export function appHref(href: string): Href | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const [path = "", query = ""] = href.split("#")[0]!.split("?");
  const [section = "", rawId] = path.split("/").filter(Boolean);
  const id = part(rawId);
  switch (section) {
    case "":
      return "/";
    case "chat":
      return id ? { pathname: "/chat/[id]", params: { id } } : "/chats";
    case "archived":
      return "/archived";
    case "agents":
      return id && id !== "new" ? { pathname: "/agent/[id]", params: { id } } : "/agents";
    case "artifacts":
      return id ? { pathname: "/artifact/[id]", params: { id } } : "/artifacts";
    case "tasks": {
      const task = param(query, "task") ?? id;
      return task ? { pathname: "/task/[id]", params: { id: task } } : "/tasks";
    }
    case "my-tasks": {
      const task = param(query, "task");
      return task ? { pathname: "/human-task/[id]", params: { id: task } } : "/my-tasks";
    }
    case "calls": {
      const call = param(query, "call");
      return call ? { pathname: "/call/[id]", params: { id: call } } : "/calls";
    }
    case "automations":
    case "routines":
      return "/automations";
    case "inbox":
      return "/inbox";
    case "browser":
    case "computer":
    case "vms":
      return "/screens";
    default:
      return null;
  }
}

/** A Markdown block quote of the text, with an empty line after it for the reply. */
export function quoteOf(text: string): string {
  return `${text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n")}\n\n`;
}

/* Tables */

export type Align = "left" | "center" | "right" | null;

/** GFM: the first row is the header, the columns keep their alignment. */
export function tableMarkdown(rows: string[][], align: Align[] = []): string {
  const [head = [], ...body] = rows;
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => (cells[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
  const aligns = Array.from({ length: width }, (_, i) => (align[i] === "center" ? ":---:" : align[i] === "right" ? "---:" : align[i] === "left" ? ":---" : "---"));
  return [line(head), `| ${aligns.join(" | ")} |`, ...body.map(line)].join("\n");
}

/** RFC 4180: cells with a comma, quote or line break are quoted. */
export function tableCsv(rows: string[][]): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

/* Payments (```payment blocks, like the desktop's GiroCode) */

export type Payment = { name: string; iban: string; bic: string; amount: number | null; purpose: string; reference: string };
export type PaymentError = "name" | "iban" | "amount" | "purpose" | "bic";

const PAYMENT_KEYS: Record<string, keyof Payment> = {
  name: "name",
  recipient: "name",
  empfänger: "name",
  empfaenger: "name",
  iban: "iban",
  bic: "bic",
  amount: "amount",
  betrag: "amount",
  purpose: "purpose",
  verwendungszweck: "purpose",
  reference: "reference",
  referenz: "reference",
};

export const normalizeIban = (iban: string) => iban.replace(/\s+/g, "").toUpperCase();
export const formatIban = (iban: string) => normalizeIban(iban).replace(/(.{4})(?=.)/g, "$1 ");

export function validIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s|€|eur/gi, "");
  if (!s) return null;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma > -1 && dot > -1) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma > -1) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

export function parsePayment(source: string): { ok: true; payment: Payment } | { ok: false; error: PaymentError } {
  const p: Payment = { name: "", iban: "", bic: "", amount: null, purpose: "", reference: "" };
  let amountRaw = "";
  for (const line of source.split("\n")) {
    const m = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    const key = m && PAYMENT_KEYS[m[1]!.toLowerCase()];
    if (!m || !key) continue;
    if (key === "amount") amountRaw = m[2]!;
    else p[key] = m[2]!;
  }
  p.iban = normalizeIban(p.iban);
  p.bic = p.bic.replace(/\s+/g, "").toUpperCase();
  if (!p.name || p.name.length > 70) return { ok: false, error: "name" };
  if (!validIban(p.iban)) return { ok: false, error: "iban" };
  if (p.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(p.bic)) return { ok: false, error: "bic" };
  if (amountRaw) {
    const amount = parseAmount(amountRaw);
    if (amount == null || Number.isNaN(amount) || amount < 0.01 || amount > 999999999.99) return { ok: false, error: "amount" };
    p.amount = amount;
  }
  if (p.purpose.length > 140 || p.reference.length > 35) return { ok: false, error: "purpose" };
  return { ok: true, payment: p };
}
