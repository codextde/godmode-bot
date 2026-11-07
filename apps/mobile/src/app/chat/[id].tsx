import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type Agent,
  type Conversation,
  type ConversationFollowup,
  type ConversationWithMessages,
  type HumanTask,
  type Message,
  type MessageBlock,
  type QueuedMessage,
  type RunPause,
} from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { ChatFilesScope } from "@/components/chat-files";
import { ChatMoveCard } from "@/components/chat-move-card";
import { DreamLogNote } from "@/components/dream-log-note";
import { followupTimes } from "@/components/followup-row";
import { Composer, ComposerDock, type ComposerHandle, type SendOptions } from "@/components/composer";
import { useFullAccess } from "@/components/full-access";
import { Glass } from "@/components/glass";
import { HeaderActions, MenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { LiveStrip } from "@/components/live-strip";
import { AssistantMessage, UserMessage } from "@/components/message";
import { Icon } from "@/components/icon";
import { ModalTextInput } from "@/components/modal-field";
import { ModelButton } from "@/components/model-button";
import { ContextRing } from "@/components/context-ring";
import { ChatScope, type ChatScopeValue } from "@/components/question-card";
import { QueueTray } from "@/components/queue-tray";
import { RunnerOfflineBar } from "@/components/runner-offline-bar";
import { EndedStrip, useEndedTurn } from "@/components/turn-end";
import { Button, ErrorState, Skeleton, T, tap } from "@/components/ui";
import { openHumanTask } from "@/components/human-task-row";
import { ApiError, api, errorText, updateDesktopMessage } from "@/lib/api";
import { useArchive } from "@/lib/archive";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { fetchConversation, loadEarlier } from "@/lib/chat-cache";
import { moveTargets, usePlaces } from "@/lib/chat-extras";
import { useChatPrefs } from "@/lib/chat-prefs";
import { isCompressCommand, useContextGauge } from "@/lib/chat-memory";
import { setQueue } from "@/lib/composer";
import { askHandoff, canHandoff, handoffChatIn, isHandoffCommand, takeHandoff } from "@/lib/handoff";
import { dayLabel, whenText } from "@/lib/format";
import { newQueueId, pendingQueued, withPending } from "@/lib/pending-queue";
import { useAgents, useNow } from "@/lib/hooks";
import { useChatRun, useLive, useRunActivity } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { subscribeConversation, viewConversation } from "@/lib/realtime";
import { useSettings } from "@/lib/setup";
import { screenHref, useChatScreens, type LiveScreen } from "@/lib/screens";
import { radius, space, type, useColors } from "@/lib/theme";
import { useTypewriter } from "@/lib/typewriter";
import { markVoiceRun, useSpokenReplies } from "@/lib/voice-replies";

type Item =
  | { key: string; role: "intro" }
  | { key: string; role: "earlier" }
  | { key: string; role: "user"; message: Message }
  | { key: string; role: "assistant"; blocks: MessageBlock[]; content: string; streaming: boolean; runId?: string | null }
  | { key: string; role: "day"; label: string }
  | { key: string; role: "live" }
  | { key: string; role: "note"; content: string }
  | { key: string; role: "origin" }
  | { key: string; role: "private" };

const NO_BLOCKS: MessageBlock[] = [];
/** Further from the end than this, the way back to it shows. */
const JUMP_AWAY = 240;
/** What marks a place in the chat where it went on without the human writing. */
const MARKERS = new Set<MessageBlock["type"]>(["human_task", "followup", "retry", "call", "moved"]);

/** A stored message's row, the same object for as long as the message is: rows that didn't change don't render again. */
const settled = new WeakMap<Message, Item | null>();

function itemOf(m: Message): Item | null {
  let item = settled.get(m);
  if (item !== undefined) return item;
  if (m.role === "user") item = { key: m.id, role: "user", message: m };
  else if (m.role === "assistant") item = { key: m.id, role: "assistant", blocks: m.blocks, content: m.content, streaming: false, runId: m.runId };
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
  const { t } = useTranslation(["chat", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  // Android draws the header above the screen, not over it: the keyboard covers the screen from that far down.
  const headerHeight = useHeaderHeight();
  const keyboardOffset = process.env.EXPO_OS === "android" ? headerHeight : 0;
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
  const { fullAccess } = useFullAccess();
  const places = usePlaces(fullAccess === true);
  const awayPlace = places.find((p) => p.runnerId === conversation.data?.runnerId && !!p.runnerId && !p.self && p.state !== "online") ?? null;
  const settings = useSettings();
  const isPrivate = !!conversation.data?.private;
  usePrivateChatLifetime(id, isPrivate);
  const continuedFrom = conversation.data?.continuedFrom ?? null;
  const delegatedFrom = conversation.data?.delegatedFrom ?? null;
  const hasOrigin = !!continuedFrom || !!delegatedFrom?.conversationId;

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
    // The agent's picture greets an empty chat only: it never sits above a transcript.
    const out: Item[] = hasMore ? [{ key: "earlier", role: "earlier" }] : !messages?.length && !running ? [{ key: "intro", role: "intro" }] : [];
    if (isPrivate) out.push({ key: "private", role: "private" });
    if (hasOrigin) out.push({ key: "origin", role: "origin" });
    let answered = false;
    let lastDay = "";
    for (const m of messages ?? []) {
      if (m.id === liveMessageId) continue;
      const item = itemOf(m);
      if (!item) continue;
      const day = dayLabel(m.createdAt);
      if (day && day !== lastDay) out.push({ key: `day-${day}`, role: "day", label: day });
      lastDay = day || lastDay;
      if (runId && m.role === "assistant" && m.runId === runId) {
        answered = true;
        out.push({ ...item, streaming: true } as Item);
      } else out.push(item);
    }
    if (liveMessageId || (running && !answered)) out.push({ key: liveMessageId ?? `pending-${runId}`, role: "live" });
    return out;
  }, [messages, hasMore, liveMessageId, runId, running, isPrivate, hasOrigin]);

  // Asked to go on in a new chat: it opens as soon as the agent made it.
  const liveHandoff = useLive((s) => handoffChatIn(s.drafts[id]?.blocks));
  const doneHandoff = useMemo(() => handoffAfterAsk(messages), [messages]);
  const handoffTarget = liveHandoff ?? doneHandoff;
  useEffect(() => {
    if (handoffTarget && takeHandoff(id)) router.push({ pathname: "/chat/[id]", params: { id: handoffTarget } });
  }, [handoffTarget, id]);

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
  const handoffQueued = queue.some((m) => isHandoffCommand(m.content));
  // A switched-off agent answers nothing: the composer keeps a draft and the strip offers the way back.
  const dreamLog = conversation.data?.origin === "dream" || conversation.data?.origin === "review";
  const off = !!agent && (!agent.enabled || agent.archived) && !dreamLog;
  const handoffOk = canHandoff(conversation.data) && !off;
  const longChat =
    !!gauge && gauge.tone !== "calm" && gauge.compressible && !compressing && !handoffQueued && !dreamLog && (compressHiddenAt === null || gauge.tokens > compressHiddenAt * 1.2) ? gauge : null;

  const scope = useMemo<ChatScopeValue>(
    () => ({ conversationId: id, agentName: agent?.name ?? t("thread.theAgent"), openQuestionId: (pause?.reason === "question" && pause.question?.id) || null, readOnly: dreamLog }),
    [id, agent?.name, pause, dreamLog, t],
  );

  const followUp = useChatPrefs((s) => s.followUp);
  const working = !!run && !paused;
  useSpokenReplies(id, runId, settings.data?.voice);

  const send = async (content: string, files: PendingFile[], options?: SendOptions) => {
    if (isHandoffCommand(content)) askHandoff(id);
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
        // Steer (Settings → General, or the other way when the button was held): the agent stops and starts on the queue right away.
        if (working && (followUp === "steer") !== !!options?.otherWay) void api.conversations.queue.sendNow(id).catch(() => undefined);
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
      if (options?.voice) markVoiceRun(result.run.id);
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    } catch (err) {
      pendingQueued.delete(queueId);
      queryClient.setQueryData<ConversationWithMessages>(key, (old) =>
        old ? { ...old, messages: old.messages.filter((m) => m.id !== tempId), queue: old.queue.filter((m: QueuedMessage) => m.id !== queueId) } : old,
      );
      Alert.alert(t("thread.notSent"), errorText(err));
      throw err;
    }
  };

  const onLost = useCallback((text: string) => composer.current?.insert(text), []);

  const [away, setAway] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, contentInset, layoutMeasurement } = e.nativeEvent;
    setAway(contentSize.height + contentInset.bottom - layoutMeasurement.height - contentOffset.y > JUMP_AWAY);
  }, []);

  // Go on in a fresh chat: the agent writes the brief, and the new chat opens once it exists.
  const handoff = () => {
    tap();
    void send("/handoff", []).catch(() => undefined);
  };

  const stop = () => {
    if (run) void api.runs.cancel(run.id).catch((err) => Alert.alert(t("thread.stopFailed"), errorText(err)));
  };

  const resume = () => {
    tap();
    api.conversations
      .continue(id)
      .then((continued) => useLive.getState().runStarted(continued))
      .catch((err) => Alert.alert(t("thread.continueFailed"), errorText(err)));
  };

  // The latest turn ended early (failed, stopped, cut off): one tap picks it up — when nothing else would happen first.
  const [retrying, setRetrying] = useState(false);
  const ended = useEndedTurn(conversation.data, !run && !paused && !awayPlace && agent?.enabled !== false);
  const retry = () => {
    if (!ended || retrying) return;
    tap();
    setRetrying(true);
    api.conversations
      .retry(id, ended.run.id)
      .then((result) => {
        queryClient.setQueryData<ConversationWithMessages>(qk.conversation(id), (old) =>
          old && !old.messages.some((m) => m.id === result.message.id) ? { ...old, messages: [...old.messages, result.message] } : old,
        );
        useLive.getState().runStarted(result.run);
      })
      .catch((err) => {
        // Something else moved the chat on (another tap, the computer): show that instead of an error.
        if (err instanceof ApiError && err.code === "stale") void queryClient.invalidateQueries({ queryKey: qk.conversation(id) });
        else Alert.alert(t("thread.retryFailed"), errorText(err));
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
        Alert.alert(t("thread.changeFailed"), errorText(err));
        return false;
      });

  const remove = () =>
    Alert.alert(t("thread.deleteTitle"), t("thread.deleteMessage"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: () =>
          void api.conversations
            .delete(id)
            .then(() => {
              void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
              router.back();
            })
            .catch((err) => Alert.alert(t("thread.deleteFailed"), errorText(err))),
      },
    ]);

  const rename = () => {
    if (process.env.EXPO_OS !== "ios") return setRenaming(true);
    Alert.prompt(t("thread.rename"), undefined, (text) => text.trim() && void change({ title: text.trim() }), "plain-text", conversation.data?.title ?? "");
  };

  const title = useTypewriter(conversation.data?.title || t("thread.fallbackTitle"));
  const primary = screens[0];
  const data = conversation.data;
  const menu: HeaderMenuItem[] = data
    ? [
        ...(running && !paused
          ? [{ icon: "pause" as const, title: t("thread.menu.pause"), onPress: () => void api.conversations.pause(id).catch((err) => Alert.alert(t("thread.pauseFailed"), errorText(err))) }]
          : []),
        ...(handoffOk && !handoffQueued ? [{ icon: "handoff" as const, title: t("conv.handoff"), onPress: handoff }] : []),
        ...(settings.data?.voice.enabled !== false && !dreamLog ? [{ icon: "waveform" as const, title: t("voiceMode.title"), onPress: () => router.push({ pathname: "/voice-mode", params: { conversationId: id } }) }] : []),
        ...(dreamLog ? [] : [{ icon: "slider" as const, title: t("conv.settings"), onPress: () => router.push({ pathname: "/chat-options", params: { conversationId: id } }) }]),
        ...(fullAccess && !data.private ? [{ icon: "share" as const, title: t("share.menu"), onPress: () => router.push({ pathname: "/chat-share", params: { conversationId: id } }) }] : []),
        ...(fullAccess && !data.private && moveTargets(places, data.runnerId).length
          ? [{ icon: "laptop" as const, title: t("move.menu"), onPress: () => router.push({ pathname: "/chat-move", params: { conversationId: id } }) }]
          : []),
        { icon: "pencil", title: t("common:actions.rename"), onPress: rename },
        ...(data.private
          ? []
          : [
              { icon: "pin" as const, title: data.pinned ? t("thread.menu.unpin") : t("thread.menu.pin"), onPress: () => void change({ pinned: !data.pinned }) },
              data.archived
                ? { icon: "unarchive" as const, title: t("thread.menu.unarchive"), onPress: () => void change({ archived: false }) }
                : { icon: "archive" as const, title: t("thread.menu.archive"), onPress: () => void change({ archived: true }).then((done) => done && router.back()) },
            ]),
        { icon: "trash", title: t("common:actions.delete"), destructive: true, onPress: remove },
      ]
    : [];

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      switch (item.role) {
        case "intro":
          return agent ? <Intro agent={agent} running={!!runId} /> : null;
        case "earlier":
          return <Earlier conversationId={id} />;
        case "user":
          return <UserMessage message={item.message} />;
        case "live":
          return <LiveMessage conversationId={id} runId={runId} agent={agent} />;
        case "note":
          return <SystemNote content={item.content} />;
        case "day":
          return <DayDivider label={item.label} />;
        case "origin":
          return <OriginLine continuedFrom={continuedFrom} delegatedFrom={delegatedFrom} />;
        case "private":
          return <PrivateNote />;
        default:
          return <AssistantMessage id={item.key} runId={item.runId} blocks={item.blocks} content={item.content} streaming={item.streaming} agent={agent} />;
      }
    },
    [agent, id, runId, continuedFrom, delegatedFrom],
  );

  return (
    <>
      <Stack.Title>{title}</Stack.Title>
      <HeaderActions
        actions={[
          ...(isPrivate ? [{ icon: "incognito" as const, label: t("conv.private"), onPress: () => Alert.alert(t("conv.privateStart"), t("conv.privateHint")) }] : []),
          ...(primary ? [{ icon: "eye" as const, label: t("thread.watchScreen"), onPress: () => router.push(screenHref(primary)) }] : []),
        ]}
        menu={menu}
      />
      <KeyboardAvoidingView behavior="translate-with-padding" keyboardVerticalOffset={keyboardOffset} style={{ flex: 1 }}>
        {!conversation.data ? (
          <View style={{ flex: 1 }}>
            {conversation.isError ? (
              <ErrorState title={t("thread.openFailed")} error={errorText(conversation.error)} onRetry={() => void conversation.refetch()} />
            ) : (
              <ChatSkeleton />
            )}
          </View>
        ) : (
          <ChatScope.Provider value={scope}>
            <ChatFilesScope conversationId={id} runnerId={conversation.data.runnerId}>
              <View style={{ flex: 1 }}>
                <FlashList
                  ref={list}
                  data={items}
                  keyExtractor={(item) => item.key}
                  contentInsetAdjustmentBehavior="automatic"
                  keyboardDismissMode="interactive"
                  maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.25 }}
                  onStartReached={() => void loadEarlier(id).catch(() => undefined)}
                  onStartReachedThreshold={0.6}
                  onScroll={onScroll}
                  scrollEventThrottle={100}
                  contentContainerStyle={styles.list}
                  ItemSeparatorComponent={Gap}
                  renderItem={renderItem}
                  getItemType={(item) => item.role}
                />
                {away && items.length ? <JumpButton live={!!run} onPress={() => list.current?.scrollToEnd({ animated: true })} /> : null}
              </View>
            </ChatFilesScope>
          </ChatScope.Provider>
        )}
        {off && agent ? <SwitchedOffStrip agent={agent} /> : null}
        {forYou.data?.some((task) => !task.questionId) ? <ForYouStrip tasks={forYou.data.filter((task) => !task.questionId)} /> : null}
        {run && primary ? <ChatLiveStrip screen={primary} runId={run.id} /> : null}
        {paused?.reason === "question" ? null : paused ? (
          <PausedStrip conversationId={id} pause={paused} onContinue={resume} />
        ) : ended ? (
          <EndedStrip ended={ended} conversationId={id} agentId={agent?.id} agentName={agent?.name ?? t("thread.theAgent")} onRetry={retry} onCompress={() => void send("/compress", []).catch(() => undefined)} busy={retrying} />
        ) : followup ? (
          <FollowupStrip conversationId={id} followup={followup} agentName={agent?.name ?? t("thread.theAgent")} />
        ) : longChat ? (
          <LongChatStrip
            pct={longChat.share === null ? null : Math.round(longChat.share * 100)}
            full={longChat.tone === "full"}
            onCompress={() => void send("/compress", [])}
            onHandoff={handoffOk ? handoff : undefined}
            onHide={() => setCompressHiddenAt(longChat.tokens)}
          />
        ) : null}
        <ChatMoveCard conversationId={id} />
        {awayPlace ? <RunnerOfflineBar conversationId={id} place={awayPlace} here={places.find((p) => p.self) ?? null} /> : null}
        <QueueTray
          conversationId={id}
          queue={queue}
          agentName={agent?.name ?? t("thread.theAgent")}
          running={!!run && !paused}
          paused={paused?.reason ?? null}
          onLost={onLost}
        />
        {dreamLog ? (
          <DreamLogNote agentId={conversation.data?.agentId ?? ""} name={agent?.name ?? t("thread.theAgent")} review={conversation.data?.origin === "review"} />
        ) : (
        <ComposerDock>
          <Composer
            ref={composer}
            draftKey={id}
            agentId={conversation.data?.agentId}
            attachments
            onSend={send}
            onStop={stop}
            running={working}
            sendLabel={waiting ? t("thread.send.answer") : paused ? (paused.reason === "user" ? t("thread.send.andContinue") : t("thread.send.queue")) : working && followUp === "steer" ? t("thread.send.steer") : queueing ? t("thread.send.queue") : null}
            otherSend={working ? (followUp === "steer" ? t("thread.send.queue") : t("thread.send.steer")) : null}
            placeholder={
              !agent
                ? t("thread.placeholder.message")
                : !agent.enabled || agent.archived
                  ? t("conv.switchedOffDraft", { name: agent.name })
                  : waiting
                  ? t("thread.placeholder.answer", { name: agent.name })
                  : paused?.reason === "user"
                    ? t("thread.placeholder.howToGoOn", { name: agent.name })
                    : paused?.reason === "limit"
                      ? t("thread.placeholder.afterReset", { name: agent.name })
                      : paused
                        ? t("thread.placeholder.whenContinues", { name: agent.name })
                        : run
                          ? followUp === "steer"
                            ? t("thread.placeholder.steer", { name: agent.name })
                            : t("thread.placeholder.queue", { name: agent.name })
                          : t("thread.placeholder.default", { name: agent.name })
            }
            blocked={!!agent && (!agent.enabled || agent.archived)}
            voice
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
        )}
        <View style={{ height: keyboardOpen ? space.sm : Math.max(insets.bottom, space.md) }} />
      </KeyboardAvoidingView>
      <RenameDialog open={renaming} title={conversation.data?.title ?? ""} onClose={() => setRenaming(false)} onSave={(text) => void change({ title: text })} />
    </>
  );
}

