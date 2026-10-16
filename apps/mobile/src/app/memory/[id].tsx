import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useMemo, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Agent, AgentMemory } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { Button, Card, EmptyState, ErrorState, LoadingState, Row, T } from "@/components/ui";
import { api, ApiError, errorText, UPDATE_DESKTOP_MESSAGE } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { alpha, fonts, radius, space, useColors } from "@/lib/theme";
import { usePullRefresh } from "@/lib/use-pull-refresh";

interface Section {
  title: string | null;
  text: string;
}

/** MEMORY.md cut at its headings (outside code fences), so the reader can jump between them. */
function splitSections(text: string): Section[] {
  const out: Section[] = [];
  let current: { title: string | null; lines: string[] } = { title: null, lines: [] };
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (current.lines.join("").trim()) out.push({ title: current.title, text: current.lines.join("\n") });
      current = { title: heading[1]!.replace(/[*_`]/g, ""), lines: [line] };
    } else current.lines.push(line);
  }
  if (current.lines.join("").trim()) out.push({ title: current.title, text: current.lines.join("\n") });
  return out;
}

export default function MemoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agents = useAgents();
  const agent = agents.byId.get(id);
  const memory = useQuery({
    queryKey: qk.agentMemory(id),
    queryFn: () => api.agents.memory(id),
    refetchOnMount: "always",
    retry: (count, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && count < 2,
  });
  const tooOld = memory.error instanceof ApiError && (memory.error.code === "device_forbidden" || memory.error.status === 404) && !!agent;

  if (!memory.data || !agent) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Screen options={{ title: "Memory", headerLargeTitleEnabled: false }} />
        {memory.isError ? (
          <ErrorState title="Couldn't open the memory" error={tooOld ? UPDATE_DESKTOP_MESSAGE : errorText(memory.error)} onRetry={tooOld ? undefined : () => void memory.refetch()} />
        ) : !agent && !agents.isLoading ? (
          <ErrorState title="Agent not found" error="It may have been deleted on your computer." />
        ) : (
          <LoadingState label="Opening the memory…" />
        )}
      </View>
    );
  }
  return <MemoryView agent={agent} memory={memory.data} refetch={memory.refetch} />;
}

function MemoryView({ agent, memory, refetch }: { agent: Agent; memory: AgentMemory; refetch: () => Promise<unknown> }) {
  const c = useColors();
  const navigation = useNavigation();
  const pull = usePullRefresh(refetch);
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<number[]>([]);
  const readerY = useRef(0);
  // On iOS the content scrolls under the glass header.
  const insets = useSafeAreaInsets();
  const headerInset = process.env.EXPO_OS === "ios" ? insets.top + 52 : 0;
  /** The edit, and the version (digest and text) it started from. */
  const [draft, setDraft] = useState<{ text: string; base: string; baseText: string } | null>(null);
  const editing = draft !== null;
  const dirty = editing && draft.text !== draft.baseText;
  const sections = useMemo(() => splitSections(memory.content), [memory.content]);
  const titled = sections.filter((s) => s.title);

  const save = useMutation({
    mutationFn: ({ text, base }: { text: string; base?: string }) => api.agents.saveMemory(agent.id, text, base),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.agentMemory(agent.id), next);
      setDraft(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.code === "memory_changed") {
        Alert.alert("The memory changed meanwhile", `${agent.name} rewrote MEMORY.md while you were editing.`, [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Load the new version",
            onPress: () => {
              setDraft(null);
              void refetch();
            },
          },
          { text: "Overwrite with mine", style: "destructive", onPress: () => save.mutate({ text: vars.text }) },
        ]);
        void refetch();
        return;
      }
      Alert.alert("Couldn't save the memory", errorText(err));
    },
  });

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert("Discard your changes?", "Your edits to the memory haven't been saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const startEdit = () => {
    if (memory.dreaming) {
      Alert.alert(`${agent.name} is dreaming`, "It is tidying up its memory right now. Edit it when the dream has ended.");
      return;
    }
    setDraft({ text: memory.content, base: memory.digest, baseText: memory.content });
  };
  const discard = () => {
    if (!dirty) return setDraft(null);
    Alert.alert("Discard your changes?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => setDraft(null) },
    ]);
  };

  const chars = draft?.text.length ?? memory.chars;

  return (
    <ScrollView
      ref={scroll}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      refreshControl={editing ? undefined : <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: "Memory", headerLargeTitleEnabled: false }} />
      {editing ? (
        <HeaderActions
          actions={[{ icon: "check", label: "Save", prominent: true, onPress: () => draft && !save.isPending && save.mutate({ text: draft.text, base: draft.base }) }]}
          menu={[{ icon: "close", title: dirty ? "Discard changes" : "Stop editing", onPress: discard, destructive: dirty }]}
        />
      ) : (
        <HeaderActions actions={[{ icon: "pencil", label: "Edit memory", onPress: startEdit }]} />
      )}

      <Row style={{ gap: space.md }}>
        <CharacterAvatar agent={agent} size={40} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="headline" numberOfLines={1}>
            {agent.name}
          </T>
          <T variant="footnote" muted numberOfLines={1}>
            <T variant="footnote" muted style={{ fontFamily: fonts.mono }}>
              MEMORY.md
            </T>
            {memory.updatedAt ? `  ·  updated ${formatDistanceToNowStrict(new Date(memory.updatedAt), { addSuffix: true })}` : "  ·  not written yet"}
          </T>
        </View>
        {save.isPending ? <T variant="caption" muted>Saving…</T> : dirty ? <T variant="caption" color={c.warning}>Unsaved</T> : null}
      </Row>

      <Budget chars={chars} memory={memory} />

      {memory.dreaming ? (
        <Row style={[styles.banner, { backgroundColor: c.dreamSoft }]}>
          <Icon name="moon" size={14} color={c.dream} />
          <T variant="footnote" style={{ flex: 1 }}>
            {agent.name} is dreaming — it is tidying up this memory. Editing is paused until the dream ends.
          </T>
        </Row>
      ) : null}

      {editing ? (
        <View style={[styles.editor, { backgroundColor: c.surface, borderColor: c.borderStrong }]}>
          <TextInput
            accessibilityLabel={`MEMORY.md of ${agent.name}`}
            value={draft.text}
            onChangeText={(text) => setDraft((d) => (d ? { ...d, text } : d))}
            multiline
            scrollEnabled={false}
            autoFocus
            editable={!save.isPending}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder={"# Memory\n\n- One short line per fact"}
            placeholderTextColor={c.textFaint}
            style={[styles.input, { color: c.text }]}
          />
        </View>
      ) : !memory.content.trim() ? (
        <EmptyState
          icon="brain"
          title="Nothing remembered yet"
          body={`${agent.name} writes down what it learns here: your preferences, how your accounts work, open follow-ups. You can start it yourself.`}
          action={<Button title="Write the first note" icon="pencil" variant="secondary" onPress={startEdit} />}
        />
      ) : (
        <>
          {titled.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ marginHorizontal: -space.lg }}>
              <View style={{ width: space.lg - 6 }} />
              {sections.map((s, i) =>
                s.title ? (
                  <Pressable
                    key={`${i}-${s.title}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Jump to ${s.title}`}
                    onPress={() => scroll.current?.scrollTo({ y: Math.max(0, readerY.current + space.lg + (offsets.current[i] ?? 0) - headerInset - space.md), animated: true })}
                    style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? c.sunken : c.surface, borderColor: c.border }]}
                  >
                    <T variant="footnote" numberOfLines={1} style={{ maxWidth: 180 }}>
                      {s.title}
                    </T>
                  </Pressable>
                ) : null,
              )}
              <View style={{ width: space.lg - 6 }} />
            </ScrollView>
          ) : null}
          <View onLayout={(e) => (readerY.current = e.nativeEvent.layout.y)}>
          <Card style={styles.reader}>
            {sections.map((s, i) => (
              <View
                key={`${i}-${s.title}`}
                onLayout={(e) => {
                  offsets.current[i] = e.nativeEvent.layout.y;
                }}
              >
                <Markdown text={s.text} />
              </View>
            ))}
          </Card>
          </View>
          <T variant="footnote" muted style={{ textAlign: "center", paddingHorizontal: space.lg }}>
            {agent.name} keeps this file itself and tidies it while dreaming. Your edits guide what it remembers.
          </T>
        </>
      )}
    </ScrollView>
  );
}

/** What the memory takes of what dreams keep it under (`target`); past `limit` chats only load its start. */
function Budget({ chars, memory }: { chars: number; memory: Pick<AgentMemory, "target" | "limit"> }) {
  const c = useColors();
  const { target, limit } = memory;
  const cut = chars > limit;
  const over = chars > target;
  const tone = cut ? c.danger : over ? c.warning : c.dream;
  const hint = cut
    ? `Chats load only the first ${limit.toLocaleString()} characters — the end is missing.`
    : over
      ? `${(chars - target).toLocaleString()} over the target. The next dream shortens it.`
      : "Loaded in full into every chat.";
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <T variant="footnote" style={{ fontVariant: ["tabular-nums"] }}>
          <T variant="footnote" color={cut || over ? tone : c.text} style={{ fontWeight: "600" }}>
            {chars.toLocaleString()}
          </T>
          <T variant="footnote" muted>{` of ${target.toLocaleString()} characters`}</T>
        </T>
      </Row>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Size of the memory"
        accessibilityValue={{ min: 0, max: limit, now: Math.min(chars, limit) }}
        style={[styles.track, { backgroundColor: c.sunken }]}
      >
        <View style={[styles.fill, { width: `${Math.min(100, (chars / limit) * 100)}%`, backgroundColor: alpha(tone, cut || over ? 1 : 0.7) }]} />
        <View style={[styles.tick, { left: `${(target / limit) * 100}%`, backgroundColor: alpha(c.text, 0.35) }]} />
      </View>
      <T variant="caption" muted>
        {hint}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 80,
    gap: space.lg,
  },
  banner: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  editor: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  input: {
    minHeight: 320,
    padding: space.md,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  reader: {
    padding: space.lg,
    gap: space.md,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  track: {
    height: 5,
    borderRadius: radius.pill,
    overflow: "visible",
  },
  fill: {
    height: "100%",
    borderRadius: radius.pill,
  },
  tick: {
    position: "absolute",
    top: -2,
    bottom: -2,
    width: 1,
  },
});
