import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  characterGreeting,
  type Agent,
  type ConversationFollowup,
  type ConversationWithMessages,
  type HumanTask,
  type Message,
  type MessageBlock,
  type QueuedMessage,
  type RetryMode,
  budgetPauseTitle,
  retryHelps,
  retryModeOf,
  runEndOf,
} from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Composer, ComposerDock, type ComposerHandle } from "@/components/composer";
import { HeaderActions, MenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { LiveStrip } from "@/components/live-strip";
import { AssistantMessage, UserMessage } from "@/components/message";
import { Icon } from "@/components/icon";
import { ModelButton } from "@/components/model-button";
import { ContextRing } from "@/components/context-ring";
import { ChatScope, type ChatScopeValue } from "@/components/question-card";
import { QueueTray } from "@/components/queue-tray";
import { Button, ErrorState, Skeleton, T, tap } from "@/components/ui";
import { openHumanTask } from "@/components/human-task-row";
import { ApiError, api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { fetchConversation, loadEarlier } from "@/lib/chat-cache";
import { isCompressCommand, useContextGauge } from "@/lib/chat-memory";
import { setQueue } from "@/lib/composer";
import { whenText } from "@/lib/format";
import { newQueueId, pendingQueued, withPending } from "@/lib/pending-queue";
import { useAgents } from "@/lib/hooks";
import { useChatRun, useLive, useRunActivity } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { subscribeConversation, viewConversation } from "@/lib/realtime";
import { screenHref, useChatScreens, type LiveScreen } from "@/lib/screens";
import { radius, space, type, useColors } from "@/lib/theme";

type Item =
  | { key: string; role: "intro" }
  | { key: string; role: "earlier" }
  | { key: string; role: "user"; message: Message }
  | { key: string; role: "assistant"; blocks: MessageBlock[]; content: string; streaming: boolean }
  | { key: string; role: "live" }
  | { key: string; role: "note"; content: string };

const NO_BLOCKS: MessageBlock[] = [];
/** What marks a place in the chat where it went on without the human writing. */
const MARKERS = new Set<MessageBlock["type"]>(["human_task", "followup", "retry", "call", "moved"]);

/** A stored message's row, the same object for as long as the message is: rows that didn't change don't render again. */
const settled = new WeakMap<Message, Item | null>();

function itemOf(m: Message): Item | null {
  let item = settled.get(m);
  if (item !== undefined) return item;
  if (m.role === "user") item = { key: m.id, role: "user", message: m };
  else if (m.role === "assistant") item = { key: m.id, role: "assistant", blocks: m.blocks, content: m.content, streaming: false };
  else {
    const markers = m.blocks.filter((b) => MARKERS.has(b.type));
    item = markers.length
      ? { key: m.id, role: "assistant", blocks: markers, content: "", streaming: false }
      : m.content.trim()
        ? { key: m.id, role: "note", content: m.content.trim() }
        : null;
  }
  settled.set(m, item);
  return item;
}

const Gap = () => <View style={{ height: 22 }} />;

function SystemNote({ content }: { content: string }) {
  const c = useColors();
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ maxWidth: "80%", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 5 }}>
        <T variant="caption" muted style={{ textAlign: "center" }}>
          {content}
        </T>
      </View>
    </View>
  );
}

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  const list = useRef<FlashListRef<Item>>(null);
  const conversation = useQuery({ queryKey: qk.conversation(id), queryFn: () => fetchConversation(id) });
  const forYou = useQuery({ queryKey: qk.chatHumanTasks(id), queryFn: () => api.humanTasks.list({ status: "active", conversationId: id }) });
  const { byId } = useAgents();
  const agent = conversation.data ? byId.get(conversation.data.agentId) : undefined;
  const run = useChatRun(id);
  const activity = useRunActivity(run?.id);
  // Only which message streams: its text lives in the row that shows it, so the screen doesn't render with every word.
  const liveMessageId = useLive((s) => (run && s.drafts[id]?.runId === run.id ? s.drafts[id]!.messageId : null));
  const screens = useChatScreens(conversation.data, agent);
  const composer = useRef<ComposerHandle>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => subscribeConversation(id), [id]);
  // Read while it is the screen in front (not while another screen covers it).
  useFocusEffect(
    useCallback(() => {
      viewConversation(id);
      return () => viewConversation(null);
    }, [id]),
  );

  const messages = conversation.data?.messages;
  const hasMore = !!conversation.data?.hasMore;
  const runId = run?.id;
  const running = run?.status === "running";
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [hasMore ? { key: "earlier", role: "earlier" } : { key: "intro", role: "intro" }];
    let answered = false;
    for (const m of messages ?? []) {
      if (m.id === liveMessageId) continue;
      const item = itemOf(m);
      if (!item) continue;
      if (runId && m.role === "assistant" && m.runId === runId) {
        answered = true;
        out.push({ ...item, streaming: true } as Item);
      } else out.push(item);
    }
    if (liveMessageId || (running && !answered)) out.push({ key: liveMessageId ?? `pending-${runId}`, role: "live" });
    return out;
  }, [messages, hasMore, liveMessageId, runId, running]);

  // The chat's run stands still (paused on the computer, or waiting for Claude's usage limit).
  const pause = conversation.data?.paused;
  const paused = (pause && pause.runId !== run?.id && pause) || null;
  const queue = conversation.data?.queue ?? [];
  // The run waits for the human's answer to a question: the next message is that answer.
  const waiting = paused?.reason === "question";
  // While the agent works, is paused or older messages still wait, a new message joins the queue.
  const queueing = !waiting && (!!run || !!paused || queue.length > 0);
  const followup = !run && !paused ? (conversation.data?.followup ?? null) : null;
  // Chat memory: the ring next to the model, and a strip once the chat gets long (hidden until it grows further).
  const gauge = useContextGauge(conversation.data?.context);
  const compressing = (!!run && (activity ?? "").startsWith("Compressing")) || queue.some((m) => isCompressCommand(m.content));
  const [compressHiddenAt, setCompressHiddenAt] = useState<number | null>(null);
  const longChat =
    !!gauge && gauge.tone !== "calm" && gauge.compressible && !compressing && (compressHiddenAt === null || gauge.tokens > compressHiddenAt * 1.2) ? gauge : null;

  const scope = useMemo<ChatScopeValue>(
    () => ({ conversationId: id, agentName: agent?.name ?? "The agent", openQuestionId: (pause?.reason === "question" && pause.question?.id) || null }),
    [id, agent?.name, pause],
  );

  const send = async (content: string, files: PendingFile[]) => {
    const key = qk.conversation(id);
    const queueId = newQueueId();
    const tempId = `pending-${queueId}`;
    const draft = {
      conversationId: id,
      content,
      attachments: files.map((f) => ({ name: f.name, mime: f.mime, path: "", size: f.size })),
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
      const result = await api.conversations.send(id, { content, attachments: await encodeFiles(files), queueId });
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
      if ("question" in result) {
        // It answered the agent's question: the run that asked continues with it.
        queryClient.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, messages: old.messages.filter((m) => m.id !== tempId) } : old));
        useLive.getState().runStarted(result.run);
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
    if (run) void api.runs.cancel(run.id).catch((err) => Alert.alert("Couldn't stop", errorText(err)));
  };

  const resume = () => {
    tap();
    api.conversations
      .continue(id)
      .then((continued) => useLive.getState().runStarted(continued))
      .catch((err) => Alert.alert("Couldn't continue", errorText(err)));
  };

  // The latest turn ended early (failed, stopped, cut off): one tap picks it up — when nothing else would happen first.
  const [retrying, setRetrying] = useState(false);
  const ended = !run && !paused && conversation.data && agent?.enabled !== false ? endedTurn(conversation.data) : null;
  const retry = () => {
    if (!ended || retrying) return;
    tap();
    setRetrying(true);
    api.conversations
      .retry(id, ended.runId)
      .then((result) => {
        queryClient.setQueryData<ConversationWithMessages>(qk.conversation(id), (old) =>
          old && !old.messages.some((m) => m.id === result.message.id) ? { ...old, messages: [...old.messages, result.message] } : old,
        );
        useLive.getState().runStarted(result.run);
      })
      .catch((err) => {
        // Something else moved the chat on (another tap, the computer): show that instead of an error.
        if (err instanceof ApiError && err.code === "stale") void queryClient.invalidateQueries({ queryKey: qk.conversation(id) });
        else Alert.alert("Couldn't pick this up", errorText(err));
      })
      .finally(() => setRetrying(false));
  };

  const change = (patch: { title?: string; pinned?: boolean; archived?: boolean }) =>
    api.conversations
      .update(id, patch)
      .then((next) => {
        // Only what changed: a runner's chat answers with every message.
        queryClient.setQueryData<ConversationWithMessages>(qk.conversation(id), (old) => (old ? { ...old, title: next.title, pinned: next.pinned, archived: next.archived } : old));
        void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
        return true;
      })
      .catch((err) => {
        Alert.alert("Couldn't change the chat", errorText(err));
        return false;
      });

  const remove = () =>
    Alert.alert("Delete this chat?", "It's removed on your computer too.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void api.conversations
            .delete(id)
            .then(() => {
              void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
              router.back();
            })
            .catch((err) => Alert.alert("Couldn't delete the chat", errorText(err))),
      },
    ]);

  const rename = () => {
    if (process.env.EXPO_OS !== "ios") return setRenaming(true);
    Alert.prompt("Rename chat", undefined, (text) => text.trim() && void change({ title: text.trim() }), "plain-text", conversation.data?.title ?? "");
  };

  const title = conversation.data?.title || "Chat";
  const primary = screens[0];
  const data = conversation.data;
  const menu: HeaderMenuItem[] = data
    ? [
        ...(running && !paused
          ? [{ icon: "pause" as const, title: "Pause", onPress: () => void api.conversations.pause(id).catch((err) => Alert.alert("Couldn't pause", errorText(err))) }]
          : []),
        { icon: "pencil", title: "Rename", onPress: rename },
        { icon: "pin", title: data.pinned ? "Unpin" : "Pin", onPress: () => void change({ pinned: !data.pinned }) },
        data.archived
          ? { icon: "unarchive", title: "Unarchive", onPress: () => void change({ archived: false }) }
          : { icon: "archive", title: "Archive", onPress: () => void change({ archived: true }).then((done) => done && router.back()) },
        { icon: "trash", title: "Delete", destructive: true, onPress: remove },
      ]
    : [];

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      switch (item.role) {
        case "intro":
          return agent ? <Intro agent={agent} conversationId={id} running={!!runId} /> : null;
        case "earlier":
          return <Earlier conversationId={id} />;
        case "user":
          return <UserMessage message={item.message} />;
        case "live":
          return <LiveMessage conversationId={id} runId={runId} />;
        case "note":
          return <SystemNote content={item.content} />;
        default:
          return <AssistantMessage blocks={item.blocks} content={item.content} streaming={item.streaming} />;
      }
    },
    [agent, id, runId],
  );

  return (
    <>
      <Stack.Title>{title}</Stack.Title>
      <HeaderActions
        actions={primary ? [{ icon: "eye", label: "Watch the agent's screen", onPress: () => router.push(screenHref(primary)) }] : []}
        menu={menu}
      />
      <KeyboardAvoidingView behavior="translate-with-padding" style={{ flex: 1 }}>
        {!conversation.data ? (
          <View style={{ flex: 1 }}>
            {conversation.isError ? (
              <ErrorState title="Couldn't open this chat" error={errorText(conversation.error)} onRetry={() => void conversation.refetch()} />
            ) : (
              <ChatSkeleton />
            )}
          </View>
        ) : (
          <ChatScope.Provider value={scope}>
            <FlashList
              ref={list}
              data={items}
              keyExtractor={(item) => item.key}
              contentInsetAdjustmentBehavior="automatic"
              keyboardDismissMode="interactive"
              maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.25 }}
              onStartReached={() => void loadEarlier(id).catch(() => undefined)}
              onStartReachedThreshold={0.6}
              contentContainerStyle={styles.list}
              ItemSeparatorComponent={Gap}
              renderItem={renderItem}
              getItemType={(item) => item.role}
            />
          </ChatScope.Provider>
        )}
        {forYou.data?.some((t) => !t.questionId) ? <ForYouStrip tasks={forYou.data.filter((t) => !t.questionId)} /> : null}
        {run && primary ? <ChatLiveStrip screen={primary} runId={run.id} /> : null}
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
          <EndedStrip mode={ended.mode} onRetry={retry} busy={retrying} />
        ) : followup ? (
          <FollowupStrip conversationId={id} followup={followup} agentName={agent?.name ?? "The agent"} />
        ) : longChat ? (
          <LongChatStrip pct={longChat.share === null ? null : Math.round(longChat.share * 100)} full={longChat.tone === "full"} onCompress={() => void send("/compress", [])} onHide={() => setCompressHiddenAt(longChat.tokens)} />
        ) : null}
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
            sendLabel={waiting ? "Send answer" : paused ? (paused.reason === "user" ? "Send and continue" : "Queue message") : queueing ? "Queue message" : null}
            placeholder={
              !agent
                ? "Message"
                : waiting
                  ? `Answer ${agent.name}`
                  : paused?.reason === "user"
                    ? `Tell ${agent.name} how to go on`
                    : paused?.reason === "limit"
                      ? `Message ${agent.name} — goes along after the reset`
                      : paused
                        ? `Message ${agent.name} — goes along when it continues`
                        : run
                          ? `Queue a message for ${agent.name}`
                          : `Message ${agent.name}, or / for commands`
            }
            disabled={agent ? !agent.enabled : false}
            trailing={
              conversation.data ? (
                <>
                {gauge ? <ContextRing gauge={gauge} conversationId={id} /> : null}
                <ModelButton
                  agent={agent}
                  conversationId={id}
                  choice={{ model: conversation.data.model ?? null, effort: conversation.data.effort ?? null, ultracode: conversation.data.ultracode ?? null }}
                />
                </>
              ) : null
            }
          />
        </ComposerDock>
        <View style={{ height: keyboardOpen ? space.sm : Math.max(insets.bottom, space.md) }} />
      </KeyboardAvoidingView>
      <RenameDialog open={renaming} title={conversation.data?.title ?? ""} onClose={() => setRenaming(false)} onSave={(text) => void change({ title: text })} />
    </>
  );
}