/** The answer being written: it alone renders with every word that arrives. */
const LiveMessage = memo(function LiveMessage({ conversationId, runId, agent }: { conversationId: string; runId?: string; agent?: Agent }) {
  const blocks = useLive((s) => {
    const draft = s.drafts[conversationId];
    return draft && draft.runId === runId ? draft.blocks : NO_BLOCKS;
  });
  const messageId = useLive((s) => (s.drafts[conversationId]?.runId === runId ? s.drafts[conversationId]?.messageId : undefined));
  return <AssistantMessage id={messageId} blocks={blocks} streaming agent={agent} />;
});

/** Where a new day starts in the chat: quiet, like the desktop's. */
function DayDivider({ label }: { label: string }) {
  const c = useColors();
  return (
    <View style={styles.day} accessibilityRole="header">
      <View style={[styles.dayLine, { backgroundColor: c.border }]} />
      <T variant="caption" muted>
        {label}
      </T>
      <View style={[styles.dayLine, { backgroundColor: c.border }]} />
    </View>
  );
}

/** Back to the end of the chat after scrolling away from it. */
function JumpButton({ live, onPress }: { live: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  const label = live ? t("thread.jumpToLive") : t("thread.jumpToLatest");
  return (
    <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(140)} style={styles.jump} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={8}
        onPress={() => {
          tap();
          onPress();
        }}
        style={({ pressed }) => pressed && { opacity: 0.7 }}
      >
        <Glass interactive fallback={c.surface} style={styles.jumpPill}>
          <Icon name="down" size={11} weight="semibold" color={c.textMuted} />
          <T variant="footnote" style={{ fontWeight: "500" }}>
            {label}
          </T>
        </Glass>
      </Pressable>
    </Animated.View>
  );
}

