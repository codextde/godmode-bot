import { useEffect, useMemo, useState } from "react";
import type { CharacterMood, Message } from "@godmode/shared";
import { useMissingLogins } from "@/lib/hooks";
import { useConversationFinishedRun, type LiveRun } from "@/stores/live";
import { t } from "@/i18n";
import { describeTool, type ToolKind } from "./tool-meta";

export interface AgentMood {
  mood: CharacterMood;
  /** Short status next to the character ("Thinking…", "Needs you"); null when there's nothing to say. */
  label: string | null;
}

/** How long the character celebrates a finished run. */
const HAPPY_MS = 3_000;
const IDLE: AgentMood = { mood: "idle", label: null };

const TOOL_LABEL = {
  browser: "chat:mood.tool.browser",
  computer: "chat:mood.tool.computer",
  vault: "chat:mood.tool.vault",
  delegate: "chat:mood.tool.delegate",
  agents: "chat:mood.tool.agents",
  shell: "chat:mood.tool.shell",
  file: "chat:mood.tool.file",
  web: "chat:mood.tool.web",
  subagent: "chat:mood.tool.subagent",
  plan: "chat:mood.tool.plan",
} as const satisfies Partial<Record<ToolKind, string>>;

/** What a streaming run looks like on the character: pondering while it writes, busy while tools run. */
export function liveMood(live: LiveRun | null): AgentMood {
  if (!live) return { mood: "thinking", label: t("chat:mood.thinking") };
  if (live.status === "queued") return { mood: "idle", label: t("common:status.queued") };
  const last = live.blocks[live.blocks.length - 1];
  if (last?.type === "tool_use" && last.result === undefined) {
    const kind = describeTool(last.name, last.input).kind;
    if (kind === "missing-login") return { mood: "attention", label: t("chat:mood.needsYou") };
    return { mood: "working", label: kind in TOOL_LABEL ? t(TOOL_LABEL[kind as keyof typeof TOOL_LABEL]) : t("chat:status.working") };
  }
  if (live.activity) return { mood: "working", label: t("chat:status.working") };
  if (last?.type === "text") return { mood: "thinking", label: t("chat:mood.writing") };
  return { mood: "thinking", label: t("chat:mood.thinking") };
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
  if (waiting) return { mood: "attention", label: t("chat:mood.needsYou") };
  if (celebrating) return { mood: "happy", label: t("chat:mood.done") };
  const last = messages[messages.length - 1];
  const failed =
    finished?.status === "failed" || (last?.role === "assistant" && last.blocks.some((b) => b.type === "error") && finished?.status !== "succeeded");
  if (failed) return { mood: "error", label: t("chat:mood.hitSnag") };
  return IDLE;
}
