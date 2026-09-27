import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceSettings } from "@godmode/shared";
import { toast } from "sonner";
import { useBootstrap } from "@/lib/hooks";
import {
  canSpeakInBrowser,
  speak as speakText,
  startDictation,
  stopSpeaking,
  useVoiceSession,
  voiceInputSupported,
  type DictationHandle,
} from "@/lib/voice";

/** Voice settings from the bootstrap payload (kept fresh by realtime invalidation). */
export function useVoiceSettings(): VoiceSettings | undefined {
  const { data } = useBootstrap();
  return data?.settings.voice;
}

export type DictationState = "idle" | "starting" | "listening" | "transcribing";

export interface UseDictationOptions {
  /** "dictation": listen until stopped. "conversation": end after one utterance (voice mode). */
  mode?: "dictation" | "conversation";
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  /** Defaults to an error toast. */
  onError?: (err: Error) => void;
}

/** Microphone dictation with live interim text (Web Speech) or record → transcribe on the core. */
export function useDictation(options: UseDictationOptions) {
  const settings = useVoiceSettings();
  const mode = options.mode ?? "dictation";
  const [state, setState] = useState<DictationState>("idle");
  const levelRef = useRef(0);
  const handleRef = useRef<DictationHandle | null>(null);
  const sessionRef = useRef(0);
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  const supported = useMemo(() => voiceInputSupported(), []);

  const start = useCallback(async () => {
    if (handleRef.current || !supported) return;
    const session = ++sessionRef.current;
    const current = () => sessionRef.current === session;
    setState("starting");
    try {
      const handle = await startDictation({
        settings,
        continuous: mode === "dictation",
        silenceMs: mode === "conversation" ? 1400 : undefined,
        onPhase: (p) => current() && setState(p),
        onInterim: (t) => current() && optsRef.current.onInterim?.(t),
        onLevel: (l) => {
          levelRef.current = l;
        },
        onFinal: (text) => {
          if (!current()) return;
          handleRef.current = null;
          levelRef.current = 0;
          setState("idle");
          optsRef.current.onFinal(text);
        },
        onError: (err) => {
          if (!current()) return;
          handleRef.current = null;
          levelRef.current = 0;
          setState("idle");
          (optsRef.current.onError ?? ((e: Error) => toast.error(e.message)))(err);
        },
      });
      if (current()) handleRef.current = handle;
      else handle.cancel();
    } catch (e) {
      if (!current()) return;
      handleRef.current = null;
      setState("idle");
      const err = e instanceof Error ? e : new Error(String(e));
      (optsRef.current.onError ?? ((x: Error) => toast.error(x.message)))(err);
    }
  }, [settings, mode, supported]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current++;
    handleRef.current?.cancel();
    handleRef.current = null;
    levelRef.current = 0;
    setState("idle");
  }, []);

  const toggle = useCallback(() => {
    if (handleRef.current) stop();
    else if (state === "idle") void start();
  }, [start, stop, state]);

  useEffect(
    () => () => {
      sessionRef.current++;
      handleRef.current?.cancel();
      handleRef.current = null;
    },
    [],
  );

  return { state, active: state !== "idle", listening: state === "listening", levelRef, supported, start, stop, cancel, toggle };
}

/** Text to speech with the configured provider; one speaker at a time app-wide. */
export function useSpeaker() {
  const settings = useVoiceSettings();
  const speakingKey = useVoiceSession((s) => s.speakingKey);
  const levelRef = useRef(0);

  const speak = useCallback(
    async (text: string, key?: string) => {
      try {
        await speakText(text, settings, {
          key,
          onLevel: (l) => {
            levelRef.current = l;
          },
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not read this aloud.");
      }
    },
    [settings],
  );

  const stop = useCallback(() => stopSpeaking(), []);

  const supported = (settings?.ttsProvider ?? "browser") !== "browser" || canSpeakInBrowser();

  return { speak, stop, speakingKey, speaking: speakingKey !== null, levelRef, supported };
}
