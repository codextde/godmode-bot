import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, Message } from "@godmode/shared";
import { Mic, MicOff, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Backdrop } from "@/components/brand";
import { AgentAvatar, Kbd } from "@/components/common";
import { LiveDot } from "@/components/aicss/Motion";
import { useDictation, useVoiceSettings } from "@/hooks/use-voice";
import { speak, stopSpeaking, useVoiceSession, voiceInputSupported } from "@/lib/voice";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { VoiceOrb, type VoiceOrbPhase } from "./voice-visuals";

type Phase = VoiceOrbPhase | "waiting";

/** Assistant replies already spoken (or deliberately skipped) this session — survives remounts. */
const handled = new Set<string>();

export interface VoiceModeProps {
  agent?: Agent;
  /** A run is in flight for the current conversation */
  busy: boolean;
  /** Live activity label (e.g. "Opened github.com") */
  activity?: string | null;
  /** Latest message of the conversation (to speak the reply once it lands) */
  lastMessage?: Message | null;
  /** Send the transcript (start a chat or post into the conversation). */
  onSend: (text: string) => Promise<void>;
  /** Cancel the current run */
  onStop?: () => void;
}

/** Renders the voice-mode overlay when the user switched it on during this session. */
export function VoiceMode(props: VoiceModeProps) {
  const voiceMode = useUi((s) => s.voiceMode);
  const setVoiceMode = useUi((s) => s.setVoiceMode);
  const armed = useVoiceSession((s) => s.armed);

  // voiceMode is persisted by the UI store — never reopen it by itself after a reload.
  useEffect(() => {
    if (voiceMode && !armed) setVoiceMode(false);
  }, [voiceMode, armed, setVoiceMode]);

  return <AnimatePresence>{voiceMode && armed && <VoiceModeOverlay {...props} />}</AnimatePresence>;
}

function replyText(m: Message): string {
  if (m.content.trim()) return m.content;
  const text = m.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
  if (text.trim()) return text;
  if (m.blocks.some((b) => b.type === "error")) return "Sorry, something went wrong with that one.";
  return "";
}

