/** Adds Godmode to Claude Code on this computer as an MCP server for every project (`claude mcp`, user scope), and takes it out again. */
import { GODMODE_MCP_NAME, type ConnectorSetup } from "@godmode/shared";
import { logger } from "../log";
import { resolveClaudeCommand } from "../runner/claude";
import { childEnv } from "../util";

const log = logger("connect");
const TIMEOUT_MS = 30_000;

export function claudeCodeInstalled(): boolean {
  return resolveClaudeCommand() !== null;
}

async function claudeMcp(args: string[]): Promise<{ ok: boolean; output: string }> {
  const cmd = resolveClaudeCommand();
  if (!cmd) return { ok: false, output: "Claude Code isn't installed on this computer." };
  try {
    const proc = Bun.spawn([...cmd, "mcp", ...args], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0, output: err.trim() || out.trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/** The entry is Godmode's own: one that is already there (an earlier key) is replaced. */
export async function addToClaudeCode(setup: ConnectorSetup): Promise<{ ok: boolean; detail: string }> {
  await claudeMcp(["remove", "--scope", "user", GODMODE_MCP_NAME]);
  const server = JSON.stringify({ type: "stdio", command: setup.command, args: setup.args, env: setup.env });
  const res = await claudeMcp(["add-json", "--scope", "user", GODMODE_MCP_NAME, server]);
  const detail = res.output.split(setup.token).join("…").slice(0, 2000);
  if (!res.ok) log.warn("could not add Godmode to Claude Code", { detail });
  return { ok: res.ok, detail: res.ok ? "" : detail || "Claude Code refused the new server." };
}

export async function removeFromClaudeCode(): Promise<void> {
  const res = await claudeMcp(["remove", "--scope", "user", GODMODE_MCP_NAME]);
  if (!res.ok) log.info("Godmode was not in Claude Code anymore", { detail: res.output.slice(0, 500) });
}