/** The answer being written: it alone renders with every word that arrives. */
const LiveMessage = memo(function LiveMessage({ conversationId, runId }: { conversationId: string; runId?: string }) {
  const blocks = useLive((s) => {
    const draft = s.drafts[conversationId];
    return draft && draft.runId === runId ? draft.blocks : NO_BLOCKS;
  });
  return <AssistantMessage blocks={blocks} streaming />;
});

function ChatLiveStrip({ screen, runId }: { screen: LiveScreen; runId: string }) {
  return <LiveStrip screen={screen} activity={useRunActivity(runId)} />;
}

/** At the top while older messages exist: they load when the list gets there, or with a tap when that failed. */
function Earlier({ conversationId }: { conversationId: string }) {
  const c = useColors();
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    loadEarlier(conversationId).catch(() => setFailed(true));
  };
  // The list only says once that its start was reached: this row asks for the page itself when it appears.
  useEffect(() => {
    loadEarlier(conversationId).catch(() => setFailed(true));
  }, [conversationId]);
  return (
    <Pressable onPress={load} disabled={!failed} accessibilityRole="button" accessibilityLabel={failed ? "Load earlier messages" : "Loading earlier messages"} style={styles.earlier}>
      {failed ? <Icon name="refresh" size={12} color={c.textMuted} /> : <ActivityIndicator size="small" color={c.textFaint} />}
      <T variant="caption" muted>
        {failed ? "Couldn't load earlier messages. Tap to try again" : "Earlier messages"}
      </T>
    </Pressable>
  );
}

