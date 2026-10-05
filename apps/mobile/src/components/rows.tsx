import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, Conversation } from "@godmode/shared";
import { agentPresence, presenceLabel } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { Badge, Card, LiveDot, Row, T, tap } from "./ui";
import { api } from "@/lib/api";
import { activityText, elapsed, shortTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { LiveRun } from "@/lib/live";
import { radius, space, useColors } from "@/lib/theme";

const ORIGIN_LABEL: Partial<Record<Conversation["origin"], string>> = {
  routine: "Automation",
  delegation: "Handed over",
  slack: "Slack",
  telegram: "Telegram",
  teams: "Teams",
  api: "Chat",
};

export function openChat(id: string) {
  tap();
  router.push({ pathname: "/chat/[id]", params: { id } });
}

export function ConversationRow({ conversation, agent, running }: { conversation: Conversation; agent?: Agent; running?: boolean }) {
  const c = useColors();
  const origin = ORIGIN_LABEL[conversation.origin];
  return (
    <Pressable onPress={() => openChat(conversation.id)} style={({ pressed }) => [styles.convo, pressed && { backgroundColor: c.sunken }]}>
      <CharacterAvatar agent={agent} size={44} running={running} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row style={{ gap: space.sm }}>
          {conversation.pinned && <Icon name="pin" size={11} color={c.textMuted} />}
          <T variant="headline" numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>
            {conversation.title || "New chat"}
          </T>
          <T variant="footnote" color={running ? c.brandStrong : c.textMuted} style={running ? { fontWeight: "600" } : undefined}>
            {running ? "Working" : shortTime(conversation.lastMessageAt ?? conversation.createdAt)}
          </T>
        </Row>
        <T variant="subhead" muted numberOfLines={2}>
          {origin ? <T variant="subhead" color={c.text} style={{ fontWeight: "500" }}>{`${origin} · `}</T> : null}
          {agent ? `${agent.name}: ` : ""}
          {conversation.preview || "No messages yet"}
        </T>
      </View>
    </Pressable>
  );
}

export function RunCard({ live, agent, title }: { live: LiveRun; agent?: Agent; title?: string }) {
  const c = useColors();
  const now = useNow(1000);
  const { run, activity } = live;
  const queued = run.status === "queued";
  return (
    <Card onPress={() => openChat(run.conversationId)} style={styles.run}>
      <Row style={{ gap: space.md }}>
        <CharacterAvatar agent={agent} size={40} mood={queued ? "idle" : "working"} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
            {agent?.name ?? "Agent"}
          </T>
          <T variant="footnote" muted numberOfLines={1}>
            {title || run.prompt.slice(0, 80) || "Working on a task"}
          </T>
        </View>
        <Pressable
          accessibilityLabel="Stop"
          hitSlop={8}
          onPress={() => {
            tap();
            void api.runs.cancel(run.id);
          }}
          style={({ pressed }) => [styles.stop, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon name="stop" size={12} color={c.text} />
        </Pressable>
      </Row>
      <Row style={[styles.activity, { backgroundColor: c.surfaceAlt }]}>
        <LiveDot live={!queued} />
        <T variant="footnote" numberOfLines={1} style={{ flex: 1, fontWeight: "500" }}>
          {queued ? "Waiting to start" : activityText(activity)}
        </T>
        <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
          {elapsed(run.startedAt ?? run.createdAt, now)}
        </T>
      </Row>
    </Card>
  );
}

export function AgentRow({ agent, running, queued, onPress }: { agent: Agent; running?: number; queued?: number; onPress: () => void }) {
  const c = useColors();
  // The same states as the desktop; an idle agent says when it last worked.
  const presence = agentPresence(agent, { running, queued });
  const status = presence.state === "idle" ? (agent.lastRunAt ? `Active ${shortTime(agent.lastRunAt)}` : "Ready") : presenceLabel(presence);
  const busy = presence.state === "working";
  const subtitle = agent.role || agent.description;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.agent, pressed && { backgroundColor: c.sunken }]}>
      <CharacterAvatar agent={agent} size={46} running={busy} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flexShrink: 1, fontSize: 16 }}>
            {agent.name}
          </T>
          {agent.isDefault && <Badge label="Main" />}
        </Row>
        <T variant="subhead" muted numberOfLines={1}>
          {subtitle || status}
        </T>
      </View>
      <T variant="footnote" color={busy ? c.brandStrong : presence.state === "failed" ? c.danger : presence.state === "waiting" ? c.warning : c.textMuted}>
        {busy ? (presence.running > 1 ? `${presence.running} chats` : "Working") : subtitle ? status : ""}
      </T>
      <Icon name="chevron" size={13} color={c.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  convo: {
    flexDirection: "row",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  run: {
    padding: space.md,
    gap: space.md,
  },
  stop: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  activity: {
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
});
