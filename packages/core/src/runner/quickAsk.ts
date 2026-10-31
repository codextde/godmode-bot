import { join } from "node:path";
import { config, ensureDir } from "../config";
import { logger } from "../log";
import { claudeEnv, killTree, resolveClaudeCommand } from "./claude";

const log = logger("quick-ask");

export async function quickAsk(prompt: string, opts: { model: string; timeoutMs: number; what: string }): Promise<string | null> {
  const cmd = resolveClaudeCommand();
  if (!cmd) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn({
      cmd: [...cmd, "-p", "--model", opts.model, "--output-format", "json", "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--no-session-persistence", "--disable-slash-commands"],
      cwd: ensureDir(join(config().dataDir, "claude-probe")),
      env: claudeEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      detached: process.platform !== "win32",
    });
    timer = setTimeout(() => killTree(proc, true), opts.timeoutMs);
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return resultOf(out);
  } catch (err) {
    log.warn(`could not ${opts.what}`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type ResultEvent = { type?: unknown; result?: unknown; is_error?: unknown };

export function resultOf(out: string): string | null {
  const events: ResultEvent[] = [];
  for (const line of out.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line) as ResultEvent | ResultEvent[];
      events.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      continue;
    }
  }
  const result = events.reverse().find((e) => e?.type === "result");
  return result && typeof result.result === "string" && result.is_error !== true ? result.result : null;
}
