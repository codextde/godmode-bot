import type { AgentQuestion, ID, ISODate, RunPause } from "./models";
import type { Task } from "./tasks";

/** What waits for the human. Computed by the core from live state (never from notifications), so it can't go stale. */
export type AttentionKind = "question" | "login" | "review" | "blocked" | "paused" | "held" | "failed" | "automation" | "access";

export interface AttentionItem {
  /** "<kind>:<id of the thing>", stable while it waits. */
  id: string;
  kind: AttentionKind;
  /** The agent it is about; null for a person on a bot or the team's budget. */
  agentId: ID | null;
  /** One sentence. */
  title: string;
  /** Second line, "" = none. */
  detail: string;
  /** Since when it waits. */
  since: ISODate;
  /** In-app route of the thing. */
  link: string;
  /** What the main button says. */
  action: string;
  question?: AgentQuestion;
  task?: Task;
  pause?: RunPause;
  /** The chat it is about, when there is one. */
  conversationId?: ID | null;
}

export type AttentionCounts = Record<AttentionKind, number> & { total: number };

export const ATTENTION_KINDS: readonly AttentionKind[] = ["question", "login", "review", "blocked", "paused", "held", "failed", "automation", "access"];

export const ATTENTION_GROUPS: readonly { id: string; label: string; kinds: readonly AttentionKind[] }[] = [
  { id: "waiting", label: "Waiting for you", kinds: ["question", "login", "paused", "held"] },
  { id: "review", label: "Ready for review", kinds: ["review"] },
  { id: "blocked", label: "Blocked", kinds: ["blocked"] },
  { id: "problems", label: "Went wrong", kinds: ["failed", "automation"] },
  { id: "people", label: "Asking for access", kinds: ["access"] },
];

export function emptyAttentionCounts(): AttentionCounts {
  return { question: 0, login: 0, review: 0, blocked: 0, paused: 0, held: 0, failed: 0, automation: 0, access: 0, total: 0 };
}

export function countAttention(items: readonly Pick<AttentionItem, "kind">[]): AttentionCounts {
  const counts = emptyAttentionCounts();
  for (const i of items) counts[i.kind]++;
  counts.total = items.length;
  return counts;
}
