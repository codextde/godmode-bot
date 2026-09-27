import type { LucideIcon } from "lucide-react";
import { BookOpenText, Drama, FolderOpen, Globe, Radio, SquareTerminal, Code, Download } from "lucide-react";
import type { McpTransport } from "@godmode/shared";

/** Shell-like split: whitespace/newlines separate args, quotes group, backslash escapes. */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function formatArgs(args: string[]): string {
  return args.map((a) => (a === "" || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
}

export const TRANSPORTS: { id: McpTransport; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "stdio", label: "Local command", hint: "Runs a program on this machine (npx, uvx, docker…)", icon: SquareTerminal },
  { id: "http", label: "HTTP", hint: "Streamable HTTP endpoint", icon: Globe },
  { id: "sse", label: "SSE", hint: "Legacy server-sent events endpoint", icon: Radio },
];

export function transportMeta(t: McpTransport) {
  return TRANSPORTS.find((x) => x.id === t) ?? TRANSPORTS[0];
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  /** Shown in the dialog after applying the preset. */
  note?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    name: "filesystem",
    description: "Read and write files in folders you allow",
    icon: FolderOpen,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/folder"],
    note: "Replace the last argument with the absolute folder path(s) agents may access.",
  },
  {
    id: "github",
    name: "github",
    description: "GitHub's official remote MCP server",
    icon: Code,
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headerKeys: ["Authorization"],
    note: "Set the Authorization header to “Bearer <personal access token>”.",
  },
  {
    id: "playwright",
    name: "playwright",
    description: "Microsoft Playwright browser automation",
    icon: Drama,
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest"],
  },
  {
    id: "fetch",
    name: "fetch",
    description: "Fetch web pages and convert them to markdown",
    icon: Download,
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
  },
  {
    id: "context7",
    name: "context7",
    description: "Up-to-date library docs for coding agents",
    icon: BookOpenText,
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
];
