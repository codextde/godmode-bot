/**
 * Per-run bearer tokens for the Godmode MCP gateway. Each Claude run gets a random token scoped to
 * its run/agent; it is revoked when the run ends. Held in memory only (never persisted).
 */
import type { RunContext } from "../types";
import { randomToken } from "../util";

const tokens = new Map<string, RunContext>();

export function issueRunToken(ctx: RunContext): string {
  const token = randomToken(32);
  tokens.set(token, { ...ctx });
  return token;
}

export function resolveRunToken(token: string): RunContext | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

export function revokeRunToken(token: string): void {
  tokens.delete(token);
}
