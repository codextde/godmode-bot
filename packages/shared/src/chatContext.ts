import { COMPRESS_MIN_TOKENS, DEFAULT_AUTO_COMPACT_PERCENT } from "./constants";
import type { ConversationContext } from "./models";

/** Claude Code summarizes by itself close to a full window when Godmode sets no threshold. */
const CLAUDE_DEFAULT_SHARE = 0.9;

/** How full a chat's memory is, for the meter in the composer (app and phone). */
export interface ContextGauge {
  tokens: number;
  window: number | null;
  /** Share of the window in use, 0..1; null without a window. */
  share: number | null;
  /** Where Claude summarizes by itself (share of the window); null = never. */
  autoAt: number | null;
  tone: "calm" | "warn" | "full";
  /** Worth a summary at all. */
  compressible: boolean;
}

/** `autoCompactPercent` as in RunnerSettings: undefined = the default, null = Claude Code's own threshold, 0 = never. */
export function contextGauge(context: ConversationContext | null | undefined, autoCompactPercent: number | null | undefined): ContextGauge | null {
  if (!context) return null;
  const pct = autoCompactPercent;
  const autoAt = pct === 0 ? null : pct === null ? CLAUDE_DEFAULT_SHARE : (pct ?? DEFAULT_AUTO_COMPACT_PERCENT) / 100;
  const share = context.window ? Math.min(1, context.tokens / context.window) : null;
  const limit = autoAt ?? CLAUDE_DEFAULT_SHARE;
  const tone = share === null ? "calm" : share >= limit * 0.95 ? "full" : share >= limit * 0.75 ? "warn" : "calm";
  return { tokens: context.tokens, window: context.window, share, autoAt, tone, compressible: context.tokens >= COMPRESS_MIN_TOKENS };
}

/** 421602 → "422k", 1000000 → "1M". */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
