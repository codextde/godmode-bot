import { useEffect, useRef } from "react";
import type { VoiceSettings } from "@godmode/shared";
import { fetchConversation } from "./chat-cache";
import { readAloud } from "./voice-mode";

/** Runs started by a dictated message. */
const spokenRuns = new Set<string>();

export const markVoiceRun = (runId: string) => void spokenRuns.add(runId);

/** A dictated message gets its reply read out when the run ends, unless Settings → Voice says otherwise. Like the desktop. */
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
    if (settings.current?.enabled === false || settings.current?.autoSpeak === false) return;
    void fetchConversation(conversationId)
      .then((chat) => {
        const reply = chat.messages.findLast((m) => m.role === "assistant" && m.runId === ended);
        if (reply?.content && !reply.blocks.some((b) => b.type === "error")) return readAloud(reply.content, settings.current, reply.content);
      })
      .catch(() => undefined);
  }, [conversationId, runId]);
}
