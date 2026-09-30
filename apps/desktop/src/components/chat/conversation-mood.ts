import { useEffect, useMemo, useState } from "react";
import type { CharacterMood, Message } from "@godmode/shared";
import { useMissingLogins } from "@/lib/hooks";
import { useConversationFinishedRun, type LiveRun } from "@/stores/live";
import { describeTool, type ToolKind } from "./tool-meta";

export interface AgentMood {
  mood: CharacterMood;
  /** Short status next to the character ("Thinking…", "Needs you"); null when there's nothing to say. */
  label: string | null;
}

/** How long the character celebrates a finished run. */
const HAPPY_MS = 3_000;
const IDLE: AgentMood = { mood: "idle", label: null };

const TOOL_LABEL: Partial<Record<ToolKind, string>> = {
  browser: "Working in the browser…",
  computer: "Using the computer…",
  vault: "Signing in…",
  delegate: "Asking a teammate…",
  agents: "Setting up agents…",
  shell: "Running commands…",
  file: "Working on files…",
  web: "Looking things up…",
  subagent: "Working with helpers…",
  plan: "Making a plan…",
};

/** What a streaming run looks like on the character: pondering while it writes, busy while tools run. */
export function liveMood(live: LiveRun | null): AgentMood {
  if (!live) return { mood: "thinking", label: "Thinking…" };
  if (live.status === "queued") return { mood: "idle", label: "Queued" };
  const last = live.blocks[live.blocks.length - 1];
  if (last?.type === "tool_use" && last.result === undefined) {
    const kind = describeTool(last.name, last.input).kind;
    if (kind === "missing-login") return { mood: "attention", label: "Needs you" };
    return { mood: "working", label: TOOL_LABEL[kind] ?? "Working…" };
  }
  if (live.activity) return { mood: "working", label: "Working…" };
  if (last?.type === "text") return { mood: "thinking", label: "Writing…" };
  return { mood: "thinking", label: "Thinking…" };
}

/**
 * The agent's mood in a conversation: live while a run streams, "needs you" while one of its runs waits on a missing
 * login, a short celebration after a run finished, a worried face when the last turn failed.
 */
export function useConversationMood(conversationId: string, messages: Message[], live: LiveRun | null): AgentMood {
  const finished = useConversationFinishedRun(conversationId);
  const { data: missing = [] } = useMissingLogins("open");
  const [, rerender] = useState(0);

  const celebrating = !live && finished?.status === "succeeded" && Date.now() - finished.at < HAPPY_MS;
  useEffect(() => {
    if (!celebrating || !finished) return;
    const t = setTimeout(() => rerender((n) => n + 1), HAPPY_MS - (Date.now() - finished.at));
    return () => clearTimeout(t);
  }, [celebrating, finished]);

  const waiting = useMemo(() => {
    if (!missing.length) return false;
    const runIds = new Set(messages.map((m) => m.runId).filter(Boolean));
    return missing.some((m) => m.runId && runIds.has(m.runId));
  }, [missing, messages]);

  if (live) return liveMood(live);
  if (waiting) return { mood: "attention", label: "Needs you" };
  if (celebrating) return { mood: "happy", label: "Done" };
  const last = messages[messages.length - 1];
  const failed =
    finished?.status === "failed" || (last?.role === "assistant" && last.blocks.some((b) => b.type === "error") && finished?.status !== "succeeded");
  if (failed) return { mood: "error", label: "Hit a snag" };
  return IDLE;
}
