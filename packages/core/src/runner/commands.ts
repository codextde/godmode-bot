/**
 * Slash command catalog of the installed Claude Code CLI, exactly as an agent's runs see it (agent repo as cwd,
 * same setting sources and plugins). Asked over the stream-json control protocol (`initialize`), which answers
 * without a model call; cached per agent.
 */
import type { Agent, SlashCommand } from "@godmode/shared";
import { ensureAgentRepo } from "../agents/service";
import { claudeMemPluginDir } from "../memory/claudeMem";
import { getSettings } from "../services/settings";
import { HttpError } from "../util";
import { killTree, resolveClaudeCommand } from "./claude";
import { CLAUDE_NOT_FOUND, buildEnv } from "./runner";

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
const REQUEST_ID = "godmode-commands";
/** Terminal-UI-only or internal commands that do nothing useful in a Godmode chat. */
const HIDDEN = new Set(["color", "focus", "reload-plugins", "heapdump", "workflow-launch-exec"]);

const cache = new Map<string, { at: number; commands: Promise<SlashCommand[]> }>();

export function listSlashCommands(agent: Agent): Promise<SlashCommand[]> {
  const hit = cache.get(agent.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.commands;
  const commands = probe(agent);
  cache.set(agent.id, { at: Date.now(), commands });
  commands.catch(() => {
    if (cache.get(agent.id)?.commands === commands) cache.delete(agent.id);
  });
  return commands;
}

export function __clearSlashCommandCache() {
  cache.clear();
}

async function probe(agent: Agent): Promise<SlashCommand[]> {
  const cmd = resolveClaudeCommand();
  if (!cmd) throw new HttpError(503, CLAUDE_NOT_FOUND, "claude_not_found");
  await ensureAgentRepo(agent);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  args.push("--setting-sources", "project,local", "--strict-mcp-config", "--no-session-persistence");
  const pluginDir = getSettings().memory.backend === "claude-mem" ? claudeMemPluginDir() : null;
  if (pluginDir) args.push("--plugin-dir", pluginDir);

  const proc = Bun.spawn({
    cmd: [...cmd, ...args],
    cwd: agent.repoPath,
    env: buildEnv(agent),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: process.platform !== "win32",
  });
  const reader = proc.stdout.getReader();
  const timer = setTimeout(() => {
    killTree(proc);
    void reader.cancel().catch(() => {});
  }, TIMEOUT_MS);
  try {
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "initialize" } })}\n`);
    await proc.stdin.end();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = done ? "" : lines.pop()!;
      for (const line of lines) {
        const commands = commandsFrom(line);
        if (commands) return commands;
      }
      if (done) break;
    }
  } finally {
    clearTimeout(timer);
    killTree(proc);
  }
  throw new HttpError(502, "Claude Code did not list its slash commands", "claude_commands_unavailable");
}

function commandsFrom(line: string): SlashCommand[] | null {
  let event: { type?: string; response?: { subtype?: string; request_id?: string; error?: string; response?: { commands?: unknown } } };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event?.type !== "control_response" || event.response?.request_id !== REQUEST_ID) return null;
  if (event.response.subtype !== "success") {
    throw new HttpError(502, `Claude Code could not list its slash commands: ${event.response.error ?? "unknown error"}`, "claude_commands_unavailable");
  }
  const raw = event.response.response?.commands;
  if (!Array.isArray(raw)) return [];
  // Names can repeat (a project command shadowing a built-in); Claude Code runs the built-in one.
  const out = new Map<string, SlashCommand>();
  for (const c of raw as Record<string, unknown>[]) {
    const name = typeof c?.name === "string" ? c.name : "";
    if (!name || name.startsWith("_") || HIDDEN.has(name)) continue;
    const builtin = c.builtin === true;
    if (out.get(name)?.builtin) continue;
    const description = typeof c.description === "string" ? c.description : "";
    out.set(name, {
      name,
      description: builtin ? description : description.replace(/\s*\((?:project|user)\)$/, ""),
      argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
      aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string") : [],
      builtin,
    });
  }
  return [...out.values()];
}
