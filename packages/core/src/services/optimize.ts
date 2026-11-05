/**
 * Optimize (Settings → Cleanup): how lean Godmode is for its agents, and one click to make it so. Models work best well
 * below their 1M window, so chats are summarized at the context budget; MEMORY.md is loaded into every task and dreams
 * keep it short; notes no task opens any more are merged or dropped by dreams; the cleanup frees the disk. All of it
 * runs by itself as well — this report shows where things stand.
 */
import type { DreamAllResult, OptimizeAgentMemory, OptimizeReport, OptimizeRun } from "@godmode/shared";
import { DEFAULT_CONTEXT_BUDGET, memoryBudget } from "@godmode/shared";
import { listAgents } from "../agents/service";
import { all, get } from "../db";
import { logger } from "../log";
import { dreamAll, isDreaming, nextDreamAt } from "../memory/dreaming";
import { memoryChars } from "../memory/files";
import { noteUses, usesCountedSince } from "../memory/usage";
import { now } from "../util";
import { RECOMMENDED } from "./cleanup";
import { cleanUp } from "./maintenance";
import { getSettings } from "./settings";

const log = logger("optimize");

const WEEK = 7 * 86_400_000;
const LARGEST = 5;

export function optimizeReport(at = new Date()): OptimizeReport {
  const settings = getSettings();
  const budget = settings.runner.contextBudget;
  const chats = all<{ id: string; agent_id: string; name: string; title: string; tokens: number }>(
    `SELECT c.id, c.agent_id, a.name, c.title, c.context_tokens AS tokens FROM conversations c JOIN agents a ON a.id = c.agent_id
     WHERE c.last_message_at > ? AND c.origin != 'dream' AND c.private = 0 AND c.context_tokens IS NOT NULL ORDER BY c.context_tokens DESC`,
    new Date(at.getTime() - WEEK).toISOString(),
  );
  const limit = budget ?? DEFAULT_CONTEXT_BUDGET;

  const agents: OptimizeAgentMemory[] = listAgents({ workspaceId: "all" })
    .filter((a) => a.enabled)
    .map((a) => {
      const notes = noteUses(a.id, a.repoPath, at);
      const unused = notes.filter((n) => n.unused);
      return {
        agentId: a.id,
        name: a.name,
        chars: memoryChars(a.repoPath),
        notes: notes.length,
        notesBytes: notes.reduce((n, x) => n + x.bytes, 0),
        unused: unused.length,
        unusedBytes: unused.reduce((n, x) => n + x.bytes, 0),
        dreaming: isDreaming(a.id),
      };
    });
  const { target } = memoryBudget(settings.memory.dreaming.maxMemoryChars);
  const weight = (m: OptimizeAgentMemory) => Math.max(0, m.chars - target) * 4 + m.unusedBytes;
  agents.sort((a, b) => weight(b) - weight(a) || b.notesBytes - a.notesBytes || a.name.localeCompare(b.name));

  return {
    checkedAt: now(),
    context: {
      budget,
      share: budget ? null : settings.runner.autoCompactPercent,
      active: chats.length,
      over: chats.filter((c) => c.tokens > limit).length,
      largest: chats.slice(0, LARGEST).map((c) => ({ conversationId: c.id, agentId: c.agent_id, agentName: c.name, title: c.title, tokens: c.tokens })),
    },
    memory: {
      target,
      agents,
      countingSince: usesCountedSince(),
      dreaming: settings.memory.dreaming.enabled,
      nextDreamAt: settings.memory.dreaming.enabled ? nextDreamAt(settings) : null,
      lastDreamAt: get<{ t: string | null }>("SELECT MAX(finished_at) AS t FROM dreams WHERE status = 'succeeded'")?.t ?? null,
    },
    automatic: { cleanup: settings.maintenance.autoCleanup, dreaming: settings.memory.dreaming.enabled, budget: budget !== null },
  };
}

/**
 * Everything at once: the recommended cleanup first (compacting the database waits while agents work, and dreams make
 * them work), then a dream for every agent with new activity or memory to tidy.
 */
export async function optimizeNow(): Promise<OptimizeRun> {
  const cleanup = await cleanUp(RECOMMENDED);
  let dreams: DreamAllResult = { started: [], skipped: [] };
  if (getSettings().memory.dreaming.enabled) {
    try {
      dreams = await dreamAll();
    } catch (err) {
      log.warn("optimize: could not start the dreams", err);
    }
  }
  return { cleanup, dreams };
}
