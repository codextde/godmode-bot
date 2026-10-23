/**
 * Chats on their way between computers (owner: remote): how far each one is, told to the windows as `chat.move`
 * events so a move shows its progress on a slow connection instead of a dialog that stands still.
 */
import type { ChatMove, ChatMoveStage } from "@godmode/shared";
import { bus } from "../events/bus";
import { addWelcomeEvents } from "../server/ws";
import { now } from "../util";

const EMIT_EVERY_MS = 250;

const moves = new Map<string, ChatMove>();
const lastEmit = new Map<string, number>();

function emit(conversationId: string, force = false): void {
  const at = Date.now();
  if (!force && at - (lastEmit.get(conversationId) ?? 0) < EMIT_EVERY_MS) return;
  lastEmit.set(conversationId, at);
  bus.emit({ type: "chat.move", conversationId, move: moves.get(conversationId) ?? null });
}

addWelcomeEvents(() => [...moves.values()].map((move) => ({ type: "chat.move", conversationId: move.conversationId, move })));

/** Runs the move with its progress told; the windows learn it ended (arrived or failed) when `fn` settles. */
export async function trackMove<T>(conversationId: string, from: string, to: string, fn: () => Promise<T>): Promise<T> {
  if (moves.has(conversationId)) return fn();
  moves.set(conversationId, { conversationId, from, to, stage: "checking", bytes: 0, total: null, startedAt: now() });
  emit(conversationId, true);
  try {
    return await fn();
  } finally {
    moves.delete(conversationId);
    emit(conversationId, true);
    lastEmit.delete(conversationId);
  }
}

/** A new step of a tracked move; nothing for a chat that isn't moving through `trackMove`. */
export function moveStage(conversationId: string, stage: ChatMoveStage, total: number | null = null): void {
  const move = moves.get(conversationId);
  if (!move) return;
  moves.set(conversationId, { ...move, stage, bytes: 0, total });
  emit(conversationId, true);
}

export function moveBytes(conversationId: string, bytes: number): void {
  const move = moves.get(conversationId);
  if (!move) return;
  const next = move.total ? Math.min(bytes, move.total) : bytes;
  if (next <= move.bytes) return;
  moves.set(conversationId, { ...move, bytes: next });
  emit(conversationId);
}
