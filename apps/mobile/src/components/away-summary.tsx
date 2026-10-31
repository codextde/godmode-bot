import { useQuery } from "@tanstack/react-query";
import { formatDistanceStrict } from "date-fns";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type { AwayHighlight } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon, type IconName } from "./icon";
import { openChat } from "./rows";
import { openTask } from "./task-row";
import { Card, Hairline, Row, T, tap } from "./ui";
import { api } from "@/lib/api";
import { useAwayStore } from "@/lib/away";
import { useAgents } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { qk } from "@/lib/query";
import { space, useColors, type Colors } from "@/lib/theme";

const ICON: Record<AwayHighlight["kind"], IconName> = { delivered: "tasks", failed: "warning", replied: "chats", automation: "workflow" };

const tone = (c: Colors, kind: AwayHighlight["kind"]) => (kind === "failed" || kind === "automation" ? c.danger : kind === "delivered" ? c.brandStrong : c.textMuted);

/** A highlight's desktop route on the phone: a chat, a ticket, or the board. */
function open(link: string) {
  const chat = /^\/chat\/([^/?#]+)/.exec(link);
  if (chat) return openChat(chat[1]!);
  const task = /[?&]task=([^&#]+)/.exec(link);
  if (task) return openTask(task[1]!);
  tap();
  router.push(link.startsWith("/tasks") ? "/tasks" : "/activity");
}

/**
 * First thing on Home after the human was away for a while: what the team did meanwhile — who worked,
 * and the few things worth a look. Closed with ×; it doesn't come back until the next time they were away.
 */
export function AwaySummaryCard() {
  const c = useColors();
  const { t } = useTranslation("components");
  const away = useAwayStore((s) => s.away);
  const dismiss = useAwayStore((s) => s.dismiss);
  const { byId: agents } = useAgents();
  const { data } = useQuery({
    queryKey: qk.away(away?.since ?? ""),
    queryFn: () => api.away(away!.since, away!.until),
    enabled: !!away,
    staleTime: 60_000,
  });
  if (!away || !data || (data.finished === 0 && data.delivered === 0)) return null;
  const facts = [
    t("awaySummary.runsFinished", { count: data.finished }),
    data.failed ? t("awaySummary.problems", { count: data.failed }) : null,
    data.delivered ? t("awaySummary.ticketsDelivered", { count: data.delivered }) : null,
  ].filter(Boolean);
  const now = new Date();
  const locale = dateLocale();

  return (
    <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)} style={styles.section}>
      <Row style={styles.head}>
        <T variant="eyebrow" muted numberOfLines={1} style={{ flexShrink: 1 }}>
          {t("awaySummary.title", { duration: formatDistanceStrict(new Date(away.since), new Date(away.until), { locale }) })}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("awaySummary.close")}
          hitSlop={12}
          onPress={() => {
            tap();
            dismiss();
          }}
          style={({ pressed }) => [styles.close, { opacity: pressed ? 0.5 : 1 }]}
        >
          <Icon name="close" size={12} color={c.textMuted} weight="semibold" />
        </Pressable>
      </Row>
      <Card style={{ overflow: "hidden" }}>
        <Pressable
          accessibilityRole="link"
          accessibilityHint={t("awaySummary.openActivity")}
          onPress={() => {
            tap();
            router.push("/activity");
          }}
          style={({ pressed }) => [styles.facts, pressed && { backgroundColor: c.sunken }]}
        >
          <Row style={{ gap: space.sm }}>
            <T variant="subhead" style={{ flex: 1, fontWeight: "500" }}>
              {facts.join(" · ")}
            </T>
            <Icon name="chevron" size={11} color={c.textFaint} weight="semibold" />
          </Row>
          {data.agents.length > 0 && (
            <View style={styles.agents} accessibilityLabel={t("awaySummary.whoWorked")}>
              {data.agents.slice(0, 5).map((a) => {
                const agent = agents.get(a.agentId);
                return (
                  <Row key={a.agentId} style={{ gap: 5 }}>
                    {agent ? <CharacterAvatar agent={agent} size={18} /> : null}
                    <T variant="caption">{a.name}</T>
                    <T variant="caption" muted style={styles.num}>
                      {a.runs}
                    </T>
                  </Row>
                );
              })}
            </View>
          )}
        </Pressable>
        {data.highlights.map((h) => (
          <View key={`${h.kind}:${h.link}`}>
            <Hairline inset={space.lg} />
            <Pressable accessibilityRole="link" onPress={() => open(h.link)} style={({ pressed }) => [styles.highlight, pressed && { backgroundColor: c.sunken }]}>
              <Icon name={ICON[h.kind]} size={13} color={tone(c, h.kind)} />
              <T variant="footnote" numberOfLines={1} style={{ flex: 1 }}>
                {h.text}
              </T>
              <T variant="caption" muted style={styles.num}>
                {formatDistanceStrict(new Date(h.at), now, { addSuffix: true, locale })}
              </T>
            </Pressable>
          </View>
        ))}
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: space.sm,
  },
  head: {
    gap: space.sm,
    paddingHorizontal: 4,
    marginBottom: space.sm,
  },
  close: {
    marginLeft: "auto",
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  facts: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  agents: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: space.md,
    rowGap: 4,
  },
  highlight: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  num: {
    fontVariant: ["tabular-nums"],
  },
});