function ChatLiveStrip({ screen, runId }: { screen: LiveScreen; runId: string }) {
  return <LiveStrip screen={screen} activity={useRunActivity(runId)} />;
}

/** At the top while older messages exist: they load when the list gets there, or with a tap when that failed. */
function Earlier({ conversationId }: { conversationId: string }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
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
    <Pressable onPress={load} disabled={!failed} accessibilityRole="button" accessibilityLabel={failed ? t("thread.earlier.load") : t("thread.earlier.loading")} style={styles.earlier}>
      {failed ? <Icon name="refresh" size={12} color={c.textMuted} /> : <ActivityIndicator size="small" color={c.textFaint} />}
      <T variant="caption" muted>
        {failed ? t("thread.earlier.failed") : t("thread.earlier.title")}
      </T>
    </Pressable>
  );
}

/** Android has no text prompt of its own. */
function RenameDialog({ open, title, onClose, onSave }: { open: boolean; title: string; onClose: () => void; onSave: (title: string) => void }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const [text, setText] = useState(title);
  // Opening it starts from the current title.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setText(title);
  }
  const save = () => {
    if (text.trim()) onSave(text.trim());
    onClose();
  };
  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable accessibilityLabel={t("common:actions.close")} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
      <View style={styles.dialogWrap} pointerEvents="box-none">
        <View style={[styles.dialog, { backgroundColor: c.surface }]} accessibilityViewIsModal>
          <T variant="headline">{t("thread.rename")}</T>
          <ModalTextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={save}
            returnKeyType="done"
            maxLength={200}
            selectTextOnFocus
            accessibilityLabel={t("thread.renameLabel")}
            style={[type.body, styles.dialogInput, { color: c.text, backgroundColor: c.sunken }]}
          />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title={t("common:actions.cancel")} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title={t("common:actions.save")} onPress={save} disabled={!text.trim()} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Above the composer while the agent plans to come back to the chat on its own. */
