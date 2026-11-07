import { router } from "expo-router";
import type { MessageBlock } from "@godmode/shared";
import { diffText } from "./line-diff";

export type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;

export type DiffRow = { kind: "same" | "add" | "del" | "fold"; text: string };
export type FileEdit = { file: string; rows: DiffRow[]; added: number; removed: number };

/** How much of a result shows before Show all, like the desktop. */
export const RESULT_PREVIEW = 1800;
const CHUNK_CHARS = 1500;

type EditInput = { file_path?: unknown; notebook_path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown; edits?: unknown };

const text = (value: unknown) => (typeof value === "string" ? value : "");

function diffRows(before: string, after: string): DiffRow[] {
  return diffText(before, after).map((line) => ({ kind: line.kind, text: line.text }));
}

/** What a file edit (Edit, MultiEdit, Write) changed, whole; null for any other tool. */
export function fileEditOf(step: Pick<ToolUse, "name" | "input">): FileEdit | null {
  const input = (step.input && typeof step.input === "object" ? step.input : {}) as EditInput;
  const file = text(input.file_path) || text(input.notebook_path);
  let rows: DiffRow[];
  if (step.name === "Edit" && typeof input.new_string === "string") rows = diffRows(text(input.old_string), input.new_string);
  else if (step.name === "Write" && typeof input.content === "string") rows = diffRows("", input.content);
  else if (step.name === "MultiEdit" && Array.isArray(input.edits)) {
    rows = (input.edits as { old_string?: unknown; new_string?: unknown }[]).flatMap((e, i) => [
      ...(i > 0 ? [{ kind: "fold" as const, text: "⋯" }] : []),
      ...diffRows(text(e?.old_string), text(e?.new_string)),
    ]);
  } else return null;
  return { file, rows, added: rows.filter((r) => r.kind === "add").length, removed: rows.filter((r) => r.kind === "del").length };
}

export function toolInputText(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Long text as pieces a list can show one by one: whole lines where they fit, a very long line cut. */
export function textChunks(whole: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of whole.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= size) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    let rest = line;
    while (rest.length > size) {
      chunks.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    current = rest;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

/** Plan items of a TodoWrite call. */
export function todoItems(input: unknown): { content: string; status: string }[] | null {
  const todos = input && typeof input === "object" ? (input as { todos?: unknown }).todos : null;
  if (!Array.isArray(todos)) return null;
  return todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ content: String(t.content ?? t.activeForm ?? t.subject ?? ""), status: typeof t.status === "string" ? t.status : "pending" }));
}

/** The step the sheet opens with: what the chat has of it, until the whole call is loaded. */
let handed: ToolUse | null = null;

export function takeToolCall(id: string): ToolUse | null {
  const given = handed?.id === id ? handed : null;
  handed = null;
  return given;
}

export function openToolCall(step: ToolUse, conversationId?: string, messageId?: string) {
  handed = step;
  router.push({ pathname: "/tool-call", params: { id: step.id, conversationId: conversationId ?? "", messageId: messageId ?? "" } });
}
