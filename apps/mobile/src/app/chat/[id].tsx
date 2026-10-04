import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { characterGreeting, type Agent, type ConversationWithMessages, type Message, type MessageBlock, type RetryMode, budgetPauseTitle, retryHelps, retryModeOf, runEndOf } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Composer, ComposerDock } from "@/components/composer";
import { HeaderActions } from "@/components/header-actions";
import { LiveStrip } from "@/components/live-strip";
import { AssistantMessage, UserMessage } from "@/components/message";
import { Icon } from "@/components/icon";
import { EmptyState, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { useAgents } from "@/lib/hooks";
import { useConversationRun, useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { subscribeConversation } from "@/lib/realtime";
import { screenHref, useChatScreens } from "@/lib/screens";
import { radius, space, useColors } from "@/lib/theme";

type Item =
  | { key: string; role: "intro" }
  | { key: string; role: "user"; message: Message }
  | { key: string; role: "assistant"; blocks: MessageBlock[]; content: string; streaming: boolean };

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  const list = useRef<FlashListRef<Item>>(null);
  const conversation = useQuery({ queryKey: qk.conversation(id), queryFn: () => api.conversations.get(id) });
  const { byId } = useAgents();
  const agent = conversation.data ? byId.get(conversation.data.agentId) : undefined;
  const run = useConversationRun(id);
  const draft = useLive((s) => s.drafts[id]);
  const screens = useChatScreens(conversation.data, agent);

  useEffect(() => subscribeConversation(id), [id]);

  const items = useMemo<Item[]>(() => {
    const messages = conversation.data?.messages ?? [];
    const live = run && draft && draft.runId === run.run.id ? draft : null;
    const out: Item[] = [{ key: "intro", role: "intro" }];
    for (const m of messages) {
      if (m.role === "user") out.push({ key: m.id, role: "user", message: m });
      else if (m.role === "assistant" && m.id !== live?.messageId) {
        out.push({ key: m.id, role: "assistant", blocks: m.blocks, content: m.content, streaming: !!run && m.runId === run.run.id });
      }
    }
    if (live) {
      out.push({ key: live.messageId, role: "assistant", blocks: live.blocks, content: "", streaming: true });
    } else if (run && run.run.status === "running" && !messages.some((m) => m.runId === run.run.id && m.role === "assistant")) {
      out.push({ key: `pending-${run.run.id}`, role: "assistant", blocks: [], content: "", streaming: true });
    }
    return out;
  }, [conversation.data, draft, run]);

  const send = async (content: string, files: PendingFile[]) => {
    try {
      const result = await api.conversations.send(id, content, await encodeFiles(files));
      queryClient.setQueryData<ConversationWithMessages>(qk.conversation(id), (old) =>
        old && !old.messages.some((m) => m.id === result.message.id) ? { ...old, messages: [...old.messages, result.message] } : old,
      );
      useLive.getState().runStarted(result.run);
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    } catch (err) {
      Alert.alert("Couldn't send", errorText(err));
      throw err;
    }
  };

  const stop = () => {
    if (run) void api.runs.cancel(run.run.id).catch((err) => Alert.alert("Couldn't stop", errorText(err)));
  };

  // The chat's run stands still (paused on the computer, or waiting for Claude's usage limit).
  const pause = conversation.data?.paused;
  const paused = (pause && pause.runId !== run?.run.id && pause) || null;
  const resume = () => {
    tap();
    api.conversations
      .continue(id)
      .then((continued) => useLive.getState().runStarted(continued))
      .catch((err) => Alert.alert("Couldn't continue", errorText(err)));
  };

  // The latest turn ended early (failed, stopped, cut off): one tap picks it up.
  const ended = !run && !paused && conversation.data ? endedTurn(conversation.data) : null;
  const retry = () => {
    if (!ended) return;
    tap();
    api.conversations
      .retry(id, ended.runId)
      .then((result) => {
        queryClient.setQueryData<ConversationWithMessages>(qk.conversation(id), (old) =>
          old && !old.messages.some((m) => m.id === result.message.id) ? { ...old, messages: [...old.messages, result.message] } : old,
        );
        useLive.getState().runStarted(result.run);
      })
      .catch((err) => Alert.alert("Couldn't pick this up", errorText(err)));
  };

  const title = conversation.data?.title || "Chat";
  const primary = screens[0];

  return (
    <>
      <Stack.Title>{title}</Stack.Title>
      {primary && <HeaderActions actions={[{ icon: "eye", label: "Watch the agent's screen", onPress: () => router.push(screenHref(primary)) }]} />}
      <KeyboardAvoidingView behavior="translate-with-padding" style={{ flex: 1 }}>
        <FlashList
          ref={list}
          data={items}
          keyExtractor={(item) => item.key}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.25 }}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 22 }} />}
          ListEmptyComponent={conversation.isError ? <EmptyState icon="warning" title="Couldn't open this chat" body={errorText(conversation.error)} /> : null}
          renderItem={({ item }) =>
            item.role === "intro" ? (
              agent ? <Intro agent={agent} conversationId={id} running={!!run} /> : null
            ) : item.role === "user" ? (
              <UserMessage message={item.message} />
            ) : (
              <AssistantMessage blocks={item.blocks} content={item.content} streaming={item.streaming} />
            )
          }
          getItemType={(item) => item.role}
        />
        {run && primary ? <LiveStrip screen={primary} activity={run.activity} /> : null}
        {paused?.reason === "question" ? (
          <AskingStrip agentName={agent?.name ?? "The agent"} approval={paused.question?.kind === "approval"} />
        ) : paused ? (
          <PausedStrip
            limit={paused.reason === "limit" ? (paused.limit ?? "usage limit") : null}
            held={paused.reason === "budget" && paused.budget ? budgetPauseTitle(paused.budget, agent?.name ?? "The agent", paused.pausedAt) : null}
            auto={paused.auto}
            onContinue={resume}
          />
        ) : ended ? (
          <EndedStrip mode={ended.mode} onRetry={retry} />
        ) : null}
        <ComposerDock>
          <Composer
            onSend={send}
            onStop={stop}
            attachments
            running={!!run}
            placeholder={agent ? (paused?.reason === "question" ? `Answer ${agent.name}` : `Message ${agent.name}`) : "Message"}
            disabled={agent ? !agent.enabled : false}
          />
        </ComposerDock>
        <View style={{ height: keyboardOpen ? space.sm : Math.max(insets.bottom, space.md) }} />
      </KeyboardAvoidingView>
    </>
  );
}