function FollowupStrip({ conversationId, followup, agentName }: { conversationId: string; followup: ConversationFollowup; agentName: string }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
    void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
  };
  const failed = (title: string) => (err: unknown) =>
    Alert.alert(title, err instanceof ApiError && err.code === "device_forbidden" ? t("thread.followup.updateDesktop") : errorText(err));
  const move = (dueAt: Date) => void api.conversations.followup.move(conversationId, dueAt.toISOString()).then(refresh).catch(failed(t("thread.followup.moveFailed")));
  const items: HeaderMenuItem[] = [
    {
      icon: "play",
      title: t("thread.followup.continueNow"),
      onPress: () =>
        void api.conversations.followup
          .runNow(conversationId)
          .then((started) => {
            useLive.getState().runStarted(started);
            refresh();
          })
          .catch(failed(t("thread.followup.continueNowFailed"))),
    },
    ...followupTimes(conversationId, followup.dueAt, move),
    {
      icon: "close",
      title: t("thread.followup.cancel"),
      destructive: true,
      onPress: () => void api.conversations.followup.cancel(conversationId).then(refresh).catch(failed(t("thread.followup.cancelFailed"))),
    },
  ];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("thread.followup.a11y", { name: agentName, when: whenText(followup.dueAt) })}
        onPress={() => {
          tap();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.paused, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.75 : 1 }]}
      >
        <Icon name="clock" size={15} color={c.textMuted} />
        <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
          <T variant="footnote" style={{ fontWeight: "600" }}>
            {t("thread.followup.continues", { when: whenText(followup.dueAt) })}
          </T>
          {followup.note ? `  ${followup.note}` : ""}
        </T>
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          {t("thread.followup.change")}
        </T>
      </Pressable>
      <MenuSheet items={items} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Shaped like a chat while its messages load: a long chat takes a moment over the phone's connection. */
