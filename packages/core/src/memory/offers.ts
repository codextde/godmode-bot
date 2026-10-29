/**
 * Work the main agent offers to take off the human's plate, spotted while it dreams (`offer_help`). Offers are drafts
 * of their dream until it succeeds; "Do it" starts a chat with the offer's prompt, and the next dream hears what became
 * of them.
 */
import type { AcceptOfferResult, Agent, Offer, OfferStatus } from "@godmode/shared";
import { all, get, insert, run as exec } from "../db";
import { bus } from "../events/bus";
import { badRequest, conflict, newId, notFound, now, truncate } from "../util";
import { getDefaultAgentId } from "../agents/service";
import { getSettings } from "../services/settings";
import { startChat } from "../services/conversations";

/** Open offers at a time: a few good ones, not a to-do list. */
export const MAX_OPEN = 3;
export const TITLE_MAX = 90;
export const WHY_MAX = 280;
export const PROMPT_MAX = 2_000;
const OPEN_DAYS = 7;
/** How far back the next dream sees what became of its offers. */
const HISTORY_DAYS = 30;
const HISTORY_MAX = 12;

interface OfferRow {
  id: string;
  agent_id: string;
  dream_id: string | null;
  title: string;
  why: string;
  prompt: string;
  status: OfferStatus | "draft";
  conversation_id: string | null;
  created_at: string;
  decided_at: string | null;
}

function toOffer(row: OfferRow): Offer {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    why: row.why,
    prompt: row.prompt,
    status: row.status as OfferStatus,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function offerRow(id: string): OfferRow {
  const row = get<OfferRow>("SELECT * FROM offers WHERE id = ?", id);
  if (!row || row.status === "draft") throw notFound("Offer");
  return row;
}

const emit = () => bus.changed("offers");
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The agent offers work while it dreams: it is the main agent and the human wants offers. */
export function offersOn(agent: Pick<Agent, "id">): boolean {
  return getSettings().memory.dreaming.offers && getDefaultAgentId() === agent.id;
}

function expireStale() {
  const res = exec("UPDATE offers SET status = 'expired', decided_at = ? WHERE status = 'open' AND created_at < ?", now(), daysAgo(OPEN_DAYS));
  if (res.changes) emit();
}

/** Open offers of the main agent, newest first; none while offers are switched off. */
export function listOffers(): Offer[] {
  const agentId = getDefaultAgentId();
  if (!agentId || !getSettings().memory.dreaming.offers) return [];
  expireStale();
  return all<OfferRow>(
    `SELECT o.* FROM offers o JOIN agents a ON a.id = o.agent_id
     WHERE o.agent_id = ? AND o.status = 'open' AND a.enabled = 1 ORDER BY o.created_at DESC LIMIT ?`,
    agentId,
    MAX_OPEN,
  ).map(toOffer);
}

function openCount(agentId: string): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM offers WHERE agent_id = ? AND status = 'open'", agentId)?.n ?? 0;
}

/** What the dream is told about its offers: the free slots, what still waits, and what became of the recent ones. */
export function offerContext(agentId: string): { slots: number; open: string[]; history: string[] } {
  expireStale();
  const open = all<OfferRow>("SELECT * FROM offers WHERE agent_id = ? AND status = 'open' ORDER BY created_at DESC", agentId);
  const decided = all<OfferRow>(
    "SELECT * FROM offers WHERE agent_id = ? AND status IN ('accepted', 'dismissed', 'expired') AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
    agentId,
    daysAgo(HISTORY_DAYS),
    HISTORY_MAX,
  );
  const verdict: Record<string, string> = { accepted: "taken up", dismissed: "declined", expired: "ignored until it expired" };
  return {
    slots: Math.max(0, MAX_OPEN - open.length),
    open: open.map((o) => `"${o.title}" (offered ${o.created_at.slice(0, 10)})`),
    history: decided.map((o) => `"${o.title}" — ${verdict[o.status]}`),
  };
}

export interface OfferInput {
  title: string;
  why: string;
  prompt: string;
}

