/**
 * A chat that goes on in a fresh one (`chat_handoff`, `/handoff`). A long context makes the agent slower and less
 * precise: it writes a brief, and Godmode opens a new chat with the same setup that starts from that brief alone.
 */
import type { Conversation } from "@godmode/shared";
import { get } from "../db";
import { badRequest } from "../util";
import { endGoalAfterTurn } from "../runner/runner";
import { handoffBriefPrompt } from "../runner/prompt";
import { chatGoal, createContinuation, deleteConversation, getConversationSummary, handoffAllowed, sendMessage } from "./conversations";

export const HANDOFF_TITLE_MAX = 80;
export const HANDOFF_BRIEF_MAX = 20_000;
const BRIEF_MIN = 80;

/**
 * Open the new chat and start it with the brief. A `/goal` of the old chat moves along: it is set again in the new chat
 * after the brief's turn, and ends in the old one when the handing-over turn is over.
 */
export async function handOff(input: {
  from: string;
  title: string;
  brief: string;
  /** The run that hands over, still working in the old chat. */
  runId?: string | null;
  claudeConfigDir?: string | null;
}): Promise<{ conversation: Conversation; goal: string | null }> {
  if (!handoffAllowed(input.from)) throw badRequest("Only a chat the human started here can go on in a new chat.");
  const brief = input.brief.trim();
  if (brief.length < BRIEF_MIN) throw badRequest("Write a real brief: the goal, what is done, decisions and the next step.");
  const from = get<{ title: string }>("SELECT title FROM conversations WHERE id = ?", input.from)!;
  const title = input.title.trim().slice(0, HANDOFF_TITLE_MAX) || from.title;
  const goal = chatGoal(input.from, input.claudeConfigDir);
  const fresh = createContinuation(input.from, title);
  try {
    await sendMessage(fresh.id, { content: brief, prompt: handoffBriefPrompt(from.title, input.from, brief), source: "handoff" });
    if (goal) await sendMessage(fresh.id, { content: `/goal ${goal}`, source: "handoff" });
  } catch (err) {
    await deleteConversation(fresh.id).catch(() => {});
    throw err;
  }
  if (goal && input.runId) endGoalAfterTurn(input.runId, "It goes on in a new chat");
  return { conversation: getConversationSummary(fresh.id), goal };
}