function ChatSkeleton() {
  const { t } = useTranslation("chat");
  const widths = [["62%", 0], ["84%", 1], ["48%", 0], ["90%", 1], ["70%", 1]] as const;
  return (
    <ScrollView
      scrollEnabled={false}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.skeleton}
      accessibilityRole="progressbar"
      accessibilityLabel={t("thread.loading")}
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
  const { t } = useTranslation(["chat", "common"]);
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
          {first.kind === "decision" ? t("thread.forYou.answer") : t("thread.forYou.you")}
        </T>
        {first.title}
        {tasks.length > 1 ? t("thread.forYou.more", { count: tasks.length - 1 }) : ""}
      </T>
      <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
        {t("common:actions.open")}
      </T>
    </Pressable>
  );
}

/** Above the composer while the chat's run stands still; a usage limit says when it resets and may go on by itself. */
function PausedStrip({ conversationId, pause, onContinue }: { conversationId: string; pause: RunPause; onContinue: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const now = useNow(30_000);
  const limit = pause.reason === "limit";
  const reset = limit && pause.resumeAt ? (new Date(pause.resumeAt).getTime() <= now ? t("pause.resetsAnyMoment") : t("pause.resetsIn", { when: whenText(pause.resumeAt) })) : null;
  const setAuto = (on: boolean) => {
    const key = qk.conversation(conversationId);
    queryClient.setQueryData<ConversationWithMessages>(key, (old) => (old?.paused ? { ...old, paused: { ...old.paused, auto: on } } : old));
    api.conversations
      .autoContinue(conversationId, on)
      .then((next) => queryClient.setQueryData<ConversationWithMessages>(key, (old) => (old?.paused ? { ...old, paused: next } : old)))
      .catch((err) => {
        void queryClient.invalidateQueries({ queryKey: key });
        Alert.alert(t("pause.autoFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));
      });
  };
  return (
    <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Icon name={limit ? "clock" : "pause"} size={15} color={limit ? c.warning : c.textMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="footnote" muted numberOfLines={2}>
          {limit ? t("thread.paused.limit", { limit: pause.limit ?? t("thread.usageLimit") }) : t("thread.paused.user")}
        </T>
        {reset ? (
          <T variant="caption" muted numberOfLines={1}>
            {reset}
          </T>
        ) : null}
      </View>
      {limit && pause.resumeAt ? (
        <View style={styles.auto}>
          <T variant="caption" muted>
            {t("pause.auto")}
          </T>
          <Switch
            value={pause.auto}
            onValueChange={(on) => {
              tap();
              setAuto(on);
            }}
            accessibilityLabel={t("pause.autoLabel")}
            trackColor={{ true: c.brand, false: c.sunken }}
            style={styles.autoSwitch}
          />
        </View>
      ) : null}
      <Pressable onPress={onContinue} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("common:actions.continue")}>
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          {limit ? t("thread.paused.tryNow") : t("common:actions.continue")}
        </T>
      </Pressable>
    </View>
  );
}

/** Above the composer while the agent is switched off or archived: it answers nothing until it's back. */
function SwitchedOffStrip({ agent }: { agent: Agent }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common", "archive"]);
  const [busy, setBusy] = useState(false);
  const { restore, pending } = useArchive();
  if (agent.archived) {
    const restoring = pending === agent.id;
    return (
      <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityRole="summary">
        <Icon name="archive" size={15} color={c.textMuted} />
        <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
          {t("archive:banner.agent", { name: agent.name })}
        </T>
        {agent.archivedAt ? (
          <Pressable
            onPress={() => restore({ kind: "agent", id: agent.id, name: agent.name })}
            disabled={restoring}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityState={{ busy: restoring, disabled: restoring }}
            style={{ opacity: restoring ? 0.5 : 1 }}
          >
            {restoring ? (
              <ActivityIndicator size="small" color={c.textMuted} />
            ) : (
              <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
                {t("archive:restore")}
              </T>
            )}
          </Pressable>
        ) : null}
      </View>
    );
  }
  const switchOn = () => {
    tap();
    setBusy(true);
    api.agents
      .update(agent.id, { enabled: true })
      .then((next) => {
        queryClient.setQueryData<Agent[]>(qk.agents, (list) => list?.map((a) => (a.id === next.id ? next : a)));
        void queryClient.invalidateQueries({ queryKey: qk.agents });
      })
      .catch((err) => Alert.alert(t("conv.switchOnFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <View style={[styles.paused, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityRole="summary">
      <Icon name="power" size={15} color={c.textMuted} />
      <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
        {t("conv.switchedOff", { name: agent.name })}
      </T>
      <Pressable onPress={switchOn} disabled={busy} hitSlop={10} accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} style={{ opacity: busy ? 0.5 : 1 }}>
        {busy ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : (
          <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
            {t("conv.switchOn")}
          </T>
        )}
      </Pressable>
    </View>
  );
}

/** At the top of a chat that goes on from another one: a fresh start (handoff) or work another agent handed over. */
function OriginLine({ continuedFrom, delegatedFrom }: { continuedFrom: Conversation["continuedFrom"]; delegatedFrom: Conversation["delegatedFrom"] }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  const { byId } = useAgents();
  const source = continuedFrom?.conversationId ?? delegatedFrom?.conversationId ?? null;
  if (!source) return null;
  const from = !continuedFrom && delegatedFrom ? byId.get(delegatedFrom.agentId) : undefined;
  const text = continuedFrom ? t("conv.continuedFrom", { title: continuedFrom.title }) : from ? t("conv.handedOverBy", { name: from.name }) : t("conv.handedOver");
  return (
    <View style={{ alignItems: "center" }}>
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t("conv.openSource")}
        onPress={() => {
          tap();
          router.push({ pathname: "/chat/[id]", params: { id: source } });
        }}
        style={({ pressed }) => [styles.pill, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
      >
        {from ? <CharacterAvatar agent={from} size={18} /> : <Icon name={continuedFrom ? "handoff" : "subagent"} size={13} color={c.textMuted} />}
        <T variant="footnote" numberOfLines={1} style={{ flexShrink: 1 }}>
          {text}
        </T>
        <Icon name="chevron" size={10} weight="semibold" color={c.textFaint} />
      </Pressable>
    </View>
  );
}

/** At the top of a private chat: what it keeps (nothing). */
function PrivateNote() {
  const c = useColors();
  const { t } = useTranslation("chat");
  return (
    <View style={{ alignItems: "center", gap: 6 }}>
      <View style={[styles.pill, { borderColor: c.borderStrong, borderStyle: "dashed" }]}>
        <Icon name="incognito" size={13} color={c.text} />
        <T variant="footnote" style={{ fontWeight: "600" }}>
          {t("conv.private")}
        </T>
      </View>
      <T variant="caption" muted style={{ textAlign: "center", maxWidth: 260 }}>
        {t("conv.privateHint")}
      </T>
    </View>
  );
}

const discarding = new Map<string, ReturnType<typeof setTimeout>>();

/** A private chat lives while it is open: leaving it wipes it on the computer. Coming right back (a remount) keeps it. */
function usePrivateChatLifetime(id: string, isPrivate: boolean) {
  useEffect(() => {
    if (!isPrivate) return;
    clearTimeout(discarding.get(id));
    discarding.delete(id);
    return () => {
      discarding.set(
        id,
        setTimeout(() => {
          discarding.delete(id);
          // What the computer can't wipe now goes when Godmode starts again.
          void api.conversations.delete(id).catch(() => undefined);
          queryClient.removeQueries({ queryKey: qk.conversation(id) });
          void queryClient.invalidateQueries({ queryKey: qk.conversations });
        }, 400),
      );
    };
  }, [id, isPrivate]);
}

/** The chat the /handoff the human sent last opened, once the agent made it. */
function handoffAfterAsk(messages: Message[] | undefined): string | null {
  if (!messages) return null;
  let target: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return isHandoffCommand(m.content) ? target : null;
    if (m.role === "assistant") target ??= handoffChatIn(m.blocks);
  }
  return null;
}

/** Above the composer once the chat gets long: compress it, or go on in a fresh chat. */
function LongChatStrip({ pct, full, onCompress, onHandoff, onHide }: { pct: number | null; full: boolean; onCompress: () => void; onHandoff?: () => void; onHide: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  return (
    <View style={[styles.paused, { backgroundColor: full ? c.dangerSoft : c.warningSoft, borderColor: c.border }]}>
      <Icon name="layers" size={15} color={full ? c.danger : c.warning} />
      <T variant="footnote" style={{ flex: 1 }} numberOfLines={2}>
        {pct !== null ? t("thread.longChat.titlePct", { pct }) : t("thread.longChat.title")}
      </T>
      {onHandoff ? (
        <Pressable onPress={onHandoff} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("conv.handoff")}>
          <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
            {t("conv.newChat")}
          </T>
        </Pressable>
      ) : null}
      <Pressable onPress={() => { tap(); onCompress(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("thread.longChat.compressA11y")}>
        <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
          {t("thread.longChat.compress")}
        </T>
      </Pressable>
      <Pressable onPress={onHide} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("thread.longChat.hide")}>
        <Icon name="close" size={12} weight="semibold" color={c.textFaint} />
      </Pressable>
    </View>
  );
}

/** An empty chat: who it is with. */
function Intro({ agent, running }: { agent: Agent; running: boolean }) {
  return (
    <View style={styles.intro}>
      <CharacterAvatar agent={agent} size={88} running={running} />
      <T variant="headline" style={{ marginTop: 4 }}>
        {agent.name}
      </T>
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
  day: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dayLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  jump: {
    position: "absolute",
    bottom: space.sm,
    alignSelf: "center",
  },
  jumpPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
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
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "88%",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  auto: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  autoSwitch: {
    marginVertical: -6,
    marginHorizontal: -4,
    transform: [{ scale: 0.72 }],
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
});
