import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { tokensLabel } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { toneColor } from "@/components/context-ring";
import { Button, Card, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { compressChat, isCompressCommand, useContextGauge } from "@/lib/chat-memory";
import { useAgents } from "@/lib/hooks";
import { useChatRun } from "@/lib/live";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** How full a chat's memory is, and Compress: Claude Code turns the conversation so far into a summary. */
export default function ChatMemorySheet() {
  const c = useColors();
  const { conversationId = "" } = useLocalSearchParams<{ conversationId: string }>();
  const conversation = useQuery({ queryKey: qk.conversation(conversationId), queryFn: () => fetchConversation(conversationId), enabled: !!conversationId });
  const { byId } = useAgents();
  const agentName = byId.get(conversation.data?.agentId ?? "")?.name ?? "The agent";
  const run = useChatRun(conversationId);
  const gauge = useContextGauge(conversation.data?.context);
  const [busy, setBusy] = useState(false);
  const queued = conversation.data?.queue.some((m) => isCompressCommand(m.content)) ?? false;

  const compress = async () => {
    setBusy(true);
    try {
      await compressChat(conversationId);
      router.back();
    } catch (err) {
      Alert.alert("Couldn't compress the chat", errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pct = gauge?.share != null ? Math.round(gauge.share * 100) : null;
  const color = gauge ? toneColor(c, gauge.tone) : c.textMuted;

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: c.background }}>
      <View style={{ gap: 4 }}>
        <T variant="title">Chat memory</T>
        <T variant="subhead" muted>
          What {agentName} carries along with every step of this chat.
        </T>
      </View>

      <Card style={{ padding: space.lg, gap: space.md }}>
        {gauge ? (
          <>
            <View style={styles.row}>
              <View style={styles.amount}>
                <T variant="largeTitle" style={{ fontVariant: ["tabular-nums"] }}>
                  {tokensLabel(gauge.tokens)}
                </T>
                <T variant="footnote" muted>
                  {gauge.window ? `of ${tokensLabel(gauge.window)} tokens` : "tokens"}
                </T>
              </View>
              {pct !== null ? (
                <T variant="headline" color={color} style={{ fontVariant: ["tabular-nums"] }}>
                  {pct}%
                </T>
              ) : null}
            </View>
            {gauge.share !== null ? (
              <View style={[styles.track, { backgroundColor: c.sunken }]}>
                <View style={[styles.fill, { width: `${Math.max(1.5, gauge.share * 100)}%`, backgroundColor: gauge.tone === "calm" ? c.text : color }]} />
                {gauge.autoAt !== null ? <View style={[styles.tick, { left: `${gauge.autoAt * 100}%`, backgroundColor: c.textMuted }]} /> : null}
              </View>
            ) : null}
            <T variant="footnote" muted>
              {gauge.autoAt === null ? "Auto-compress is off." : `Compresses by itself at ${Math.round(gauge.autoAt * 100)}%.`}
            </T>
          </>
        ) : (
          <T variant="subhead" muted>
            Known after {agentName}'s next answer in this chat.
          </T>
        )}
      </Card>

      <T variant="subhead" muted>
        Compress turns the conversation so far into a short summary. {agentName} keeps the gist, your instructions and its files, and every next step gets faster and cheaper.
      </T>

      <Button
        title={queued ? "Compress is queued" : !gauge?.compressible ? "Nothing to compress yet" : run ? "Compress after this step" : "Compress now"}
        icon="layers"
        loading={busy}
        disabled={!gauge?.compressible || queued}
        onPress={() => void compress()}
      />

      <Pressable
        accessibilityRole="link"
        onPress={() => {
          tap();
          router.push("/settings/ai");
        }}
        style={({ pressed }) => [styles.link, { opacity: pressed ? 0.6 : 1 }]}
      >
        <T variant="footnote" muted style={{ flex: 1 }}>
          Auto-compress setting
        </T>
        <Icon name="chevron" size={12} weight="semibold" color={c.textFaint} />
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  row: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: space.md },
  amount: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  track: { height: 6, borderRadius: radius.pill, overflow: "visible", position: "relative" },
  fill: { height: 6, borderRadius: radius.pill },
  tick: { position: "absolute", top: -4, width: 1.5, height: 14, borderRadius: 1 },
  link: { flexDirection: "row", alignItems: "center", paddingVertical: space.sm },
});
