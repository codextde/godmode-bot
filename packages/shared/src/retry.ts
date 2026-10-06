import type { MessageBlock, RetryMode } from "./models";
import { RUN_WATCHDOG } from "./heartbeat";

/** Godmode's own sentences for a turn that ended early (the core writes them; clients recognise them with runEndOf). */
export const RUN_INTERRUPTED = "Interrupted (Godmode restarted)";
export const RUN_SHUT_DOWN = "Cancelled (Godmode shut down)";
export const RUN_STOPPED_BY_USER = "Cancelled by user";
export const RUN_CLI_MISSING = "Claude Code CLI not found. Install it from Settings → System.";
export const RUN_MAX_TURNS = "Stopped after reaching the maximum number of turns.";
export const RUN_COST_LIMIT = "Stopped: the run reached its cost budget.";

export type RunEndKind = "interrupted" | "stopped" | "timeout" | "stalled" | "turns" | "budget" | "auth" | "cli" | "folder" | "vm" | "model" | "context";

export interface RunEnd {
  kind: RunEndKind;
  minutes?: number;
  byUser?: boolean;
  /** `vm`: virtual machines are turned off (else the VM couldn't be started or used). */
  off?: boolean;
}

/** What one of Godmode's own end-of-turn sentences means; null for any other text (a plain error). */
export function runEndOf(text: string): RunEnd | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith(RUN_INTERRUPTED) || t.startsWith(RUN_SHUT_DOWN)) return { kind: "interrupted" };
  const timeout = /^Timed out after (\d+) minutes/.exec(t);
  if (timeout) return { kind: "timeout", minutes: Number(timeout[1]) };
  if (t.startsWith(RUN_MAX_TURNS)) return { kind: "turns" };
  if (t.startsWith(RUN_WATCHDOG)) return { kind: "stalled" };
  if (/prompt is too long|context (?:length|window)|conversation is too long/i.test(t)) return { kind: "context" };
  if (t.startsWith(RUN_COST_LIMIT)) return { kind: "budget" };
  if (/^Claude Code is not signed in/.test(t) || /^(?:invalid api key|authentication_error|oauth token (?:has )?expired|credit balance is too low)/i.test(t)) return { kind: "auth" };
  if (t.startsWith(RUN_CLI_MISSING)) return { kind: "cli" };
  if (/Pick another folder for this chat\.|Change the default folder in /.test(t)) return { kind: "folder" };
  if (/virtual machines are turned off/i.test(t)) return { kind: "vm", off: true };
  if (/virtual machine can't be used/i.test(t)) return { kind: "vm" };
  if (/^Invalid model id/.test(t)) return { kind: "model" };
  if (t.startsWith(RUN_STOPPED_BY_USER)) return { kind: "stopped", byUser: true };
  if (/^(Cancelled|Stopped)\b/.test(t) || t === "Restarted from the task board" || t.startsWith("Paused, but what it needed")) return { kind: "stopped" };
  return null;
}

/** Whether trying again can help at all: not when the chat is too long to go on. */
export function retryHelps(end: RunEnd | null): boolean {
  return end?.kind !== "context";
}

/** Something to fix first, outside the chat (sign-in, the CLI, the VM) or in its bar (the folder, the model). */
export function needsFix(end: RunEnd | null): boolean {
  return !!end && ["auth", "cli", "folder", "vm", "model"].includes(end.kind);
}

/** `continue` when the turn holds any text, thinking or tool step (Claude got the prompt), else `again`. */
export function retryModeOf(blocks: readonly MessageBlock[]): RetryMode {
  return blocks.some((b) => b.type === "text" || b.type === "thinking" || b.type === "tool_use") ? "continue" : "again";
}
