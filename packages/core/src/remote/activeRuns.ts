/**
 * Runs that work on runners right now, as this computer last heard of them (owner: remote).
 *
 * The run executor (runner/runner.ts) only knows the runs of this computer. Whether a chat on a runner is busy is
 * something the runner says; the mirror writes it down here. Memory only: it is rebuilt from the runner after every
 * connect. Imports nothing from the rest of the core, so services/conversations.ts can ask it without an import cycle.
 */
import type { ID } from "@godmode/shared";

export interface RemoteRun {
  runId: ID;
  conversationId: ID;
  agentId: ID;
  runnerId: ID;
  /** `paused`: the run stands still on the runner. It is known here, but its chat isn't busy. */
  status: "queued" | "running" | "paused";
  /** What it is doing, as last reported (`run.activity`). */
  label?: string;
}

const runs = new Map<string, RemoteRun>();

/** Add a run, or replace what is known about it. Its last label stays unless a new one is given. */
export function setRemoteRun(run: RemoteRun): void {
  runs.set(run.runId, { ...run, label: run.label ?? runs.get(run.runId)?.label });
}

export function clearRemoteRun(runId: string): void {
  runs.delete(runId);
}

/** Queued-or-running run of a chat on a runner, the running one first — what `activeRunForConversation` is for a local chat. */
export function remoteRunForConversation(conversationId: string): string | null {
  let queued: string | null = null;
  for (const run of runs.values()) {
    if (run.conversationId !== conversationId || run.status === "paused") continue;
    if (run.status === "running") return run.runId;
    queued ??= run.runId;
  }
  return queued;
}

/** Every known run, or those of one runner. */
export function remoteRuns(runnerId?: string): RemoteRun[] {
  const known = [...runs.values()];
  return runnerId === undefined ? known : known.filter((r) => r.runnerId === runnerId);
}

/** Forget a runner's runs (its link dropped, or it is being rebuilt from the runner's answer). */
export function clearRunner(runnerId: string): void {
  for (const run of [...runs.values()]) if (run.runnerId === runnerId) runs.delete(run.runId);
}
