/**
 * What a run that ended leaves behind when nobody watched it: the chat becomes unread, and the human gets one notice
 * ("Mia replied in “Q4 plan”", "“Daily KPIs” failed") — unless they have the chat open, the agent already told them
 * itself (notify_user), or it stopped on a missing login (that has its own notice).
 */
import type { Run } from "@godmode/shared";
import { get, run as sql } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { isConversationViewed, setConversationViewHandler } from "../server/ws";
import { emitConversationUpdated, markConversationsRead } from "./conversations";
import { notify } from "./notifications";

const log = logger("notices");

/** Chats the human talks in: unread marks and reply notices are for these. */
const HUMAN_ORIGINS = new Set(["chat", "api"]);
/** Turns the human started or asked for (a follow-up the agent promised them counts). */
const HUMAN_TRIGGERS = new Set(["chat", "manual", "api", "followup"]);

/** The agent told the human itself during this run. */
function calledNotifyUser(runId: string): boolean {
  return !!get("SELECT 1 FROM messages WHERE run_id = ? AND role = 'assistant' AND instr(blocks, 'notify_user') > 0", runId);
}

/** The run stopped on a missing login, which notifies on its own. */
function reportedMissingLogin(runId: string): boolean {
  return !!get("SELECT 1 FROM missing_logins WHERE run_id = ?", runId);
}

const shorten = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function afterRun(r: Run): void {
  if (r.status !== "succeeded" && r.status !== "failed") return;
  const conv = get<{ id: string; title: string; origin: string; archived: number; agent: string | null }>(
    "SELECT c.id, c.title, c.origin, c.archived, a.name AS agent FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = ?",
    r.conversationId,
  );
  if (!conv) return;
  const viewed = isConversationViewed(conv.id);
  const agent = conv.agent ?? "The agent";

  if (r.trigger === "routine" && r.routineId) {
    automationNotice(r, conv.id, viewed);
    return;
  }
  if (!HUMAN_ORIGINS.has(conv.origin) || !HUMAN_TRIGGERS.has(r.trigger) || viewed) return;
  sql("UPDATE conversations SET unread_run_id = ? WHERE id = ?", r.id, conv.id);
  emitConversationUpdated(conv.id);
  // A follow-up reports through its own notice (followups.ts).
  if (r.trigger === "followup" || calledNotifyUser(r.id) || reportedMissingLogin(r.id)) return;
  if (r.status === "failed") notify("error", `${agent} ran into a problem in “${conv.title}”`, shorten(r.error ?? ""), `/chat/${conv.id}`);
  else notify("success", `${agent} replied in “${conv.title}”`, shorten((r.result ?? "").replace(/\s+/g, " ").trim()), `/chat/${conv.id}`);
}

/** An automation's run ended: tell the human what its notify setting asks for (a failure once until it works again). */
function automationNotice(r: Run, conversationId: string, viewed: boolean): void {
  const routine = get<{ name: string; notify: string | null; agent_id: string }>("SELECT name, notify, agent_id FROM routines WHERE id = ?", r.routineId!);
  if (!routine) return;
  const setting = routine.notify ?? "failures";
  if (setting === "never" || viewed || calledNotifyUser(r.id) || reportedMissingLogin(r.id)) return;
  if (r.status === "failed") {
    const before = get<{ status: string }>(
      "SELECT status FROM runs WHERE routine_id = ? AND trigger = 'routine' AND id != ? AND status IN ('succeeded', 'failed') ORDER BY created_at DESC LIMIT 1",
      r.routineId!,
      r.id,
    );
    if (before?.status === "failed") return;
    notify("error", `“${routine.name}” failed`, shorten(r.error ?? "Its last run failed."), `/chat/${conversationId}`);
  } else if (setting === "always") {
    notify("success", `“${routine.name}” finished`, shorten((r.result ?? "").replace(/\s+/g, " ").trim()), `/chat/${conversationId}`);
  }
}

let unsubscribe: (() => void) | null = null;

export function startRunNotices(): void {
  setConversationViewHandler((id) => markConversationsRead([id]));
  unsubscribe ??= bus.on((e) => {
    if (e.type !== "run.finished") return;
    try {
      afterRun(e.run);
    } catch (err) {
      log.warn(`could not handle the end of run ${e.run.id}`, err);
    }
  });
}

export function stopRunNotices(): void {
  unsubscribe?.();
  unsubscribe = null;
}
