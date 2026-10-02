import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { characterGreeting, type Agent, type ConversationWithMessages, type Message, type MessageBlock, type QueuedMessage } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Composer, ComposerDock, type ComposerHandle, type ComposerInput } from "@/components/composer";
import { HeaderActions } from "@/components/header-actions";
import { LiveStrip } from "@/components/live-strip";
import { AssistantMessage, UserMessage } from "@/components/message";
import { Icon } from "@/components/icon";
import { ModelButton } from "@/components/model-button";
import { QueueTray } from "@/components/queue-tray";
import { EmptyState, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { setQueue } from "@/lib/composer";
import { newQueueId, pendingQueued, withPending } from "@/lib/pending-queue";
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
  const composer = useRef<ComposerHandle>(null);

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

  // The chat's run stands still (paused on the computer, or waiting for Claude's usage limit).
  const pause = conversation.data?.paused;
  const paused = (pause && pause.runId !== run?.run.id && pause) || null;
  const queue = conversation.data?.queue ?? [];
  // While the agent works, is paused or older messages still wait, a new message joins the queue.
  const queueing = !!run || !!paused || queue.length > 0;

  const send = async ({ content, attachments }: ComposerInput) => {
    const key = qk.conversation(id);
    const queueId = newQueueId();
    const tempId = `pending-${queueId}`;
    await queryClient.cancelQueries({ queryKey: key });
    const draft = {
      conversationId: id,
      content,
      attachments: attachments.map((a) => ({ name: a.name, mime: a.mime, path: "", size: Math.round((a.data.length * 3) / 4) })),
      createdAt: new Date().toISOString(),
    };
    if (queueing) {
      pendingQueued.set(queueId, { ...draft, id: queueId });
      setQueue(id, (q) => withPending(id, q));
    } else {
      queryClient.setQueryData<ConversationWithMessages>(key, (old) =>
        old ? { ...old, messages: [...old.messages, { ...draft, id: tempId, role: "user", blocks: [], runId: null }] } : old,
      );
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    }
    try {
      const result = await api.conversations.send(id, { content, attachments, queueId });
      pendingQueued.delete(queueId);
      if ("queued" in result) {
        queryClient.setQueryData<ConversationWithMessages>(key, (old) => {
          if (!old) return old;
          const messages = old.messages.filter((m) => m.id !== tempId);
          const shown = old.queue.some((m) => m.id === queueId);
          return { ...old, messages, queue: shown ? old.queue.map((m) => (m.id === queueId ? result.queued : m)) : [...old.queue, result.queued] };
        });
        // Also settles the queue when the agent took the message before this answer arrived.
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      queryClient.setQueryData<ConversationWithMessages>(key, (old) => {
        if (!old) return old;
        const messages = old.messages.filter((m) => m.id !== tempId);
        return {
          ...old,
          queue: old.queue.filter((m) => m.id !== queueId),
          messages: messages.some((m) => m.id === result.message.id) ? messages : [...messages, result.message],
        };
      });
      useLive.getState().runStarted(result.run);
      void queryClient.invalidateQueries({ queryKey: key });
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    } catch (err) {
      pendingQueued.delete(queueId);
      queryClient.setQueryData<ConversationWithMessages>(key, (old) =>
        old ? { ...old, messages: old.messages.filter((m) => m.id !== tempId), queue: old.queue.filter((m: QueuedMessage) => m.id !== queueId) } : old,
      );
      Alert.alert("Message not sent", errorText(err));
      throw err;
    }
  };

  const onLost = useCallback((text: string) => composer.current?.insert(text), []);

  const stop = () => {
    if (run) void api.runs.cancel(run.run.id).catch((err) => Alert.alert("Couldn't stop", errorText(err)));
  };

  const resume = () => {
    tap();
    api.conversations
      .continue(id)
      .then((continued) => useLive.getState().runStarted(continued))
      .catch((err) => Alert.alert("Couldn't continue", errorText(err)));
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
        {paused ? <PausedStrip limit={paused.reason === "limit" ? (paused.limit ?? "usage limit") : null} auto={paused.auto} onContinue={resume} /> : null}
        <QueueTray
          conversationId={id}
          queue={queue}
          agentName={agent?.name ?? "The agent"}
          running={!!run && !paused}
          paused={paused?.reason ?? null}
          onLost={onLost}
        />
        <ComposerDock>
          <Composer
            ref={composer}
            draftKey={id}
            agentId={conversation.data?.agentId}
            attachments
            onSend={send}
            onStop={stop}
            running={!!run && !paused}
            sendLabel={paused ? (paused.reason === "limit" ? "Queue message" : "Send and continue") : queueing ? "Queue message" : null}
            placeholder={
              !agent
                ? "Message"
                : paused?.reason === "user"
                  ? `Tell ${agent.name} how to go on`
                  : paused
                    ? `Message ${agent.name} — goes along after the reset`
                    : run
                      ? `Queue a message for ${agent.name}`
                      : `Message ${agent.name}, or / for commands`
            }
            disabled={agent ? !agent.enabled : false}
            trailing={
              conversation.data ? (
                <ModelButton agent={agent} conversationId={id} choice={{ model: conversation.data.model ?? null, effort: conversation.data.effort ?? null }} />
              ) : null
            }
          />
        </ComposerDock>
        <View style={{ height: keyboardOpen ? space.sm : Math.max(insets.bottom, space.md) }} />
      </KeyboardAvoidingView>
    </>
  );
}

/** Above the composer while the chat's run stands still. */
function PausedStrip({ limit, auto, onContinue }: { limit: string | null; auto: boolean; onContinue: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Icon name={limit ? "clock" : "pause"} size={15} color={limit ? c.warning : c.textMuted} />
      <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
        {limit ? `Claude's ${limit} is reached${auto ? " — continues by itself after the reset" : ""}` : "Paused — continues where it stopped"}
      </T>
      <Pressable onPress={onContinue} hitSlop={10} accessibilityRole="button" accessibilityLabel="Continue">
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          {limit ? "Try now" : "Continue"}
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
