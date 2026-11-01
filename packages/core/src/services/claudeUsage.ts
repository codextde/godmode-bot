import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeUsage, ClaudeUsageWindow } from "@godmode/shared";
import { logger } from "../log";
import { now } from "../util";
import { claudeConfigDir } from "./claudeUpdate";
import { runCommand } from "./doctor";

const log = logger("claude-usage");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FRESH_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;

interface OAuthCredentials {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
}

let cached: { at: number; ttl: number; value: ClaudeUsage } | null = null;
let pending: Promise<ClaudeUsage> | null = null;


export function keychainService(configDir: string | undefined): string {
  if (!configDir) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

export function parseCredentials(raw: string): OAuthCredentials | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

async function readCredentials(): Promise<OAuthCredentials | null> {
  const file = join(claudeConfigDir(), ".credentials.json");
  if (existsSync(file)) {
    try {
      const creds = parseCredentials(readFileSync(file, "utf8"));
      if (creds) return creds;
    } catch (err) {
      log.warn("could not read Claude Code's credentials file", err);
    }
  }
  if (process.platform !== "darwin") return null;
  const res = await runCommand(["/usr/bin/security", "find-generic-password", "-s", keychainService(process.env.CLAUDE_CONFIG_DIR), "-w"], {
    timeoutMs: 10_000,
  });
  if (res.code !== 0) return null;
  return parseCredentials(res.stdout.trim());
}

/** This computer's own Claude Code login (its OAuth access token), for a runner Godmode started on an SSH server. */
export async function systemClaudeLogin(): Promise<{ token: string; expiresAt: number | null } | null> {
  const creds = await readCredentials().catch(() => null);
  return creds ? { token: creds.accessToken, expiresAt: creds.expiresAt } : null;
}

function toWindow(value: unknown): ClaudeUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const { utilization, resets_at } = value as { utilization?: unknown; resets_at?: unknown };
  if (typeof utilization !== "number") return null;
  return {
    percent: Math.max(0, Math.min(100, utilization)),
    resetsAt: typeof resets_at === "string" && !Number.isNaN(Date.parse(resets_at)) ? new Date(resets_at).toISOString() : null,
  };
}

export function parseUsage(body: unknown, plan: string | null): ClaudeUsage {
  const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    state: "ok",
    fiveHour: toWindow(data.five_hour),
    week: toWindow(data.seven_day) ?? { percent: 0, resetsAt: null },
    plan,
    checkedAt: now(),
  };
}

function empty(state: ClaudeUsage["state"], plan: string | null = null): ClaudeUsage {
  return { state, fiveHour: null, week: null, plan, checkedAt: now() };
}

async function fetchUsage(): Promise<{ value: ClaudeUsage; ttl: number }> {
  const creds = await readCredentials();
  if (!creds || (creds.expiresAt !== null && creds.expiresAt <= Date.now())) return { value: empty("signed_out"), ttl: FRESH_MS };
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { value: empty("signed_out", creds.subscriptionType), ttl: FRESH_MS };
    if (!res.ok) {
      log.info("Claude usage unavailable", { status: res.status });
      return { value: empty("unavailable", creds.subscriptionType), ttl: res.status === 429 ? BACKOFF_MS : FRESH_MS };
    }
    return { value: parseUsage(await res.json(), creds.subscriptionType), ttl: FRESH_MS };
  } catch (err) {
    log.info("Claude usage request failed", { error: err instanceof Error ? err.message : String(err) });
    return { value: empty("unavailable", creds.subscriptionType), ttl: FRESH_MS };
  }
}

export async function claudeUsage(refresh = false): Promise<ClaudeUsage> {
  if (cached && !refresh && Date.now() - cached.at < cached.ttl) return cached.value;
  if (cached?.ttl === BACKOFF_MS && Date.now() - cached.at < BACKOFF_MS) return cached.value;
  pending ??= fetchUsage()
    .then(({ value, ttl }) => {
      if (value.state === "unavailable" && cached?.value.state === "ok") {
        cached = { at: Date.now(), ttl, value: { ...cached.value } };
        return cached.value;
      }
      cached = { at: Date.now(), ttl, value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
