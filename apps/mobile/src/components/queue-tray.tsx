import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import type { QueuedMessage } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { api, ApiError, errorText } from "@/lib/api";
import { setQueue } from "@/lib/composer";
import { pendingQueued } from "@/lib/pending-queue";
import { qk, queryClient } from "@/lib/query";
import { radius, space, type, useColors } from "@/lib/theme";

/**
 * On top of the composer: the messages sent while the agent works. The agent takes them at its next step; until then
 * each one can be reworded or taken back, or all of them sent right away.
 */
export function QueueTray({
  conversationId,
  queue,
  agentName,
  running,
  paused,
  onLost,
}: {
  conversationId: string;
  queue: QueuedMessage[];
  agentName: string;
  running: boolean;
  /** The chat's run stands still: the queue goes along when it continues. */
  paused?: "user" | "limit" | null;
  /** A rewording came too late (the agent has the message already): hand the new wording back. */
  onLost: (text: string) => void;
}) {
  const c = useColors();
  const [editing, setEditing] = useState<{ id: string; text: string; from: string } | null>(null);
  const [sendingNow, setSendingNow] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
  const gone = (err: unknown) => err instanceof ApiError && err.status === 404;

  const save = (m: QueuedMessage, next: string) => {
    setEditing(null);
    const content = next.trim();
    if (content === m.content || (!content && m.attachments.length === 0)) return;
    setQueue(conversationId, (q) => q.map((x) => (x.id === m.id ? { ...x, content } : x)));
    api.conversations.queue.edit(conversationId, m.id, content).catch((err) => {
      refresh();
      if (gone(err)) {
        onLost(content);
        Alert.alert(`${agentName} already has that message`, "Your new wording is in the message field — send it as a follow-up.");
      } else Alert.alert("Couldn't change the message", errorText(err));
    });
  };

  const remove = (m: QueuedMessage) => {
    tap();
    if (editing?.id === m.id) setEditing(null);
    setQueue(conversationId, (q) => q.filter((x) => x.id !== m.id));
    api.conversations.queue.remove(conversationId, m.id).catch((err) => {
      refresh();
      if (!gone(err)) Alert.alert("Couldn't remove the message", errorText(err));
    });
  };

  const sendNow = () => {
    tap();
    setSendingNow(true);
    api.conversations.queue
      .sendNow(conversationId)
      .catch((err) => {
        refresh();
        if (!gone(err)) Alert.alert("Couldn't send the queue", errorText(err));
      })
      .finally(() => setSendingNow(false));
  };

  // The agent took the message while it was being reworded.
  const taken = !!editing && !queue.some((m) => m.id === editing.id);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const current = editingRef.current;
    if (!taken || !current) return;
    setEditing(null);
    const next = current.text.trim();
    if (next && next !== current.from) onLost(next);
  }, [taken, onLost]);

  if (queue.length === 0) return null;

  const first = queue[0];
  const many = queue.length > 1;
  const live = running || !!paused;
  const hint = sendingNow
    ? running
      ? "Stopping the current step…"
      : "Sending…"
    : paused
      ? `${many ? "Go" : "Goes"} along when ${paused === "limit" ? "the limit resets" : "you continue"}`
      : !running
        ? "Not sent yet"
        : first && parseSlashCommand(first.content)
          ? `Runs when ${agentName} is done`
          : `${agentName} picks ${many ? "these" : "this"} up at its next step`;

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      layout={LinearTransition.duration(180)}
      style={[styles.tray, { backgroundColor: c.surface, borderColor: c.border }]}
      accessibilityLabel="Queued messages"
    >
      <View style={styles.head}>
        <T variant="eyebrow" muted style={{ fontSize: 10 }}>
          Queued
        </T>
        <View style={[styles.count, { backgroundColor: c.sunken }]}>
          <T variant="caption" style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>
            {queue.length}
          </T>
        </View>
        <T variant="caption" muted numberOfLines={1} style={{ flex: 1 }} accessibilityLiveRegion="polite">
          {hint}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={live ? `Send now: stop what ${agentName} is doing and start on the queue` : "Send"}
          disabled={sendingNow || queue.every((m) => pendingQueued.has(m.id))}
          onPress={sendNow}
          hitSlop={8}
          style={({ pressed }) => [styles.sendNow, { backgroundColor: live ? "transparent" : c.primary, opacity: pressed ? 0.6 : 1 }]}
        >
          {sendingNow ? (
            <ActivityIndicator size="small" color={c.textMuted} />
          ) : (
            <Icon name={live ? "bolt" : "send"} size={12} weight="bold" color={live ? c.text : c.onPrimary} />
          )}
          <T variant="footnote" color={live ? c.text : c.onPrimary} style={{ fontWeight: "600" }}>
            {live ? "Send now" : "Send"}
          </T>
        </Pressable>
      </View>
      <ScrollView style={{ maxHeight: 168 }} contentContainerStyle={styles.rows} keyboardShouldPersistTaps="handled">
        {queue.map((m, i) => (
          <Row
            key={m.id}
            index={i + 1}
            message={m}
            draft={editing?.id === m.id ? editing.text : null}
            onDraft={(text) => setEditing((e) => e && { ...e, text })}
            onEdit={() => {
              tap();
              setEditing({ id: m.id, text: m.content, from: m.content });
            }}
            onSave={(text) => save(m, text)}
            onRemove={() => remove(m)}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}

function Row({
  index,
  message,
  draft,
  onDraft,
  onEdit,
  onSave,
  onRemove,
}: {
  index: number;
  message: QueuedMessage;
  draft: string | null;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onSave: (text: string) => void;
  onRemove: () => void;
}) {
  const c = useColors();
  const pending = pendingQueued.has(message.id);
  const editing = draft !== null;
  const files = message.attachments.length;
  const command = parseSlashCommand(message.content);
  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      layout={LinearTransition.duration(160)}
      style={[styles.row, editing && { backgroundColor: c.sunken }]}
    >
      <T variant="caption" style={[type.mono, styles.index, { color: c.textFaint }]}>
        {index}
      </T>
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={onDraft}
          autoFocus
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
          onBlur={() => onSave(draft)}
          accessibilityLabel="Queued message"
          style={[styles.editor, { color: c.text }]}
        />
      ) : (
        <Pressable accessibilityRole="button" accessibilityHint="Edit message" disabled={pending} onPress={onEdit} style={{ flex: 1, opacity: pending ? 0.55 : 1 }}>
          <T variant="subhead" numberOfLines={2}>
            {command ? <T style={[type.mono, { fontWeight: "600", color: c.text, fontSize: 13 }]}>/{command.name} </T> : null}
            {command ? command.args : message.content || <T muted>{files > 1 ? `${files} files` : message.attachments[0]?.name}</T>}
          </T>
        </Pressable>
      )}
      {files > 0 && !editing ? (
        <View style={styles.files}>
          <Icon name="paperclip" size={11} color={c.textMuted} />
          <T variant="caption" muted>
            {files}
          </T>
        </View>
      ) : null}
      {pending ? (
        <ActivityIndicator size="small" color={c.textFaint} style={styles.action} />
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Remove from the queue" hitSlop={8} onPress={onRemove} style={styles.action}>
          <Icon name="close" size={12} weight="semibold" color={c.textMuted} />
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tray: {
    marginHorizontal: space.lg,
    marginTop: space.xs,
    marginBottom: space.sm,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    paddingLeft: 14,
    paddingRight: 6,
  },
  count: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  sendNow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  rows: {
    paddingHorizontal: 6,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 7,
    paddingLeft: 8,
    paddingRight: 4,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  index: {
    width: 14,
    textAlign: "right",
    marginTop: 2,
  },
  editor: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
    padding: 0,
    maxHeight: 120,
  },
  files: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 2,
  },
  action: {
    width: 26,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
