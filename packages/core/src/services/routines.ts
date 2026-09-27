/**
 * CONTRACT (owner: agents agent). Routines (cron tasks) CRUD. Scheduling lives in scheduler/scheduler.ts.
 */
import type { Routine, Run } from "@godmode/shared";
import type { RoutineInput } from "@godmode/shared";

export function listRoutines(_opts: { agentId?: string } = {}): Routine[] {
  throw new Error("not implemented");
}
export function getRoutine(_id: string): Routine {
  throw new Error("not implemented");
}
export function createRoutine(_input: RoutineInput): Routine {
  throw new Error("not implemented");
}
export function updateRoutine(_id: string, _patch: Partial<RoutineInput>): Routine {
  throw new Error("not implemented");
}
export function deleteRoutine(_id: string): void {
  throw new Error("not implemented");
}
/** Trigger a routine immediately (same path as a cron tick). */
export async function runRoutineNow(_id: string): Promise<Run> {
  throw new Error("not implemented");
}
