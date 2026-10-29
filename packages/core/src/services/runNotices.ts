/**
 * What a run that ended leaves behind when nobody watched it: the chat becomes unread, and the human gets one notice
 * ("Mia replied in “Q4 plan”", "“Daily KPIs” failed") — unless they have the chat open, the agent already told them
 * itself (notify_user), or it stopped on a missing login (that has its own notice).
 */
import type { Run } from "@godmode/shared";
import { runEndOf } from "@godmode/shared";
import { all, get, run as sql } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { isConversationViewed, setConversationViewHandler } from "../server/ws";
import { emitConversationUpdated, markConversationsRead } from "./conversations";
import { notify, runNotifiedUser } from "./notifications";

const log = logger("notices");

/** Chats the human talks in: unread marks and reply notices are for these. */
const HUMAN_ORIGINS = new Set(["chat", "api"]);
/** Turns the human started or asked for (a follow-up the agent promised them counts). */
const HUMAN_TRIGGERS = new Set(["chat", "manual", "api", "followup", "call"]);

/** The run stopped on a missing login, which notifies on its own. */
function reportedMissingLogin(runId: string): boolean {
  return !!get("SELECT 1 FROM missing_logins WHERE run_id = ?", runId);
}

const shorten = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function afterRun(r: Run): void {
  if (r.status !== "succeeded" && r.status !== "failed") return;
  const conv = get<{ id: string; title: string; origin: string; archived: number; private: number; agent: string | null }>(
    "SELECT c.id, c.title, c.origin, c.archived, c.private, a.name AS agent FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = ?",
    r.conversationId,
  );
  // A private chat leaves no unread mark or notification behind: its text would outlive it there.
  if (!conv || conv.private) return;
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
  if (r.trigger === "followup" || runNotifiedUser(r.id) || reportedMissingLogin(r.id)) return;
  if (r.status === "failed") notify("error", `${agent} ran into a problem in “${conv.title}”`, shorten(r.error ?? ""), `/chat/${conv.id}`);
  else notify("success", `${agent} replied in “${conv.title}”`, shorten((r.result ?? "").replace(/\s+/g, " ").trim()), `/chat/${conv.id}`);
}

/** An automation's run ended: tell the human what its notify setting asks for (a failure once until it works again). */
function automationNotice(r: Run, conversationId: string, viewed: boolean): void {
  const routine = get<{ name: string; notify: string | null; agent_id: string }>("SELECT name, notify, agent_id FROM routines WHERE id = ?", r.routineId!);
  if (!routine) return;
  const setting = routine.notify ?? "failures";
  if (setting === "never" || viewed || runNotifiedUser(r.id) || reportedMissingLogin(r.id)) return;
  if (r.status === "failed") {
    // Claude being signed out has a notice of its own for all the runs it fails (services/claudeLogin.ts), a moment later.
    if (runEndOf(r.error ?? "")?.kind === "auth") {
      setTimeout(() => {
        try {
          if (!signOutNoticed(r)) failureNotice(r, routine.name, conversationId);
        } catch (err) {
          log.warn(`could not handle the end of run ${r.id}`, err);
        }
      }, signOutWaitMs).unref?.();
      return;
    }
    // Once until it works again; a run that failed over the sign-in says nothing about that.
    const before = all<{ status: string; error: string | null }>(
      "SELECT status, error FROM runs WHERE routine_id = ? AND trigger = 'routine' AND id != ? AND status IN ('succeeded', 'failed') ORDER BY created_at DESC LIMIT 20",
      r.routineId!,
      r.id,
    ).find((b) => runEndOf(b.error ?? "")?.kind !== "auth");
    if (before?.status === "failed") return;
    failureNotice(r, routine.name, conversationId);
  } else if (setting === "always") {
    notify("success", `“${routine.name}” finished`, shorten((r.result ?? "").replace(/\s+/g, " ").trim()), `/chat/${conversationId}`);
  }
}

function failureNotice(r: Run, name: string, conversationId: string): void {
  notify("error", `“${name}” failed`, shorten(r.error ?? "Its last run failed."), `/chat/${conversationId}`);
}

/** Claude's sign-in notice went out since anything last worked before this run (on this computer or a runner). */
function signOutNoticed(r: Run): boolean {
  const worked = get<{ at: string }>("SELECT finished_at AS at FROM runs WHERE status = 'succeeded' AND finished_at <= ? ORDER BY finished_at DESC LIMIT 1", r.createdAt)?.at;
  return !!get(
    "SELECT 1 FROM notifications WHERE created_at >= ? AND (title LIKE 'Claude is signed out%' OR title LIKE 'Claude refused the API key%') LIMIT 1",
    worked ?? new Date(Date.parse(r.createdAt) - 86_400_000).toISOString(),
  );
}

let signOutWaitMs = 10_000;

/** Tests: how long a failure over the sign-in waits for Claude's sign-in notice. */
export function __setSignOutWaitForTests(ms: number): void {
  signOutWaitMs = ms;
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
