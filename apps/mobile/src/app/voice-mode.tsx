import { useQuery } from "@tanstack/react-query";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CharacterMood, Message } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Icon } from "@/components/icon";
import { Button, GlassIconButton, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { askToListen, listenTurn, mayListen, phoneCanDictate, speechLocale, type Listening } from "@/lib/dictation";
import { useAgents } from "@/lib/hooks";
import { useChatRun, useLive, useRunActivity } from "@/lib/live";
import { newQueueId } from "@/lib/pending-queue";
import { qk, queryClient } from "@/lib/query";
import { subscribeConversation } from "@/lib/realtime";
import { useSettings } from "@/lib/setup";
import { alpha, radius, space, useColors } from "@/lib/theme";
import { forSpeech, replyKey, replyText, speak, stopReading, type Speech } from "@/lib/voice-mode";

type Phase = "listening" | "sending" | "thinking" | "speaking" | "paused" | "denied" | "unavailable";

/** The agent's face during a voice conversation: all ears, pondering, then beaming while it answers. */
const MOOD: Record<Phase, CharacterMood> = {
  listening: "idle",
  sending: "thinking",
  thinking: "thinking",
  speaking: "happy",
  paused: "sleeping",
  denied: "sleeping",
  unavailable: "sleeping",
};

/** Three turns with nothing said in a row: it stops listening until the human taps. */
const MAX_EMPTY_TURNS = 3;
/** A run that ended without a reply landing: the conversation goes on after this long. */
const REPLY_WAIT_MS = 6_000;
/** Nothing was said: not a failure, the next round listens again. */
const QUIET_ERRORS = new Set(["no-speech", "speech-timeout", "aborted"]);

/**
 * Hands-free voice conversation in a chat, like the desktop's voice mode: the phone listens, sends what was said when you
 * pause, and reads the reply out with the computer's voice (OpenAI or ElevenLabs) or, set to "browser", one of its own.
 */
export default function VoiceMode() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const insets = useSafeAreaInsets();
  useKeepAwake();
  const { conversationId: id } = useLocalSearchParams<{ conversationId: string }>();
  const conversation = useQuery({ queryKey: qk.conversation(id), queryFn: () => fetchConversation(id) });
  const agent = useAgents().byId.get(conversation.data?.agentId ?? "");
  const run = useChatRun(id);
  const activity = useRunActivity(run?.id);
  const voice = useSettings().data?.voice;
  const messages = conversation.data?.messages;
  const last = messages?.[messages.length - 1];

  const [phase, setPhase] = useState<Phase>(() => (!phoneCanDictate() ? "unavailable" : run ? "thinking" : "listening"));
  /** A new round of listening with the same phase (nothing was heard). */
  const [turn, setTurn] = useState(0);
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  useLayoutEffect(() => {
    phaseRef.current = phase;
  });
  const empties = useRef(0);
  const listening = useRef<Listening | null>(null);
  const speech = useRef<Speech | null>(null);
  /** Replies spoken or from before this conversation started. */
  const handled = useRef(new Set<string>());
  const seeded = useRef(false);
  const level = useSharedValue(0);

  useEffect(() => subscribeConversation(id), [id]);
  useEffect(() => stopReading(), []);

  // What was already there isn't read out.
  useEffect(() => {
    if (seeded.current || !messages) return;
    seeded.current = true;
    for (const m of messages) if (m.role === "assistant") handled.current.add(replyKey(m));
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      setHeard(text);
      setReply("");
      setPhase("sending");
      try {
        const result = await api.conversations.send(id, { content: text, attachments: [], queueId: newQueueId() });
        if ("run" in result && result.run) useLive.getState().runStarted(result.run);
        void queryClient.invalidateQueries({ queryKey: qk.conversation(id) });
        setPhase((p) => (p === "sending" ? "thinking" : p));
      } catch (err) {
        Alert.alert(t("voiceMode.sendFailed"), errorText(err));
        setPhase("paused");
      }
    },
    [id, t],
  );

  // Asks once for the microphone and speech recognition; the first round of listening waits for the answer.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (phaseRef.current === "unavailable") return;
    askToListen().then(
      ({ granted }) => {
        setAllowed(granted);
        if (!granted) setPhase("denied");
      },
      () => {
        setAllowed(false);
        setPhase("unavailable");
      },
    );
  }, []);

  // Back from the phone's Settings with the microphone allowed: the conversation starts.
  useEffect(() => {
    if (phase !== "denied") return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      mayListen().then(
        ({ granted }) => {
          if (!granted) return;
          setAllowed(true);
          setPhase("listening");
        },
        () => undefined,
      );
    });
    return () => sub.remove();
  }, [phase]);

  // Hands-free loop: listens whenever it is in the listening phase, and ends the turn when the human pauses.
  const tag = voice?.language ?? "";
  useEffect(() => {
    if (phase !== "listening" || !allowed) return;
    let dropped = false;
    void speechLocale(tag).then((lang) => {
      if (dropped) return;
      listening.current = listenTurn(lang, {
        onLevel: (l) => {
          level.value = withTiming(l, { duration: 100 });
        },
        onWords: setHeard,
        onEnd: (result) => {
          listening.current = null;
          level.value = withTiming(0, { duration: 150 });
          if (dropped || phaseRef.current !== "listening") return;
          const text = result.text.trim();
          if (text) {
            empties.current = 0;
            void send(text);
            return;
          }
          // Silence goes round again; a recognizer that can't run says so instead of retrying in vain.
          if (result.error && !QUIET_ERRORS.has(result.error.code)) {
            setProblem(result.error.message);
            setPhase("paused");
            return;
          }
          empties.current += 1;
          if (empties.current >= MAX_EMPTY_TURNS) setPhase("paused");
          else setTurn((n) => n + 1);
        },
      });
    });
    return () => {
      dropped = true;
      listening.current?.abort();
      listening.current = null;
    };
  }, [phase, turn, allowed, tag, send, level]);

  // The reply: once the run ended and its message landed.
  const onReply = useEffectEvent((m: Message) => {
    handled.current.add(replyKey(m));
    const text = forSpeech(replyText(m));
    setReply(text);
    if (!text) {
      setPhase("listening");
      return;
    }
    setPhase("speaking");
    const said = speak(text, voice, true);
    speech.current = said;
    said.done
      .catch((err: unknown) => Alert.alert(t("voiceMode.playFailed"), errorText(err)))
      .finally(() => {
        speech.current = null;
        if (phaseRef.current === "speaking") setPhase("listening");
      });
  });
  useEffect(() => {
    if (phase !== "thinking" || run) return;
    if (!last || last.role !== "assistant" || handled.current.has(replyKey(last))) {
      void queryClient.invalidateQueries({ queryKey: qk.conversation(id) });
      const timer = setTimeout(() => phaseRef.current === "thinking" && setPhase("listening"), REPLY_WAIT_MS);
      return () => clearTimeout(timer);
    }
    onReply(last);
  }, [phase, run, last, id]);

  useEffect(
    () => () => {
      speech.current?.stop();
      listening.current?.abort();
    },
    [],
  );

  const resume = () => {
    empties.current = 0;
    setProblem(null);
    setHeard("");
    setPhase("listening");
  };
  /** Talk or interrupt: ends the turn now, cuts the voice short, or wakes it up. */
  const onOrb = () => {
    tap();
    if (phase === "listening") listening.current?.stop();
    else if (phase === "speaking") speech.current?.stop();
    else if (phase === "paused") resume();
  };
  const toggleMute = () => {
    tap();
    if (phase === "paused") resume();
    else if (phase === "listening") setPhase("paused");
  };
  const stopAgent = () => {
    tap();
    if (run) void api.runs.cancel(run.id).catch((err) => Alert.alert(t("thread.stopFailed"), errorText(err)));
  };

  const status =
    phase === "listening"
      ? t("voiceMode.listening")
      : phase === "sending"
        ? t("voiceMode.sending")
        : phase === "thinking"
          ? (activity ?? t("voiceMode.thinking"))
          : phase === "speaking"
            ? t("voiceMode.speaking")
            : phase === "paused"
              ? (problem ?? t("voiceMode.paused"))
              : phase === "denied"
                ? t("voiceMode.denied")
                : t("voiceMode.unavailable");
  const canTalk = phase === "listening" || phase === "paused";

  return (
    <View style={[styles.root, { backgroundColor: c.background, paddingTop: insets.top + space.md, paddingBottom: Math.max(insets.bottom, space.lg) }]}>
      <View style={styles.head}>
        <T variant="headline" numberOfLines={1} style={{ flex: 1 }}>
          {agent?.name ?? t("voiceMode.title")}
        </T>
        <GlassIconButton icon="close" label={t("voiceMode.end")} onPress={() => router.back()} size={40} />
      </View>

      <View style={styles.middle}>
        <Orb level={level} onPress={onOrb} label={status} active={phase === "listening" || phase === "speaking"}>
          <CharacterAvatar agent={agent} size={128} mood={MOOD[phase]} />
        </Orb>
        <T variant="subhead" muted style={{ textAlign: "center" }} accessibilityLiveRegion="polite" numberOfLines={3}>
          {status}
        </T>
        <ScrollView style={{ alignSelf: "stretch" }} contentContainerStyle={styles.texts}>
          {heard ? (
            <T variant="title" color={phase === "listening" ? c.text : c.textMuted} style={{ textAlign: "center" }}>
              {heard}
            </T>
          ) : null}
          {reply ? (
            <T variant="body" style={{ textAlign: "center" }} selectable>
              {reply}
            </T>
          ) : null}
        </ScrollView>
      </View>

      {phase === "denied" ? (
        <Button title={t("voiceMode.openSettings")} variant="secondary" onPress={() => void Linking.openSettings()} />
      ) : phase === "unavailable" ? null : (
        <View style={styles.controls}>
          <GlassIconButton icon={phase === "paused" ? "mic" : "pause"} label={phase === "paused" ? t("voiceMode.resume") : t("voiceMode.pause")} onPress={toggleMute} disabled={!canTalk} size={56} />
          {run ? <GlassIconButton icon="stop" label={t("voiceMode.stopAgent")} onPress={stopAgent} size={56} /> : null}
        </View>
      )}
    </View>
  );
}

/** The agent in a soft ring that breathes with the voice; tap to talk or interrupt. */
function Orb({ level, onPress, label, active, children }: { level: SharedValue<number>; onPress: () => void; label: string; active: boolean; children: ReactNode }) {
  const c = useColors();
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(1 + level.value * 0.28, { damping: 14, stiffness: 180 }) }], opacity: active ? 1 : 0.45 }));
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.orb}>
      <Animated.View style={[styles.ring, { backgroundColor: alpha(c.brand, 0.14), borderColor: alpha(c.brand, 0.28) }, ring]} />
      {children}
      {active ? null : (
        <View style={[styles.mic, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Icon name="mic" size={14} color={c.textMuted} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.xl, gap: space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg },
  orb: { width: 240, height: 240, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 200, height: 200, borderRadius: 100, borderWidth: StyleSheet.hairlineWidth },
  mic: { position: "absolute", bottom: 36, right: 52, width: 30, height: 30, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  texts: { flexGrow: 1, justifyContent: "center", gap: space.md, paddingVertical: space.sm },
  controls: { flexDirection: "row", justifyContent: "center", gap: space.xl },
});
