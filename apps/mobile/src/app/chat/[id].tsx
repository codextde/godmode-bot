import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConversationWithMessages, Message, MessageBlock } from "@godmode/shared";
import { Composer, ComposerDock } from "@/components/composer";
import { HeaderActions } from "@/components/header-actions";
import { LiveStrip } from "@/components/live-strip";
import { AssistantMessage, UserMessage } from "@/components/message";
import { Avatar, EmptyState, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useConversationRun, useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { subscribeConversation } from "@/lib/realtime";
import { screenHref, useChatScreens } from "@/lib/screens";
import { space } from "@/lib/theme";

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

  const send = async (content: string) => {
    try {
      const result = await api.conversations.send(id, content);
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
              agent ? <Intro emoji={agent.avatar} name={agent.name} description={agent.description} /> : null
            ) : item.role === "user" ? (
              <UserMessage message={item.message} />
            ) : (
              <AssistantMessage blocks={item.blocks} content={item.content} streaming={item.streaming} />
            )
          }
          getItemType={(item) => item.role}
        />
        {run && primary ? <LiveStrip screen={primary} activity={run.activity} /> : null}
        <ComposerDock>
          <Composer
            onSend={send}
            onStop={stop}
            running={!!run}
            placeholder={agent ? `Message ${agent.name}` : "Message"}
            disabled={agent ? !agent.enabled : false}
          />
        </ComposerDock>
        <View style={{ height: keyboardOpen ? space.sm : Math.max(insets.bottom, space.md) }} />
      </KeyboardAvoidingView>
    </>
  );
}

function Intro({ emoji, name, description }: { emoji: string; name: string; description: string }) {
  return (
    <View style={styles.intro}>
      <Avatar emoji={emoji} size={52} />
      <T variant="headline">{name}</T>
      {description ? (
        <T variant="footnote" muted style={{ textAlign: "center", maxWidth: 280 }} numberOfLines={3}>
          {description}
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
  intro: {
    alignItems: "center",
    gap: 6,
    paddingTop: space.lg,
    paddingBottom: 6,
  },
});
