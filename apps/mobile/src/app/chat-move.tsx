import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ConversationWithMessages } from "@godmode/shared";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { Button, Card, LoadingState, T, tap } from "@/components/ui";
import { fetchConversation } from "@/lib/chat-cache";
import { moveTargets, usePlaces, type Place } from "@/lib/chat-extras";
import { startChatMove, useChatMoves } from "@/lib/chat-moves";
import { useAgents } from "@/lib/hooks";
import { useChatRun } from "@/lib/live";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/**
 * Move a chat to another computer of the group with its Claude session, like the desktop. While the agent works the
 * run stops here and continues there. The sheet closes and the chat shows how far it is.
 */
export default function ChatMove() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const conversation = useQuery({ queryKey: qk.conversation(conversationId), queryFn: () => fetchConversation(conversationId), staleTime: Infinity });
  const places = usePlaces(fullAccess === true);
  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (!conversation.data) return <LoadingState />;
  return <MoveForm conversation={conversation.data} places={places} />;
}

function MoveForm({ conversation, places }: { conversation: ConversationWithMessages; places: Place[] }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const agentName = useAgents().byId.get(conversation.agentId)?.name ?? t("thread.theAgent");
  const working = !!useChatRun(conversation.id);
  const from = places.find((p) => p.runnerId === (conversation.runnerId ?? null)) ?? null;
  const targets = moveTargets(places, conversation.runnerId);
  const [to, setTo] = useState<Place | null>(targets[0] ?? null);
  const fromName = from?.name ?? t("move.theOtherComputer");
  const dest = to?.name ?? t("move.anotherComputer");

  const moving = useChatMoves((s) => !!s.moves[conversation.id]);
  const move = () => {
    startChatMove({ conversationId: conversation.id, input: { to: to!.runnerId, force: working || undefined }, dest, agentName, working });
    router.back();
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={{ gap: space.xs }}>
        <T variant="title">{t("move.title", { dest })}</T>
        <T variant="subhead" muted>
          {working ? t("move.working", { agent: agentName, from: fromName, dest }) : t("move.idle", { agent: agentName, dest })}
        </T>
      </View>
      <View style={styles.route}>
        <PlaceTag name={fromName} />
        <Icon name="chevron" size={11} color={c.textMuted} weight="semibold" />
        <PlaceTag name={dest} active />
      </View>
      {targets.length > 1 ? (
        <Card style={{ overflow: "hidden" }}>
          {targets.map((p) => {
            const on = to?.runnerId === p.runnerId;
            return (
              <Pressable
                key={p.runnerId ?? "primary"}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => {
                  tap();
                  setTo(p);
                }}
                style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.sunken }]}
              >
                <Icon name="laptop" size={16} color={c.textMuted} />
                <T variant="callout" style={{ flex: 1 }}>
                  {p.name}
                </T>
                {on ? <Icon name="check" size={14} color={c.brandStrong} weight="bold" /> : null}
              </Pressable>
            );
          })}
        </Card>
      ) : null}
      <T variant="footnote" muted style={{ paddingHorizontal: space.xs }}>
        {from && from.state !== "online" ? t("move.away", { name: fromName }) : t("move.filesStay", { name: fromName })}
      </T>
      {!targets.length ? (
        <T variant="footnote" color={c.warning} style={{ paddingHorizontal: space.xs }}>
          {t("move.noTarget")}
        </T>
      ) : null}
      <View style={{ gap: space.sm }}>
        <Button title={moving ? t("move.moving") : working ? t("move.moveAndContinue") : t("move.move")} icon="laptop" loading={moving} disabled={!to} onPress={move} />
        <Button title={t("common:actions.cancel")} variant="secondary" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

function PlaceTag({ name, active }: { name: string; active?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.tag, { borderColor: active ? c.brand : c.border, backgroundColor: active ? c.brandSoft : c.surface }]}>
      <Icon name="laptop" size={14} color={active ? c.brandStrong : c.textMuted} />
      <T variant="footnote" numberOfLines={1} color={active ? c.brandStrong : c.text} style={{ flex: 1, fontWeight: "600" }}>
        {name}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  route: { flexDirection: "row", alignItems: "center", gap: space.sm },
  tag: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, minHeight: 48 },
});
