/**
 * Webhook triggers: every webhook automation has a secret URL `/hooks/<token>` that anything able to reach the core
 * may POST to (other tools, scripts, a tunnel). The token is stored as a SHA-256 hash for lookup and sealed with the
 * vault key so the UI can show the URL again.
 */
import type { Context } from "hono";
import { get, run as exec } from "../db";
import { logger } from "../log";
import { audit } from "../services/audit";
import { emitRoutine, getRoutine } from "../services/routines";
import * as vault from "../vault/vault";
import { sha256 } from "../vault/crypto";
import { badRequest, HttpError, now, randomToken } from "../util";
import { describePayload, receiveEvent } from "./events";

const log = logger("webhooks");

const TOKEN_PREFIX = "whk_";
export const WEBHOOK_MAX_BYTES = 256 * 1024;
/** Calls per automation per minute. */
const RATE_LIMIT = 60;
/** Request headers that identify a delivery (for dedupe). */
const DELIVERY_HEADERS = ["idempotency-key", "x-request-id", "x-github-delivery", "webhook-id"];
const SENSITIVE_HEADER = /auth|cookie|token|secret|signature|key|password/i;

const rate = new Map<string, { windowStart: number; count: number }>();

const tokenContext = (routineId: string) => `routines.webhook_token:${routineId}`;

/** A new secret for a routine: the token, its lookup hash and its sealed copy. Throws 423 when the vault is locked. */
export function issueWebhookToken(routineId: string): { token: string; hash: string; enc: string } {
  const token = `${TOKEN_PREFIX}${randomToken(24)}`;
  return { token, hash: sha256(token), enc: vault.seal(token, tokenContext(routineId)) };
}

export function clearWebhookToken(routineId: string): void {
  exec("UPDATE routines SET webhook_token_hash = NULL, webhook_token_enc = NULL WHERE id = ?", routineId);
}

/** Secret path of a webhook automation, or null while the vault is locked. */
export function webhookPathOf(row: { id: string; webhook_token_enc: string | null }): string | null {
  if (!row.webhook_token_enc || !vault.isUnlocked()) return null;
  try {
    return `/hooks/${vault.open(row.webhook_token_enc, tokenContext(row.id))}`;
  } catch {
    return null;
  }
}

/** Replace a webhook automation's URL; the old one stops working at once. */
export function rotateWebhookToken(routineId: string, actor = "user"): { webhookPath: string } {
  const routine = getRoutine(routineId);
  if (routine.trigger.type !== "webhook") throw badRequest(`“${routine.name}” is not started by a webhook`);
  const { token, hash, enc } = issueWebhookToken(routineId);
  exec("UPDATE routines SET webhook_token_hash = ?, webhook_token_enc = ?, updated_at = ? WHERE id = ?", hash, enc, now(), routineId);
  audit(actor, "automation.webhook.rotate", routineId, {});
  emitRoutine(routineId);
  return { webhookPath: `/hooks/${token}` };
}

function allow(routineId: string): boolean {
  const t = Date.now();
  const entry = rate.get(routineId);
  if (!entry || t - entry.windowStart >= 60_000) {
    rate.set(routineId, { windowStart: t, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

/** Read at most `max` bytes of the body; null when it is larger. */
async function readBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  return text;
}

/** Headers worth passing on (event names, content type), never credentials. */
function eventHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (Object.keys(out).length >= 20 || SENSITIVE_HEADER.test(name)) return;
    if (name === "content-type" || name === "user-agent" || name.startsWith("x-")) out[name] = value.slice(0, 300);
  });
  return out;
}

/** POST /hooks/:token — public; the secret token is the credential (and must not end up in logs). */
export async function handleWebhook(c: Context): Promise<Response> {
  try {
    return await receiveWebhook(c);
  } catch (err) {
    log.error("webhook call failed", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal error", code: "internal" }, 500);
  }
}

async function receiveWebhook(c: Context): Promise<Response> {
  const token = c.req.param("token") ?? "";
  const row = token.startsWith(TOKEN_PREFIX) && token.length <= 100
    ? get<{ id: string }>("SELECT id FROM routines WHERE webhook_token_hash = ?", sha256(token))
    : null;
  if (!row) return c.json({ error: "Unknown webhook", code: "not_found" }, 404);
  if (!allow(row.id)) return c.json({ error: "Too many calls — slow down", code: "rate_limited" }, 429);

  const text = await readBody(c.req.raw, WEBHOOK_MAX_BYTES);
  if (text === null) return c.json({ error: `The body is larger than ${WEBHOOK_MAX_BYTES / 1024} KB`, code: "too_large" }, 413);
  const body = parseBody(text, c.req.header("content-type") ?? "");
  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  const dedupeKey = DELIVERY_HEADERS.map((h) => c.req.header(h)).find((v) => v && v.trim()) ?? null;
  const described = describePayload(body);
  let event;
  try {
    event = receiveEvent(row.id, {
      source: "webhook",
      title: described ? `Webhook · ${described}` : "Webhook call",
      payload: { body, ...(Object.keys(query).length ? { query } : {}), headers: eventHeaders(c.req.raw.headers) },
      dedupeKey,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return c.json({ error: "Unknown webhook", code: "not_found" }, 404);
    throw err;
  }
  if (!event) return c.json({ ok: true, duplicate: true });
  if (event.status === "skipped") return c.json({ ok: false, error: event.note, eventId: event.id, code: "skipped" }, 409);
  return c.json({ ok: true, eventId: event.id }, 202);
}
