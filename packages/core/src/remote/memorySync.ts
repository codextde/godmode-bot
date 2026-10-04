/**
 * Agent memory between a controller and its runner.
 *
 * The same agent works on both computers and writes its MEMORY.md and notes on each. After a run the two states are
 * merged three ways against what both had at the last sync, and the result is written on both sides. Whatever happens,
 * a line one side wrote is never dropped: a wrong merge would silently make an agent forget.
 */
import { commitAgentRepo, getAgent } from "../agents/service";
import { diffSnapshots, restoreFiles, snapshotMemory, type MemorySnapshot } from "../memory/files";
import { badRequest } from "../util";
import { sha256 } from "../vault/crypto";

export interface MemoryState {
  digest: string;
  snapshot: MemorySnapshot;
}

/** Fingerprint of the files that were read (paths in a fixed order, so both computers get the same value). */
function digestOf(snapshot: MemorySnapshot): string {
  const paths = Object.keys(snapshot.files).sort();
  return sha256(JSON.stringify(paths.map((path) => [path, snapshot.files[path]])));
}

export function readMemoryState(agentId: string): MemoryState {
  const snapshot = snapshotMemory(getAgent(agentId).repoPath);
  return { digest: digestOf(snapshot), snapshot };
}

/** The snapshot arrives over the link: a file without text would look like a deleted file, so refuse it instead. */
function checked(snapshot: MemorySnapshot): MemorySnapshot {
  const files = snapshot && typeof snapshot === "object" ? snapshot.files : null;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.values(files).some((text) => typeof text !== "string")) {
    throw badRequest("The memory to write can't be read");
  }
  const skipped = Array.isArray(snapshot.skipped) ? snapshot.skipped.filter((path) => typeof path === "string") : [];
  return { files, skipped };
}

/**
 * Make the agent's memory files equal to `snapshot` and commit. Files either side couldn't read stay as they are, and
 * only memory files are written or removed (anything else in the snapshot is ignored).
 */
export async function writeMemoryState(agentId: string, snapshot: MemorySnapshot, message: string): Promise<MemoryState> {
  const agent = getAgent(agentId);
  // "Before" is the state to reach: restoreFiles puts every differing file back to it.
  restoreFiles(agent.repoPath, diffSnapshots(checked(snapshot), snapshotMemory(agent.repoPath)));
  await commitAgentRepo(agent.id, message);
  return readMemoryState(agent.id);
}

/** Local's lines in their order, then the lines only the other side has. */
function mergeLines(local: string, remote: string): string {
  const have = new Set(local.split("\n"));
  const extra: string[] = [];
  for (const line of remote.split("\n")) {
    if (!line.trim() || have.has(line)) continue;
    have.add(line);
    extra.push(line);
  }
  if (!extra.length) return local;
  const head = local.replace(/\n+$/, "");
  return `${head ? `${head}\n` : ""}${extra.join("\n")}\n`;
}

/**
 * Pure. `base` = what both sides had at the last sync (null = first time). Per file: changed on one side only → that
 * side; changed on both → local's lines plus the remote lines local doesn't have; deleted on one side and untouched on
 * the other → deleted; deleted on one side but changed on the other → kept. Files either side couldn't read are left
 * alone on both (they end up in `merged.skipped`).
 */
export function mergeMemory(
  base: MemorySnapshot | null,
  local: MemorySnapshot,
  remote: MemorySnapshot,
): { merged: MemorySnapshot; changedLocal: boolean; changedRemote: boolean } {
  const skipped = [...new Set([...local.skipped, ...remote.skipped])].sort();
  const unknown = (path: string) => skipped.some((p) => path === p || path.startsWith(`${p}/`));
  const files: Record<string, string> = {};
  for (const path of [...new Set([...Object.keys(local.files), ...Object.keys(remote.files)])].sort()) {
    if (unknown(path)) continue;
    const was = base?.files[path] ?? null;
    const mine = local.files[path] ?? null;
    const theirs = remote.files[path] ?? null;
    let text: string | null;
    if (mine === theirs || theirs === was) text = mine;
    else if (mine === was) text = theirs;
    else if (mine === null) text = theirs;
    else if (theirs === null) text = mine;
    else text = mergeLines(mine, theirs);
    if (text !== null) files[path] = text;
  }
  const merged: MemorySnapshot = { files, skipped };
  return {
    merged,
    changedLocal: diffSnapshots(local, merged).length > 0,
    changedRemote: diffSnapshots(remote, merged).length > 0,
  };
}
