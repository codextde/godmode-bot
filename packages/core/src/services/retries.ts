/**
 * One click to pick up a turn that ended early (failed, timed out, stopped, cut off by a restart): a new chat run in
 * the same chat and Claude session that continues where the last one stopped — or, when Claude never got the prompt,
 * sends it again.
 */
import type { SendMessageResult, RetryMode } from "@godmode/shared";
import { retryHelps, retryModeOf, runEndOf } from "@godmode/shared";
import { get } from "../db";
import { activeRunForConversation, getRun } from "../runner/runner";
import { retryAgainNote, retryContext, retryWhy } from "../runner/prompt";
import { taskForConversation } from "../tasks/service";
import { HttpError, badRequest, notFound, now, parseJson } from "../util";
import { audit } from "./audit";
import { getConversationSummary, sendMessage } from "./conversations";
import { pauseOf } from "./pauses";
import { getSettings } from "./settings";

export async function retryRun(conversationId: string, runId: string): Promise<SendMessageResult & { mode: RetryMode }> {
  // Every check up to sendMessage runs without an await: the new run is inserted before anything else can start one.
  const conv = getConversationSummary(conversationId);
  const run = getRun(runId);
  if (run.conversationId !== conversationId) throw notFound("Run");
  if (run.trigger === "dream" || run.trigger === "check") throw badRequest("This kind of run can't be picked up again");
  const task = taskForConversation(conversationId);
  if (task) throw new HttpError(409, `This chat belongs to task #${task.number} — continue it from the task.`, "task_chat");
  if (conv.origin === "slack" || conv.origin === "telegram" || conv.origin === "teams") {
    throw new HttpError(409, "This chat lives on a chat platform — ask there to try again, so the answer reaches the person.", "platform_chat");
  }
  if (run.status !== "failed" && run.status !== "cancelled") throw new HttpError(409, "That turn didn't stop early — there's nothing to pick up.", "not_retryable");
  const latest = get<{ id: string }>("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", conversationId)?.id;
  if (latest !== runId) throw new HttpError(409, "Something new happened in this chat since — scroll down to see it.", "stale");
  if (activeRunForConversation(conversationId)) throw new HttpError(409, "The agent is already working in this chat.", "busy");
  if (pauseOf(conversationId)) throw new HttpError(409, "This chat stands still — continue it from the bar above the message box.", "busy");
  const end = runEndOf(run.error ?? "");
  if (!retryHelps(end)) throw new HttpError(409, "This chat is too long to go on — start a new chat to continue the work.", "not_retryable");

  const blocks = parseJson<Parameters<typeof retryModeOf>[0]>(
    get<{ blocks: string }>("SELECT blocks FROM messages WHERE run_id = ? AND role = 'assistant'", runId)?.blocks,
    [],
  );
  let mode = retryModeOf(blocks);
  // Without its Claude session (e.g. after /clear) there is nothing to continue.
  if (mode === "continue" && !conv.claudeSessionId) mode = "again";
  const userName = getSettings().general.userName;
  const why = retryWhy(end, run.error ?? "", userName);
  const prompt =
    mode === "continue"
      ? retryContext({ userName, why, endedAt: run.finishedAt ?? run.createdAt, startedBy: run.trigger })
      : retryAgainNote({ userName, why, startedBy: run.trigger }) + run.prompt;
  // The stored prompt has saved secrets masked: say so on the marker, the agent sees the masks.
  const masked = mode === "again" && /•{4,}/.test(run.prompt);
  const result = await sendMessage(conversationId, {
    content: mode === "continue" ? "Continue where you stopped" : "Try again",
    prompt,
    marker: [{ type: "retry", mode, runId, at: now(), ...(masked ? { masked: true } : {}) }],
    trigger: "chat",
  });
  audit("user", "run.retry", conversationId, { runId, newRunId: result.run.id, mode });
  return { ...result, mode };
}
