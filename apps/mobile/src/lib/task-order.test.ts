import { describe, expect, test } from "bun:test";
import type { Task } from "@godmode/shared";
import "./test-natives.test";

const { columnOf, moveBefore, positionBefore, taskMoves } = await import("./task-order");

const ticket = (id: string, position: number, extra: Partial<Task> = {}) => ({ id, status: "todo", workspaceId: "ws_1", number: 1, position, ...extra }) as Task;

const a = ticket("a", 1024);
const b = ticket("b", 2048);
const c = ticket("c", 3072);
const d = ticket("d", 4096);
const column = [a, b, c, d];

describe("ordering tickets within a column", () => {
  test("a column is one status of one workspace, top first", () => {
    const other = ticket("x", 1500, { workspaceId: "ws_2" });
    const done = ticket("y", 10, { status: "done" });
    expect(columnOf([d, other, b, done, a, c], b).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("up goes before the ticket above, down before the one two below, top before the first", () => {
    expect(moveBefore(column, "c", "up")).toBe("b");
    expect(moveBefore(column, "b", "down")).toBe("d");
    expect(moveBefore(column, "c", "down")).toBeNull();
    expect(moveBefore(column, "d", "top")).toBe("a");
  });

  test("no move past the ends, and top only where it differs from up", () => {
    expect(taskMoves(column, "a")).toEqual(["down"]);
    expect(taskMoves(column, "b")).toEqual(["up", "down"]);
    expect(taskMoves(column, "c")).toEqual(["top", "up", "down"]);
    expect(taskMoves(column, "d")).toEqual(["top", "up"]);
    expect(taskMoves(column, "missing")).toEqual([]);
  });

  test("the board shows it in its new place before the computer answers", () => {
    expect(positionBefore(column, "c", "b")).toBe(1536);
    expect(positionBefore(column, "a", null)).toBe(4096 + 1024);
    expect(positionBefore(column, "d", "a")).toBe(0);
    const moved = column.map((x) => (x.id === "c" ? { ...x, position: positionBefore(column, "c", "b") } : x));
    expect(columnOf(moved, c).map((x) => x.id)).toEqual(["a", "c", "b", "d"]);
  });
});