function VoiceModeOverlay({ agent, busy, activity, lastMessage, onSend, onStop }: VoiceModeProps) {
  const setVoiceMode = useUi((s) => s.setVoiceMode);
  const arm = useVoiceSession((s) => s.arm);
  const voiceRunIds = useVoiceSession((s) => s.voiceRunIds);
  const settings = useVoiceSettings();
  const supported = voiceInputSupported();

  const [phase, setPhase] = useState<Phase>(() => {
    const pendingReply =
      !busy && lastMessage?.role === "assistant" && !!lastMessage.runId && !!voiceRunIds[lastMessage.runId] && !handled.has(lastMessage.id);
    if (!busy && !pendingReply && lastMessage?.role === "assistant") handled.add(lastMessage.id);
    return busy || pendingReply ? "thinking" : supported ? "listening" : "paused";
  });
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const emptyStreak = useRef(0);
  const speakLevel = useRef(0);
  const levelRef = useRef(0);
  const orbWrap = useRef<HTMLDivElement>(null);

  const dictation = useDictation({
    mode: "conversation",
    onInterim: (t) => setTranscript(t),
    onFinal: async (t) => {
      if (phaseRef.current !== "listening") return;
      const text = t.trim();
      if (!text) {
        emptyStreak.current += 1;
        if (emptyStreak.current >= 3) {
          setPhase("paused");
        } else {
          setPhase("waiting");
          setTimeout(() => phaseRef.current === "waiting" && setPhase("listening"), 350);
        }
        return;
      }
      emptyStreak.current = 0;
      setTranscript(text);
      setReply("");
      setPhase("sending");
      try {
        await onSend(text);
        setPhase((p) => (p === "sending" ? "thinking" : p));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't send your message.");
        setPhase("paused");
      }
    },
    onError: (e) => {
      toast.error(e.message);
      setPhase("paused");
    },
  });

  // Listen whenever we're in the listening phase and the mic is idle (hands-free loop).
  useEffect(() => {
    if (phase === "listening" && dictation.state === "idle") void dictation.start();
  }, [phase, dictation.state, dictation.start]);

  // Speak the reply once the run finished and the assistant message landed.
  useEffect(() => {
    if (phase !== "thinking" || busy) return;
    const m = lastMessage;
    if (!m || m.role !== "assistant" || handled.has(m.id)) {
      const t = setTimeout(() => {
        if (phaseRef.current === "thinking") setPhase("listening");
      }, 6000);
      return () => clearTimeout(t);
    }
    handled.add(m.id);
    const text = replyText(m);
    if (!text) {
      setPhase("listening");
      return;
    }
    setReply(text);
    setPhase("speaking");
    speak(text, settings, {
      key: `voice:${m.id}`,
      onLevel: (l) => {
        speakLevel.current = l;
      },
    })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't play the reply."))
      .finally(() => {
        speakLevel.current = 0;
        if (phaseRef.current === "speaking") setPhase("listening");
      });
  }, [phase, busy, lastMessage, settings]);

  // Feed the orb with the right level source
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      levelRef.current = phaseRef.current === "speaking" ? speakLevel.current : dictation.levelRef.current;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dictation.levelRef]);

  const close = useCallback(() => {
    dictation.cancel();
    stopSpeaking();
    arm(false);
    setVoiceMode(false);
  }, [dictation, arm, setVoiceMode]);

  const onOrb = useCallback(() => {
    const p = phaseRef.current;
    if (p === "listening") {
      if (dictation.active) dictation.stop();
    } else if (p === "speaking") {
      stopSpeaking();
    } else if (p === "paused" || p === "waiting") {
      emptyStreak.current = 0;
      setTranscript("");
      setPhase("listening");
    }
  }, [dictation]);

  const toggleMute = () => {
    if (phase === "paused") {
      emptyStreak.current = 0;
      setPhase("listening");
    } else if (phase === "listening" || phase === "waiting") {
      dictation.cancel();
      setPhase("paused");
    }
  };

  // Keyboard: Esc exits, Space talks / interrupts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        onOrb();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, onOrb]);

  useEffect(() => {
    orbWrap.current?.querySelector("button")?.focus();
    return () => stopSpeaking();
  }, []);

  const shownPhase: VoiceOrbPhase =
    phase === "waiting" ? "listening" : phase === "listening" && dictation.state === "transcribing" ? "transcribing" : phase;

  const status = !supported
    ? "Voice input isn't supported here"
    : {
        listening: dictation.state === "starting" ? "Starting microphone…" : "Listening…",
        transcribing: "Transcribing…",
        sending: "Sending…",
        thinking: activity ? `${activity}` : "Thinking…",
        speaking: "Speaking — tap to interrupt",
        paused: "Paused — tap the orb to talk",
      }[shownPhase];

  const muted = phase === "paused";

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Voice mode"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-background"
    >
      <Backdrop />
      <div className="relative flex items-center justify-between gap-3 px-5 pt-5 sm:px-8 sm:pt-7">
        <div className="flex min-w-0 items-center gap-2.5">
          {agent && <AgentAvatar agent={agent} size="md" />}
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium tracking-[-0.01em]">{agent?.name ?? "Godmode"}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <LiveDot live={shownPhase === "listening"} />
              Voice mode
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            <Kbd>Esc</Kbd> to exit
          </span>
          <Button variant="ghost" size="icon" onClick={close} aria-label="Exit voice mode">
            <X />
          </Button>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center gap-10 px-6">
        <motion.div ref={orbWrap} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 18 }}>
          <VoiceOrb phase={shownPhase} levelRef={levelRef} onClick={onOrb} label={status} />
        </motion.div>

        <div className="flex min-h-40 w-full max-w-2xl flex-col items-center gap-4 text-center">
          <AnimatePresence mode="wait">
            <motion.p
              key={shownPhase + (shownPhase === "thinking" ? activity ?? "" : "")}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className={cn(
                "text-sm font-medium text-muted-foreground",
                (shownPhase === "thinking" || shownPhase === "transcribing" || shownPhase === "sending") && "text-shimmer",
              )}
              aria-live="polite"
            >
              {status}
            </motion.p>
          </AnimatePresence>
          {transcript && (
            <p
              className={cn(
                "text-[26px] leading-[1.2] font-medium tracking-[-0.03em] text-balance sm:text-[32px]",
                shownPhase !== "listening" && "text-foreground/40",
              )}
            >
              “{transcript}”
            </p>
          )}
          {reply && shownPhase === "speaking" && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="line-clamp-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
              {reply.replace(/[#*_`>]/g, "")}
            </motion.p>
          )}
        </div>
      </div>

      <div className="relative flex flex-col items-center gap-3 pb-8 sm:pb-10">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon-lg"
            onClick={toggleMute}
            disabled={!supported || !(phase === "paused" || phase === "listening" || phase === "waiting")}
            aria-label={muted ? "Resume listening" : "Pause listening"}
            aria-pressed={muted}
            className={cn("size-12 rounded-xl shadow-card", muted && "border-destructive/30 bg-destructive/[0.06] text-destructive hover:bg-destructive/10 hover:text-destructive")}
          >
            {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </Button>
          {busy && onStop && (
            <Button variant="outline" size="icon-lg" onClick={onStop} aria-label="Stop the agent" className="size-12 rounded-xl shadow-card">
              <Square className="size-4 fill-current" />
            </Button>
          )}
          <Button variant="destructive" size="icon-lg" onClick={close} aria-label="End voice mode" className="size-12 rounded-xl">
            <X className="size-5" />
          </Button>
        </div>
        <p className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
          <Kbd>Space</Kbd> talk / interrupt · <Kbd>Esc</Kbd> exit
        </p>
      </div>
    </motion.div>
  );
}