/** Android has no text prompt of its own. */
function RenameDialog({ open, title, onClose, onSave }: { open: boolean; title: string; onClose: () => void; onSave: (title: string) => void }) {
  const c = useColors();
  const [text, setText] = useState(title);
  useEffect(() => {
    if (open) setText(title);
  }, [open, title]);
  const save = () => {
    if (text.trim()) onSave(text.trim());
    onClose();
  };
  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
      <View style={styles.dialogWrap} pointerEvents="box-none">
        <View style={[styles.dialog, { backgroundColor: c.surface }]} accessibilityViewIsModal>
          <T variant="headline">Rename chat</T>
          <TextInput
            autoFocus
            value={text}
            onChangeText={setText}
            onSubmitEditing={save}
            returnKeyType="done"
            maxLength={200}
            selectTextOnFocus
            accessibilityLabel="Chat title"
            style={[type.body, styles.dialogInput, { color: c.text, backgroundColor: c.sunken }]}
          />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Save" onPress={save} disabled={!text.trim()} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Above the composer while the agent plans to come back to the chat on its own. */
function FollowupStrip({ conversationId, followup, agentName }: { conversationId: string; followup: ConversationFollowup; agentName: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
    void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
  };
  const failed = (title: string) => (err: unknown) =>
    Alert.alert(title, err instanceof ApiError && err.code === "device_forbidden" ? "Update Godmode on your computer to change follow-ups from the phone." : errorText(err));
  const move = (dueAt: Date) => void api.conversations.followup.move(conversationId, dueAt.toISOString()).then(refresh).catch(failed("Couldn't move the follow-up"));
  const inAnHour = new Date(Date.now() + 3600_000);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const items: HeaderMenuItem[] = [
    {
      icon: "play",
      title: "Continue now",
      onPress: () =>
        void api.conversations.followup
          .runNow(conversationId)
          .then((started) => {
            useLive.getState().runStarted(started);
            refresh();
          })
          .catch(failed("Couldn't continue now")),
    },
    { icon: "clock", title: "In an hour", onPress: () => move(inAnHour) },
    { icon: "clock", title: "Tomorrow at 09:00", onPress: () => move(tomorrow) },
    {
      icon: "close",
      title: "Cancel the follow-up",
      destructive: true,
      onPress: () => void api.conversations.followup.cancel(conversationId).then(refresh).catch(failed("Couldn't cancel the follow-up")),
    },
  ];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${agentName} continues ${whenText(followup.dueAt)}. Change`}
        onPress={() => {
          tap();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.paused, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.75 : 1 }]}
      >
        <Icon name="clock" size={15} color={c.textMuted} />
        <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
          <T variant="footnote" style={{ fontWeight: "600" }}>
            Continues {whenText(followup.dueAt)}
          </T>
          {followup.note ? `  ${followup.note}` : ""}
        </T>
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          Change
        </T>
      </Pressable>
      <MenuSheet items={items} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Shaped like a chat while its messages load: a long chat takes a moment over the phone's connection. */
function ChatSkeleton() {
  const widths = [["62%", 0], ["84%", 1], ["48%", 0], ["90%", 1], ["70%", 1]] as const;
  return (
    <ScrollView
      scrollEnabled={false}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.skeleton}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading the chat"
    >
      <View style={{ alignItems: "center", gap: 10, paddingBottom: space.lg }}>
        <Skeleton width={88} height={88} radius={30} />
        <Skeleton width={110} height={14} />
      </View>
      {widths.map(([w, agent], i) =>
        agent ? (
          <View key={i} style={{ gap: 8 }}>
            <Skeleton width={w} height={13} />
            <Skeleton width={`${Math.max(30, parseInt(w, 10) - 22)}%`} height={13} />
          </View>
        ) : (
          <Skeleton key={i} width={w} height={40} radius={20} style={{ alignSelf: "flex-end" }} />
        ),
      )}
    </ScrollView>
  );
}

/** Above the composer while the agent waits for something only the human can do. */
function ForYouStrip({ tasks }: { tasks: HumanTask[] }) {
  const c = useColors();
  const first = tasks[0]!;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openHumanTask(first.id, first.conversationId)}
      style={({ pressed }) => [styles.paused, { backgroundColor: c.warningSoft, borderColor: c.warning, opacity: pressed ? 0.75 : 1 }]}
    >
      <Icon name="person" size={15} color={c.warning} />
      <T variant="footnote" style={{ flex: 1 }} numberOfLines={2}>
        <T variant="footnote" style={{ fontWeight: "600" }}>
          {first.kind === "decision" ? "Waiting for your answer: " : "Waiting for you: "}
        </T>
        {first.title}
        {tasks.length > 1 ? ` and ${tasks.length - 1} more` : ""}
      </T>
      <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
        Open
      </T>
    </Pressable>
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

/**
 * The chat's last turn, when it ended early and trying again can help: not in a ticket's, an automation's or a chat
 * platform's chat (those go on from there), nor while messages wait in the chat (they'd go along unasked).
 */
function endedTurn(conv: ConversationWithMessages): { runId: string; mode: RetryMode } | null {
  if (["task", "routine", "dream", "slack", "telegram", "teams"].includes(conv.origin) || conv.queue.length > 0) return null;
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role !== "assistant" || !last.runId) return null;
  const end = last.blocks[last.blocks.length - 1];
  const text = end?.type === "error" ? end.text : end?.type === "notice" && runEndOf(end.text) ? end.text : null;
  if (text === null || !retryHelps(runEndOf(text))) return null;
  return { runId: last.runId, mode: retryModeOf(last.blocks) === "continue" && conv.claudeSessionId ? "continue" : "again" };
}

/** Above the composer once the chat gets long. */
function LongChatStrip({ pct, full, onCompress, onHide }: { pct: number | null; full: boolean; onCompress: () => void; onHide: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.paused, { backgroundColor: full ? c.dangerSoft : c.warningSoft, borderColor: c.border }]}>
      <Icon name="layers" size={15} color={full ? c.danger : c.warning} />
      <T variant="footnote" style={{ flex: 1 }} numberOfLines={2}>
        This chat is getting long{pct !== null ? ` · ${pct}%` : ""}
      </T>
      <Pressable onPress={() => { tap(); onCompress(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Compress the chat">
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          Compress
        </T>
      </Pressable>
      <Pressable onPress={onHide} hitSlop={10} accessibilityRole="button" accessibilityLabel="Hide">
        <Icon name="close" size={12} weight="semibold" color={c.textFaint} />
      </Pressable>
    </View>
  );
}

/** Above the composer when the last turn ended early. */
function EndedStrip({ mode, onRetry, busy }: { mode: RetryMode; onRetry: () => void; busy: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Icon name="warning" size={15} color={c.textMuted} />
      <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
        {mode === "continue" ? "Stopped before it was done" : "Didn't get through"}
      </T>
      <Pressable
        onPress={onRetry}
        disabled={busy}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={mode === "continue" ? "Continue" : "Try again"}
        accessibilityState={{ busy, disabled: busy }}
        style={{ opacity: busy ? 0.5 : 1 }}
      >
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
  skeleton: {
    gap: 22,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
  },
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
  earlier: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  dialogWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  dialog: {
    gap: space.lg,
    padding: space.xl,
    borderRadius: radius.lg,
    borderCurve: "continuous",
  },
  dialogInput: {
    height: 46,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
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
