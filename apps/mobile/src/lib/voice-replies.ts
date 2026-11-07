import { useEffect, useRef } from "react";
import type { VoiceSettings } from "@godmode/shared";
import { fetchConversation } from "./chat-cache";
import { useChatPrefs } from "./chat-prefs";
import { readAloud } from "./voice-mode";

/** Runs started by a dictated message. */
const spokenRuns = new Set<string>();

export const markVoiceRun = (runId: string) => void spokenRuns.add(runId);

/** With Settings → General → Read replies aloud, a dictated message gets its reply read out when the run ends, if Settings → Voice agrees too. */
export function useSpokenReplies(conversationId: string, runId: string | undefined, voice: VoiceSettings | undefined) {
  const previous = useRef(runId);
  const settings = useRef(voice);
  useEffect(() => {
    settings.current = voice;
  }, [voice]);
  useEffect(() => {
    const ended = previous.current;
    previous.current = runId;
    if (!ended || ended === runId || !spokenRuns.delete(ended)) return;
    if (!useChatPrefs.getState().readReplies || !settings.current?.enabled || !settings.current.autoSpeak) return;
    void fetchConversation(conversationId)
      .then((chat) => {
        const reply = chat.messages.findLast((m) => m.role === "assistant" && m.runId === ended);
        if (reply?.content && !reply.blocks.some((b) => b.type === "error")) return readAloud(reply.content, settings.current, reply.content);
      })
      .catch(() => undefined);
  }, [conversationId, runId]);
}
