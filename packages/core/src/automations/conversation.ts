/** The conversation an automation's runs go to. */
import type { Routine } from "@godmode/shared";
import { get, run as exec } from "../db";
import { createConversation } from "../services/conversations";
import { getAgent } from "../agents/service";
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

/** The automation's agent reads raw secrets, so it matters which of its chats and notes had them. */
export function automationAgentReveals(routine: Pick<Routine, "agentId">): boolean {
  try {
    return getAgent(routine.agentId).permissions.secretAccess === "reveal";
  } catch {
    return true;
  }
}

/**
 * A chat keeps its secret access for good, so an automation only goes on in a chat that has its own: one that
 * became fill-only (or stopped being it) starts a new chat, and nothing read in the old one comes along. For an
 * agent that reads no raw secrets anyway, every chat of its own fits.
 */
export function chatFitsAutomation(routine: Pick<Routine, "agentId" | "fillOnly"> & { runOn?: string | null }, conversationId: string): boolean {
  const existing = get<{ secret_access: string | null; runner_id: string | null }>(
    "SELECT secret_access, runner_id FROM conversations WHERE id = ? AND agent_id = ?",
    conversationId,
    routine.agentId,
  );
  if (!existing) return false;
  // Pinned to one computer: a chat that lives on another one would run there.
  if (routine.runOn && existing.runner_id) return false;
  return (existing.secret_access === "fill") === routine.fillOnly || !automationAgentReveals(routine);
}

/**
 * Reuse the routine's conversation when configured (and still present), otherwise start a new one — titled after
 * `occasion` (what started it, e.g. the event) when given, else dated.
 */
export function automationConversation(routine: Routine, occasion?: string): string {
  if (routine.reuseConversation && routine.conversationId && chatFitsAutomation(routine, routine.conversationId)) return routine.conversationId;
  // A reused conversation spans many runs, so only per-run conversations carry the occasion or date.
  const title = routine.reuseConversation ? routine.name : `${routine.name} · ${occasion || formatDate(new Date(), routine.timezone)}`;
  const conversation = createConversation({ agentId: routine.agentId, title, origin: "routine", fillOnly: routine.fillOnly });
  if (routine.reuseConversation) exec("UPDATE routines SET conversation_id = ? WHERE id = ?", conversation.id, routine.id);
  return conversation.id;
}
