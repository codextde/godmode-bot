/**
 * Optional memory backend: thedotmack/claude-mem (https://github.com/thedotmack/claude-mem).
 *
 * Godmode keeps its own pinned copy of the plugin in `<dataDir>/plugins/claude-mem/<version>/` (downloaded from the
 * npm registry, integrity-checked) and loads it per run with `claude --plugin-dir`. Every agent gets an isolated
 * store (`<agent repo>/.claude-mem`, git-ignored) and its own worker port, so memories never bleed between agents.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { config } from "../config";
import { logger } from "../log";
import { which } from "../util";

const log = logger("claude-mem");

export const CLAUDE_MEM_VERSION = "13.28.0";
const REGISTRY = "https://registry.npmjs.org/claude-mem";

function installRoot(): string {
  return join(config().dataDir, "plugins", "claude-mem", CLAUDE_MEM_VERSION);
}

/** Directory to pass to `claude --plugin-dir`, or null when the plugin is not installed. */
export function claudeMemPluginDir(): string | null {
  const dir = join(installRoot(), "plugin");
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}

/** Deterministic worker port per agent (claude-mem's default port is shared per OS user). */
export function claudeMemPort(agentId: string): number {
  const h = createHash("sha256").update(agentId).digest();
  return 38_100 + (h.readUInt16BE(0) % 800);
}

export function claudeMemEnv(agent: Agent): Record<string, string> {
  return {
    CLAUDE_MEM_DATA_DIR: join(agent.repoPath, ".claude-mem"),
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_WORKER_PORT: String(claudeMemPort(agent.id)),
    // Keep it light: SQLite + FTS only, no Python/Chroma vector store.
    CLAUDE_MEM_CHROMA_ENABLED: "false",
  };
}

export interface ClaudeMemStatus {
  installed: boolean;
  version: string;
  path: string | null;
  nodeAvailable: boolean;
}

export function claudeMemStatus(): ClaudeMemStatus {
  const path = claudeMemPluginDir();
  return { installed: !!path, version: CLAUDE_MEM_VERSION, path, nodeAvailable: !!which("node") };
}

/** Download the pinned plugin from the npm registry (sha512-verified) and unpack it into the data dir. */
export async function installClaudeMem(): Promise<{ ok: boolean; output: string }> {
  if (!which("node")) {
    return { ok: false, output: "claude-mem's hooks need Node.js 20+. Install Node.js from https://nodejs.org and try again." };
  }
  const tar = which("tar");
  if (!tar) return { ok: false, output: "The `tar` command is required to unpack claude-mem." };
  const lines: string[] = [];
  const work = mkdtempSync(join(tmpdir(), "godmode-claude-mem-"));
  try {
    const metaRes = await fetch(`${REGISTRY}/${CLAUDE_MEM_VERSION}`);
    if (!metaRes.ok) throw new Error(`npm registry returned ${metaRes.status}`);
    const meta = (await metaRes.json()) as { dist?: { tarball?: string; integrity?: string } };
    const tarball = meta.dist?.tarball;
    const integrity = meta.dist?.integrity;
    if (!tarball || !integrity?.startsWith("sha512-")) throw new Error("npm registry metadata has no tarball integrity");
    lines.push(`Downloading claude-mem ${CLAUDE_MEM_VERSION}…`);
    const res = await fetch(tarball);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (digest !== integrity) throw new Error("integrity check failed — refusing to install");
    lines.push("Integrity verified (sha512).");
    const file = join(work, "claude-mem.tgz");
    writeFileSync(file, bytes);
    const proc = Bun.spawnSync([tar, "-xzf", file, "-C", work], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`tar failed: ${proc.stderr.toString().trim()}`);
    const plugin = join(work, "package", "plugin");
    if (!existsSync(join(plugin, ".claude-plugin", "plugin.json"))) throw new Error("package has no Claude Code plugin");
    const root = installRoot();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    renameSync(plugin, join(root, "plugin"));
    lines.push(`Installed to ${root}`);
    log.info(`installed claude-mem ${CLAUDE_MEM_VERSION}`);
    return { ok: true, output: lines.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`claude-mem install failed: ${msg}`);
    return { ok: false, output: [...lines, `Failed: ${msg}`].join("\n") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Stop the claude-mem workers of agents that have a store (called on shutdown; workers outlive single runs). */
export async function stopClaudeMemWorkers(agents: Agent[]): Promise<void> {
  const dir = claudeMemPluginDir();
  const node = which("node");
  if (!dir || !node) return;
  await Promise.all(
    agents
      .filter((a) => existsSync(join(a.repoPath, ".claude-mem")))
      .map(async (agent) => {
        try {
          const proc = Bun.spawn([node, join(dir, "scripts", "bun-runner.js"), join(dir, "scripts", "worker-service.cjs"), "stop"], {
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...claudeMemEnv(agent) },
            stdout: "ignore",
            stderr: "ignore",
          });
          const timer = setTimeout(() => proc.kill(), 10_000);
          await proc.exited;
          clearTimeout(timer);
        } catch (err) {
          log.warn(`could not stop claude-mem worker for ${agent.slug}`, err);
        }
      }),
  );
}
