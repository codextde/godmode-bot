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

const MAX_MATCH_CELLS = 4_000_000;

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function matchLines(a: string[], b: string[]): Int32Array {
  const out = new Int32Array(a.length).fill(-1);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) out[head] = head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    out[a.length - 1 - tail] = b.length - 1 - tail;
    tail++;
  }
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (!n || !m || (n + 1) * (m + 1) > MAX_MATCH_CELLS) return out;
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = a[head + i] === b[head + j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      out[head + i] = head + j;
      i++;
      j++;
    } else if (len[(i + 1) * w + j]! >= len[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

function resolveHunk(base: string[], local: string[], remote: string[]): string[] {
  if (sameLines(local, remote) || sameLines(remote, base)) return local;
  if (sameLines(local, base)) return remote;
  const known = new Set([...base, ...local]);
  const added: string[] = [];
  for (const line of remote) {
    if (!line.trim() || known.has(line)) continue;
    known.add(line);
    added.push(line);
  }
  let end = local.length;
  while (end > 0 && !local[end - 1]!.trim()) end--;
  return [...local.slice(0, end), ...added, ...local.slice(end)];
}

export function mergeText(base: string, local: string, remote: string): string {
  const b = base.split("\n");
  const l = local.split("\n");
  const r = remote.split("\n");
  const toLocal = matchLines(b, l);
  const toRemote = matchLines(b, r);
  const out: string[] = [];
  let bi = 0;
  let li = 0;
  let ri = 0;
  for (let k = 0; k <= b.length; k++) {
    const anchor = k === b.length;
    if (!anchor && (!b[k]!.trim() || toLocal[k]! < li || toRemote[k]! < ri)) continue;
    const lEnd = anchor ? l.length : toLocal[k]!;
    const rEnd = anchor ? r.length : toRemote[k]!;
    out.push(...resolveHunk(b.slice(bi, k), l.slice(li, lEnd), r.slice(ri, rEnd)));
    if (anchor) break;
    out.push(b[k]!);
    bi = k + 1;
    li = lEnd + 1;
    ri = rEnd + 1;
  }
  return out.join("\n");
}

/**
 * Pure. `base` = what both sides had at the last sync (null = first time). Per file: changed on one side only → that
 * side; changed on both → merged three ways (mergeText); deleted on one side and untouched on
 * the other → deleted; deleted on one side but changed on the other → kept. Files either side couldn't read are left
 * alone on both (they end up in `merged.skipped`). `owner`: on the first sync, the side whose version of a file both
 * have wins (the primary's real memory over the template or a stand-in's first dream); without it, both are merged.
 */
export function mergeMemory(
  base: MemorySnapshot | null,
  local: MemorySnapshot,
  remote: MemorySnapshot,
  owner?: "local" | "remote",
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
    else if (!base && owner) text = owner === "local" ? mine : theirs;
    else text = mergeText(was ?? "", mine, theirs);
    if (text !== null) files[path] = text;
  }
  const merged: MemorySnapshot = { files, skipped };
  return {
    merged,
    changedLocal: diffSnapshots(local, merged).length > 0,
    changedRemote: diffSnapshots(remote, merged).length > 0,
  };
}
