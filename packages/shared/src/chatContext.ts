import { COMPRESS_MIN_TOKENS, DEFAULT_AUTO_COMPACT_PERCENT, DEFAULT_CONTEXT_BUDGET, compactPoint } from "./constants";
import type { ConversationContext } from "./models";

/** Claude Code summarizes by itself close to a full window when Godmode sets no threshold. */
const CLAUDE_DEFAULT_SHARE = 0.9;

/** How full a chat's memory is, for the meter in the composer (app and phone). */
export interface ContextGauge {
  tokens: number;
  /** What the meter fills up to: the context budget when one is set, else the model's window. */
  window: number | null;
  /** Share of the window in use, 0..1; null without a window. */
  share: number | null;
  /** Where Claude summarizes by itself (share of the window); null = never. */
  autoAt: number | null;
  /** The context budget the chat is summarized at (tokens); null = by share of the model's window. */
  budget: number | null;
  tone: "calm" | "warn" | "full";
  /** Worth a summary at all. */
  compressible: boolean;
}

/**
 * `autoCompactPercent` as in RunnerSettings: undefined = the default, null = Claude Code's own threshold, 0 = never.
 * `contextBudget` (undefined = the default) replaces it: the chat is summarized once it holds that many tokens.
 */
export function contextGauge(
  context: ConversationContext | null | undefined,
  autoCompactPercent: number | null | undefined,
  contextBudget?: number | null,
): ContextGauge | null {
  if (!context) return null;
  const budget = contextBudget === undefined ? DEFAULT_CONTEXT_BUDGET : contextBudget;
  const fill = budget ? compactPoint(budget, context.window) : null;
  if (fill) {
    const share = Math.min(1, context.tokens / fill);
    const tone = share >= 0.95 ? "full" : share >= 0.75 ? "warn" : "calm";
    return { tokens: context.tokens, window: fill, share, autoAt: 1, budget: fill, tone, compressible: context.tokens >= COMPRESS_MIN_TOKENS };
  }
  const pct = autoCompactPercent;
  const autoAt = pct === 0 ? null : pct === null ? CLAUDE_DEFAULT_SHARE : (pct ?? DEFAULT_AUTO_COMPACT_PERCENT) / 100;
  const share = context.window ? Math.min(1, context.tokens / context.window) : null;
  const limit = autoAt ?? CLAUDE_DEFAULT_SHARE;
  const tone = share === null ? "calm" : share >= limit * 0.95 ? "full" : share >= limit * 0.75 ? "warn" : "calm";
  return { tokens: context.tokens, window: context.window, share, autoAt, budget: null, tone, compressible: context.tokens >= COMPRESS_MIN_TOKENS };
}

export const CONTEXT_BUDGET_CHOICES = [150_000, 200_000, 250_000, 400_000, 600_000] as const;

type CompressSettings = { autoCompactPercent?: number | null; contextBudget?: number | null };

/** "Compress long chats" as one choice: "250000" (a budget in tokens), "p70" (a share of the window), "claude" or "0". */
export function compressChoice(r: CompressSettings | undefined): string {
  const budget = r?.contextBudget === undefined ? DEFAULT_CONTEXT_BUDGET : r.contextBudget;
  if (budget) return String(budget);
  const pct = r?.autoCompactPercent === undefined ? DEFAULT_AUTO_COMPACT_PERCENT : r.autoCompactPercent;
  return pct === null ? "claude" : pct === 0 ? "0" : `p${pct}`;
}

export function compressPatch(choice: string): { contextBudget: number | null; autoCompactPercent?: number | null } {
  if (choice === "claude") return { contextBudget: null, autoCompactPercent: null };
  if (choice === "0") return { contextBudget: null, autoCompactPercent: 0 };
  if (choice.startsWith("p")) return { contextBudget: null, autoCompactPercent: Number(choice.slice(1)) };
  return { contextBudget: Number(choice) };
}

/** 421602 → "422k", 1000000 → "1M". */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
