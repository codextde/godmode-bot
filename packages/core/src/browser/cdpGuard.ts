/**
 * Keeps a run in its own browser profile. Its browser tools and `$GODMODE_BROWSER_CDP_URL` reach the profile resolved
 * for the run (chat > agent > project > workspace > global default). A script that finds a Chromium DevTools port
 * itself (`ps | grep remote-debugging-port`, DevToolsActivePort) drives whichever Godmode browser it happens to hit —
 * another profile with other logins. Claude Code's PreToolUse hook asks here before shell commands and file writes.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { config } from "../config";
import { allRunning } from "./state";

export const RUN_CDP_ENV = "GODMODE_BROWSER_CDP_URL";

/** A process lookup (ps, pgrep, lsof) or a file read (cat, head, tail) at command position, also inside a script's strings. */
const AT_COMMAND = String.raw`(?:^|[|;&(\x60'"]|\$\()\s*(?:sudo\s+)?`;
const PORT_LOOKUP = new RegExp(`${AT_COMMAND}(?:ps|pgrep|lsof)\\b[^\\n]*remote-debugging`, "im");
const PORT_FILE = new RegExp(`${AT_COMMAND}(?:cat|head|tail|less)\\b[^\\n]*DevToolsActivePort|readFile\\w*\\([^)]*DevToolsActivePort`, "im");
const LOOPBACK_PORT = /(?:\b127\.0\.0\.1|\blocalhost|\b0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;
const INTERPRETER = /(?:^|[\s;&|(])(?:node|bun|deno|python3?|tsx|ts-node|sh|bash|zsh)\s+(?:(?:-\S+|run)\s+)*((?:~|\.{0,2}\/)?[\w@./~-]+\.(?:m?js|cjs|ts|mts|py|sh))(?=$|[\s'";|&)])/g;
const DIRECT = /(?:^|[\s;&|(])(\.{1,2}\/[\w@./-]+\.(?:m?js|cjs|ts|mts|py|sh))(?=$|[\s'";|&)])/g;
const CD = /(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const MAX_SCRIPT_BYTES = 512 * 1024;

/** Why the text reaches for a browser outside the run's own endpoint, or null when it doesn't. */
export function foreignBrowserUse(text: string): string | null {
  if (!text) return null;
  if (PORT_LOOKUP.test(text) || PORT_FILE.test(text)) return "it looks for Chromium DevTools ports";
  const ports = new Set(allRunning().map((rb) => rb.port));
  for (const m of text.matchAll(LOOPBACK_PORT)) {
    if (ports.has(Number(m[1]))) return `127.0.0.1:${m[1]} is the raw DevTools port of a Godmode browser`;
  }
  const dir = config().browserDir;
  if (text.includes(dir + sep) || new RegExp(`${escape(dir)}(?=$|[\\s'"\x60;|&)])`, "m").test(text)) return "it reaches into Godmode's browser profile folders";
  return null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scripts a command runs (with an interpreter, or directly as ./script), read so one that finds a DevTools port itself is caught too. */
export function scriptsOf(command: string, cwd: string | undefined): string[] {
  const home = (p: string) => (p === "~" || p.startsWith("~/") ? resolve(process.env.HOME ?? "", p.slice(2)) : p);
  // Relative scripts may sit in the folder the command changes to first (cd dir && node script.mjs).
  const bases = [cwd, ...[...command.matchAll(CD)].map((m) => home(m[1]!.replace(/^["']|["']$/g, "")))]
    .filter((b): b is string => !!b)
    .map((b) => (isAbsolute(b) ? b : cwd ? resolve(cwd, b) : null))
    .filter((b): b is string => !!b);
  const out = new Set<string>();
  for (const m of [...command.matchAll(INTERPRETER), ...command.matchAll(DIRECT)]) {
    const script = home(m[1]!);
    for (const path of isAbsolute(script) ? [script] : bases.map((b) => resolve(b, script))) {
      try {
        const st = statSync(path);
        if (st.isFile() && st.size <= MAX_SCRIPT_BYTES) out.add(readFileSync(path, "utf8"));
      } catch {
        /* not a file */
      }
    }
  }
  return [...out];
}

/** Why a tool call reaches for a browser outside the run's own endpoint, or null when it doesn't. */
export function foreignBrowserCall(toolName: string, input: Record<string, unknown>, cwd?: string): string | null {
  const guarded = guardedText(toolName, input);
  if (!guarded) return null;
  const why = foreignBrowserUse(guarded.text);
  if (why || guarded.kind !== "command") return why;
  // A bare port in a command (CDP_PORT=61275 node run.mjs) counts too.
  const ports = new Set(allRunning().map((rb) => rb.port));
  for (const m of guarded.text.matchAll(/\b(\d{4,5})\b/g)) {
    if (ports.has(Number(m[1]))) return `${m[1]} is the raw DevTools port of a Godmode browser`;
  }
  for (const script of scriptsOf(guarded.text, cwd)) {
    const inScript = foreignBrowserUse(script);
    if (inScript) return `the script it runs: ${inScript}`;
  }
  return null;
}

/** The text of a tool call the guard looks at (null for tools it leaves alone). */
export function guardedText(toolName: string, input: Record<string, unknown>): { text: string; kind: "command" | "file" } | null {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (toolName) {
    case "Bash":
      return { text: str(input.command), kind: "command" };
    case "Write":
      return { text: str(input.content), kind: "file" };
    case "Edit":
      return { text: str(input.new_string), kind: "file" };
    case "MultiEdit":
      return { text: (Array.isArray(input.edits) ? input.edits : []).map((e) => str((e as Record<string, unknown>)?.new_string)).join("\n"), kind: "file" };
    default:
      return null;
  }
}

export function denyReason(why: string, hasBrowser: boolean): string {
  const use = hasBrowser
    ? `Use the browser MCP tools, or for a script connect to $${RUN_CDP_ENV} (e.g. Playwright \`chromium.connectOverCDP(process.env.${RUN_CDP_ENV})\`): that is this run's browser profile with the right logins.`
    : "This run has no browser on this computer; say so in your summary instead.";
  return `Blocked: ${why}. Other DevTools ports belong to other browser profiles with other logins. ${use}`;
}
