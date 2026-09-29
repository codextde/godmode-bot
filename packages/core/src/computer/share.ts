/**
 * Sharing a screen, window or browser tab with a chat. The share is stored on the conversation and picked up by
 * the next run; stopping it takes effect immediately, also for a run that is already working.
 */
import type { ComputerTarget, Conversation } from "@godmode/shared";
import { computerTargetLabel, sameComputerTarget } from "@godmode/shared";
import { activeRunForConversation } from "../runner/runner";
import { audit } from "../services/audit";
import { getConversationSummary, updateConversation } from "../services/conversations";
import { detachComputer, runComputer, validateTarget } from "./service";
import { parseComputerTarget } from "./targets";

export async function shareComputer(conversationId: string, input: ComputerTarget | null): Promise<Conversation> {
  const current = getConversationSummary(conversationId).computerTarget;
  const parsed = input ? parseComputerTarget(input) : null;
  if (input && !parsed) throw new Error("Invalid share target");
  const target = parsed ? await validateTarget(parsed) : null;
  const conversation = updateConversation(conversationId, { computerTarget: target });

  if (!sameComputerTarget(current, target)) {
    if (target) audit("user", "computer.share", computerTargetLabel(target), { conversationId, kind: target.kind });
    else if (current) audit("user", "computer.unshare", computerTargetLabel(current), { conversationId, kind: current.kind });
    // A running turn keeps what it was given only while the human keeps sharing exactly that.
    const runId = activeRunForConversation(conversationId);
    const rc = runId ? runComputer(runId) : null;
    if (rc && !sameComputerTarget(rc.target, target)) await detachComputer(rc.runId);
  }
  return conversation;
}
