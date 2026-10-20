/**
 * The memory editor: MEMORY.md read and saved on its own (also from paired phones, which never reach other repository
 * files). A save names the version it started from, so a rewrite underneath by a run or a dream is never lost silently.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { memoryBudget, type AgentMemory } from "@godmode/shared";
import { withRepo, writeAgentFile } from "../agents/service";
import { getSettings } from "../services/settings";
import { conflict, HttpError } from "../util";
import { isDreaming } from "./dreaming";
import { MEMORY_DIR, MEMORY_FILE, readMemory } from "./files";

const MAX_TOPICS = 300;
/** Saves per agent, one after the other: two editors saving the same version can't both pass the digest check. */
const saving = new Map<string, Promise<unknown>>();
export const MAX_MEMORY_EDIT_BYTES = 256 * 1024;

export function memoryDigestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Markdown notes under memory/, sorted; hidden entries and symlinks are skipped. */
export function memoryTopics(repoPath: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_TOPICS) return;
    let names: string[];
    try {
      names = readdirSync(join(repoPath, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || out.length >= MAX_TOPICS) continue;
      const child = `${rel}/${name}`;
      let info;
      try {
        info = lstatSync(join(repoPath, child));
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(child, depth + 1);
      else if (info.isFile() && /\.(md|markdown|txt)$/i.test(name)) out.push(child);
    }
  };
  walk(MEMORY_DIR, 0);
  return out;
}

export async function readAgentMemory(agentId: string): Promise<AgentMemory> {
  const agent = await withRepo(agentId);
  let info;
  try {
    info = lstatSync(join(agent.repoPath, MEMORY_FILE));
  } catch {
    info = null;
  }
  const text = readMemory(agent.repoPath);
  if (info && text === null) {
    throw new HttpError(413, `${MEMORY_FILE} is too large or not a text file — open it in the agent's repository instead.`, "too_large");
  }
  const content = text ?? "";
  return {
    content,
    exists: !!info,
    digest: memoryDigestOf(content),
    chars: content.length,
    ...memoryBudget(getSettings().memory.dreaming.maxMemoryChars),
    dreaming: isDreaming(agent.id),
    topics: memoryTopics(agent.repoPath),
    updatedAt: info ? info.mtime.toISOString() : null,
  };
}

/** Save MEMORY.md (committed as "Edit MEMORY.md"). `digest`: the version the edit started from; omit it to overwrite. */
export function writeAgentMemory(agentId: string, content: string, digest?: string): Promise<AgentMemory> {
  const next = (saving.get(agentId) ?? Promise.resolve()).catch(() => {}).then(() => saveMemory(agentId, content, digest));
  saving.set(agentId, next);
  void next.finally(() => saving.get(agentId) === next && saving.delete(agentId)).catch(() => {});
  return next;
}

async function saveMemory(agentId: string, content: string, digest?: string): Promise<AgentMemory> {
  const current = await readAgentMemory(agentId);
  if (current.dreaming) {
    throw conflict("A dream is consolidating this memory right now — save when it has ended, or cancel the dream.");
  }
  if (digest !== undefined && digest !== current.digest) {
    throw new HttpError(409, `${MEMORY_FILE} changed since you opened it.`, "memory_changed", current);
  }
  if (content !== current.content || !current.exists) await writeAgentFile(agentId, MEMORY_FILE, content);
  return readAgentMemory(agentId);
}