/** Above the composer while the chat's run waits for the human's answer: the reply in the composer is the answer. */
function AskingStrip({ agentName, approval }: { agentName: string; approval: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.paused, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
      <Icon name="warning" size={15} color={c.warning} />
      <T variant="footnote" style={{ flex: 1 }} numberOfLines={2}>
        {approval ? `${agentName} needs your OK — reply below` : `${agentName} is waiting for your answer — reply below`}
      </T>
    </View>
  );
}

/** Above the composer while the chat's run stands still. */
function PausedStrip({ limit, held, auto, onContinue }: { limit: string | null; held: string | null; auto: boolean; onContinue: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Icon name={limit || held ? "clock" : "pause"} size={15} color={limit || held ? c.warning : c.textMuted} />
      <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
        {held
          ? `${held} — raise the budget on your computer, or let it run.`
          : limit
            ? `Claude's ${limit} is reached${auto ? " — continues by itself after the reset" : ""}`
            : "Paused — continues where it stopped"}
      </T>
      <Pressable onPress={onContinue} hitSlop={10} accessibilityRole="button" accessibilityLabel={held ? "Let it run" : "Continue"}>
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          {held ? "Let it run" : limit ? "Try now" : "Continue"}
        </T>
      </Pressable>
    </View>
  );
}

/** The chat's last turn, when it ended early and trying again can help (not in a ticket's or a chat platform's chat). */
function endedTurn(conv: ConversationWithMessages): { runId: string; mode: RetryMode } | null {
  if (conv.origin === "task" || conv.origin === "dream" || conv.origin === "slack" || conv.origin === "telegram" || conv.origin === "teams") return null;
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role !== "assistant" || !last.runId) return null;
  const end = last.blocks[last.blocks.length - 1];
  const text = end?.type === "error" ? end.text : end?.type === "notice" && runEndOf(end.text) ? end.text : null;
  if (text === null || !retryHelps(runEndOf(text))) return null;
  return { runId: last.runId, mode: retryModeOf(last.blocks) === "continue" && conv.claudeSessionId ? "continue" : "again" };
}

/** Above the composer when the last turn ended early. */
function EndedStrip({ mode, onRetry }: { mode: RetryMode; onRetry: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Icon name="warning" size={15} color={c.textMuted} />
      <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
        {mode === "continue" ? "Stopped before it was done" : "Didn't get through"}
      </T>
      <Pressable onPress={onRetry} hitSlop={10} accessibilityRole="button" accessibilityLabel={mode === "continue" ? "Continue" : "Try again"}>
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          {mode === "continue" ? "Continue" : "Try again"}
        </T>
      </Pressable>
    </View>
  );
}

/** The agent at the top of the chat, saying hello in its own voice. */
function Intro({ agent, conversationId, running }: { agent: Agent; conversationId: string; running: boolean }) {
  const c = useColors();
  // The phone doesn't know the human's name, so the greeting says "there".
  const greeting = useMemo(
    () => characterGreeting({ name: agent.name, personality: agent.personality ?? "", seed: conversationId }),
    [agent.name, agent.personality, conversationId],
  );
  return (
    <View style={styles.intro}>
      <CharacterAvatar agent={agent} size={88} running={running} />
      <T variant="headline" style={{ marginTop: 4 }}>
        {agent.name}
      </T>
      <View style={[styles.bubble, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.tail, { backgroundColor: c.surface, borderColor: c.border }]} />
        <T variant="subhead" style={{ textAlign: "center" }}>
          {greeting}
        </T>
      </View>
      {agent.description ? (
        <T variant="footnote" muted style={{ textAlign: "center", maxWidth: 280, marginTop: 4 }} numberOfLines={3}>
          {agent.description}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  paused: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  intro: {
    alignItems: "center",
    gap: 6,
    paddingTop: space.xl,
    paddingBottom: 6,
  },
  bubble: {
    marginTop: 8,
    maxWidth: 300,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  tail: {
    position: "absolute",
    top: -6,
    alignSelf: "center",
    width: 12,
    height: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 3,
    transform: [{ rotate: "45deg" }],
  },
});