/** `offer_help` from a dream run of the main agent. Returns the tool's answer. */
export function recordOffers(runId: string, offers: OfferInput[]): string {
  const dream = get<{ id: string; agent_id: string }>("SELECT id, agent_id FROM dreams WHERE run_id = ? AND status IN ('queued', 'running')", runId);
  if (!dream) throw badRequest("Only a dream can offer help");
  if (!offersOn({ id: dream.agent_id })) return "Offers are switched off. End the dream as usual.";
  const drafts = all<{ title: string }>("SELECT title FROM offers WHERE dream_id = ? AND status = 'draft'", dream.id);
  const known = [
    ...drafts.map((d) => d.title),
    ...all<{ title: string }>("SELECT title FROM offers WHERE agent_id = ? AND status <> 'draft' AND created_at >= ?", dream.agent_id, daysAgo(HISTORY_DAYS)).map((o) => o.title),
  ];
  let room = MAX_OPEN - openCount(dream.agent_id) - drafts.length;
  const lines: string[] = [];
  for (const o of offers) {
    const title = truncate(o.title.replace(/\s+/g, " ").trim(), TITLE_MAX);
    const prompt = truncate(o.prompt.trim(), PROMPT_MAX);
    if (!title || !prompt) {
      lines.push(`- Skipped an offer without a title or prompt.`);
      continue;
    }
    if (known.some((k) => sameTitle(k, title))) {
      lines.push(`- "${title}": already offered recently, skipped.`);
      continue;
    }
    if (room <= 0) {
      lines.push(`- "${title}": no room, ${MAX_OPEN} offers at most wait at a time.`);
      continue;
    }
    insert("offers", {
      id: newId("ofr"),
      agent_id: dream.agent_id,
      dream_id: dream.id,
      title,
      why: truncate(o.why.replace(/\s+/g, " ").trim(), WHY_MAX),
      prompt,
      status: "draft",
      conversation_id: null,
      created_at: now(),
      decided_at: null,
    });
    known.push(title);
    room--;
    lines.push(`- "${title}": offered.`);
  }
  lines.push("They show on Home once the dream is done. Finish the dream as usual.");
  return lines.join("\n");
}

/** The dream ended: show its offers when it succeeded, drop them otherwise. */
export function settleOffers(dreamId: string, succeeded: boolean): void {
  const res = succeeded
    ? exec("UPDATE offers SET status = 'open', created_at = ? WHERE dream_id = ? AND status = 'draft'", now(), dreamId)
    : exec("DELETE FROM offers WHERE dream_id = ? AND status = 'draft'", dreamId);
  if (succeeded && res.changes) emit();
}

/** "Do it": start a chat with the agent that offered, with the offer's prompt as the human's message. */
export async function acceptOffer(id: string): Promise<AcceptOfferResult> {
  const row = offerRow(id);
  if (row.status !== "open") throw conflict(row.status === "accepted" ? "This offer was already taken up" : "This offer is no longer open");
  const claimed = exec("UPDATE offers SET status = 'accepted', decided_at = ? WHERE id = ? AND status = 'open'", now(), id);
  if (!claimed.changes) throw conflict("This offer was already taken up");
  try {
    const { conversation } = await startChat({ agentId: row.agent_id, content: row.prompt, title: row.title, source: "offer" });
    exec("UPDATE offers SET conversation_id = ? WHERE id = ?", conversation.id, id);
    emit();
    return { offer: toOffer(offerRow(id)), conversation };
  } catch (err) {
    exec("UPDATE offers SET status = 'open', decided_at = NULL WHERE id = ?", id);
    throw err;
  }
}

/** "No thanks". */
export function dismissOffer(id: string): Offer {
  const row = offerRow(id);
  if (row.status !== "open") return toOffer(row);
  exec("UPDATE offers SET status = 'dismissed', decided_at = ? WHERE id = ? AND status = 'open'", now(), id);
  emit();
  return toOffer(offerRow(id));
}
