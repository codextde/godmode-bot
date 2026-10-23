import { describe, expect, test } from "bun:test";
import type { ChatMove, ServerEvent } from "@godmode/shared";
import { bus } from "../src/events/bus";
import { moveBytes, moveStage, trackMove } from "../src/remote/chatMoves";

function listen(): { moves: (ChatMove | null)[]; stop: () => void } {
  const moves: (ChatMove | null)[] = [];
  const stop = bus.on((e: ServerEvent) => {
    if (e.type === "chat.move") moves.push(e.move);
  });
  return { moves, stop };
}

describe("chat moves", () => {
  test("a move tells each step and the bytes of the copy, then that it ended", async () => {
    const { moves, stop } = listen();
    await trackMove("c1", "Laptop", "this Mac", async () => {
      moveStage("c1", "copying", 1000);
      moveBytes("c1", 400);
      await Bun.sleep(300);
      moveBytes("c1", 5000);
      moveStage("c1", "saving");
    });
    stop();
    expect(moves.map((m) => m?.stage ?? null)).toEqual(["checking", "copying", "copying", "saving", null]);
    const copied = moves.filter((m) => m?.stage === "copying" && m.bytes > 0);
    expect(copied.at(-1)).toMatchObject({ from: "Laptop", to: "this Mac", bytes: 1000, total: 1000 });
  });

  test("a failed move still tells that it ended, and progress outside a move is ignored", async () => {
    const { moves, stop } = listen();
    moveStage("c2", "copying", 10);
    await expect(trackMove("c2", "a", "b", async () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
    moveBytes("c2", 5);
    stop();
    expect(moves.map((m) => m?.stage ?? null)).toEqual(["checking", null]);
  });

  test("bytes in quick succession are told a few times a second, not each time", async () => {
    const { moves, stop } = listen();
    await trackMove("c3", "a", "b", async () => {
      moveStage("c3", "copying", null);
      for (let i = 1; i <= 50; i++) moveBytes("c3", i * 100);
    });
    stop();
    expect(moves.length).toBeLessThan(6);
  });
});
