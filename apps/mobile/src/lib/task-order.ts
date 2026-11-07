import type { Task } from "@godmode/shared";
import { Alert } from "react-native";
import type { IconName } from "@/components/icon";
import { api, errorText } from "./api";
import { t } from "./i18n";
import { qk, queryClient } from "./query";

export type TaskMove = "top" | "up" | "down";

export const MOVE_ICON = { top: "toTop", up: "up", down: "down" } as const satisfies Record<TaskMove, IconName>;

type Placed = Pick<Task, "id" | "status" | "workspaceId" | "position" | "number">;

/** A ticket's column as the board shows it, top first: same status and workspace (the computer orders each workspace on its own). */
export function columnOf<T extends Placed>(list: readonly T[], task: Pick<Task, "status" | "workspaceId">): T[] {
  return list
    .filter((x) => x.status === task.status && (x.workspaceId ?? null) === (task.workspaceId ?? null))
    .sort((a, b) => a.position - b.position || b.number - a.number);
}

/** The ticket a move puts it before (null: the end of the column); undefined when it can't move that way. */
export function moveBefore(column: readonly Pick<Task, "id">[], id: string, move: TaskMove): string | null | undefined {
  const i = column.findIndex((x) => x.id === id);
  if (i < 0) return undefined;
  if (move === "down") return i < column.length - 1 ? (column[i + 2]?.id ?? null) : undefined;
  if (i === 0 || (move === "top" && i === 1)) return undefined;
  return move === "top" ? column[0]!.id : column[i - 1]!.id;
}

/** The moves a ticket has in its column; "top" only where it differs from "up". */
export function taskMoves(column: readonly Pick<Task, "id">[], id: string): TaskMove[] {
  return (["top", "up", "down"] as const).filter((m) => moveBefore(column, id, m) !== undefined);
}

/** Where it lands until the computer answers (the core's rule, like the desktop's board). */
export function positionBefore(column: readonly Placed[], id: string, beforeId: string | null): number {
  const rest = column.filter((x) => x.id !== id);
  const idx = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
  if (idx < 0) return (rest.at(-1)?.position ?? 0) + 1024;
  const next = rest[idx]!.position;
  const prev = idx > 0 ? rest[idx - 1]!.position : next - 2048;
  return (prev + next) / 2;
}

/** Every cached board list a ticket is on, for the column it sits in. */
function cachedBoard(task: Task): Task[] | undefined {
  for (const [, list] of queryClient.getQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"] })) {
    if (Array.isArray(list) && list.some((x) => x.id === task.id)) return list;
  }
  return undefined;
}

/**
 * Moves a ticket within its column, like the desktop's drag: the board shows it at once, the computer has the last word.
 * `shown`: the column as the list shows it (narrowed to a project or filters), so a move passes the ticket that is seen.
 */
export async function moveTask(task: Task, move: TaskMove, shown?: readonly Task[]): Promise<void> {
  try {
    const column = shown ? columnOf(shown, task) : columnOf(cachedBoard(task) ?? (await api.tasks.list({ workspaceId: task.workspaceId })), task);
    const beforeId = moveBefore(column, task.id, move);
    if (beforeId === undefined) return;
    const position = positionBefore(column, task.id, beforeId);
    void queryClient.cancelQueries({ queryKey: [...qk.tasks, "list"] });
    queryClient.setQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"] }, (old) => (Array.isArray(old) ? old.map((x) => (x.id === task.id ? { ...x, position } : x)) : old));
    const next = await api.tasks.update(task.id, { beforeId });
    queryClient.setQueryData(qk.task(task.id), (old: Task | undefined) => (old ? { ...old, position: next.position } : old));
  } catch (err) {
    Alert.alert(t("tasks:order.failed"), errorText(err));
  } finally {
    void queryClient.invalidateQueries({ queryKey: [...qk.tasks, "list"] });
  }
}
