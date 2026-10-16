import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { presenceLabel } from "@godmode/shared";
import { CharacterAvatar, moodOf, useAgentPresence } from "./character";
import { ProjectTag } from "./project-picker";
import { Icon } from "./icon";
import { Badge, Card, LiveDot, Row, T, tap } from "./ui";
import { api } from "@/lib/api";
import { activityText, elapsed, shortTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { LiveRun } from "@/lib/live";
import { alpha, radius, space, useColors } from "@/lib/theme";

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

export function ConversationRow({
  conversation,
  agent,
  running,
  project,
}: {
  conversation: Conversation;
  agent?: Agent;
  running?: boolean;
  /** The project it works on, when the list isn't scoped to it already. */
  project?: Pick<Project, "name" | "icon">;
}) {
  const c = useColors();
  const origin = ORIGIN_LABEL[conversation.origin];
  return (
    <Pressable onPress={() => openChat(conversation.id)} style={({ pressed }) => [styles.convo, pressed && { backgroundColor: c.sunken }]}>
      <CharacterAvatar agent={agent} size={44} running={running} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row style={{ gap: space.sm }}>
          {conversation.pinned && <Icon name="pin" size={11} color={c.textMuted} />}
          <T variant="headline" numberOfLines={1} style={{ flexShrink: 1, fontSize: 16 }}>
            {conversation.title || "New chat"}
          </T>
          {project ? <ProjectTag project={project} /> : null}
          <View style={{ flex: 1 }} />
          <T variant="footnote" color={running ? c.brandStrong : c.textMuted} style={running ? { fontWeight: "500" } : undefined}>
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
  // The desktop's states and words (AgentStatus), a missing login included.
  const presence = useAgentPresence(agent, { running, queued });
  const { state } = presence;
  const subtitle = agent.role || agent.description;
  const dot = state === "idle" ? c.success : state === "waiting" || state === "paused" ? c.warning : state === "failed" ? c.danger : alpha(c.textMuted, 0.5);
  const tone = state === "working" ? c.text : state === "waiting" ? c.text : state === "failed" ? c.danger : c.textMuted;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.agent, pressed && { backgroundColor: c.sunken }]}>
      <CharacterAvatar agent={agent} size={46} running={state === "working"} mood={moodOf(presence)} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="callout" numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, fontWeight: "500", letterSpacing: -0.16 }}>
            {agent.name}
          </T>
          {agent.isDefault && <Badge label="Built-in" dot={false} />}
        </Row>
        <Row style={{ gap: 6 }}>
          {state === "working" ? <LiveDot size={6} /> : <View style={[styles.presenceDot, { backgroundColor: dot }]} />}
          <T variant="footnote" numberOfLines={1} style={{ flex: 1 }} color={c.textMuted}>
            <T variant="footnote" color={tone} style={state === "working" ? { fontWeight: "500" } : undefined}>
              {presenceLabel(presence)}
            </T>
            {subtitle ? ` · ${subtitle}` : ""}
          </T>
        </Row>
      </View>
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
  presenceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
