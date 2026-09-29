/** The conversation an automation's runs go to. */
import type { Routine } from "@godmode/shared";
import { get, run as exec } from "../db";
import { createConversation } from "../services/conversations";
import { getSettings } from "../services/settings";

function formatDate(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(getSettings().general.language || "en", {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Reuse the routine's conversation when configured (and still present), otherwise start a new one — titled after
 * `occasion` (what started it, e.g. the event) when given, else dated.
 */
export function automationConversation(routine: Routine, occasion?: string): string {
  if (routine.reuseConversation && routine.conversationId) {
    const existing = get<{ id: string }>(
      "SELECT id FROM conversations WHERE id = ? AND agent_id = ?",
      routine.conversationId,
      routine.agentId,
    );
    if (existing) return existing.id;
  }
  // A reused conversation spans many runs, so only per-run conversations carry the occasion or date.
  const title = routine.reuseConversation ? routine.name : `${routine.name} · ${occasion || formatDate(new Date(), routine.timezone)}`;
  const conversation = createConversation({ agentId: routine.agentId, title, origin: "routine" });
  if (routine.reuseConversation) exec("UPDATE routines SET conversation_id = ? WHERE id = ?", conversation.id, routine.id);
  return conversation.id;
}
