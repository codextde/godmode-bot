/**
 * CONTRACT (owner: agents agent). Runs Claude Code CLI for an agent turn and streams results.
 */
import type { Run, RunTrigger } from "@godmode/shared";

export interface StartRunInput {
  agentId: string;
  conversationId: string;
  prompt: string;
  trigger: RunTrigger;
  routineId?: string | null;
  parentRunId?: string | null;
  depth?: number;
  voice?: boolean;
}

export async function startRun(_input: StartRunInput): Promise<Run> {
  throw new Error("not implemented");
}
export async function cancelRun(_runId: string): Promise<void> {
  throw new Error("not implemented");
}
/** Resolve when the run reaches a terminal state (or timeout). */
export async function waitForRun(_runId: string, _timeoutMs?: number): Promise<Run> {
  throw new Error("not implemented");
}
/** Mark runs left in queued/running state by a previous process as failed. */
export function recoverInterruptedRuns(): void {}
export async function shutdownRunner(): Promise<void> {}
