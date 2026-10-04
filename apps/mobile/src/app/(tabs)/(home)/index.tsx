import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { ConversationRow, RunCard } from "@/components/rows";
import { ScreenTile } from "@/components/screen-tile";
import { TaskRow } from "@/components/task-row";
import { Card, Hairline, LiveDot, Row, SectionTitle, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api } from "@/lib/api";
import { greeting } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { reconnectNow } from "@/lib/realtime";
import { isLive, useLiveScreens } from "@/lib/screens";
import { useSession } from "@/lib/session";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

export default function Home() {
  const c = useColors();
  const computer = useSession((s) => s.connection?.instance.name ?? "Your computer");
  const status = useLive((s) => s.status);
  const runs = useLive((s) => s.runs);
  const { byId: agents } = useAgents();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const { id: workspaceId, workspace } = useWorkspace();
  const recent = useQuery({ queryKey: qk.conversationList("", workspaceId), queryFn: () => api.conversations.list({ limit: 100, workspaceId }) });
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }) });
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const { screens } = useLiveScreens();
  const pull = usePullRefresh(async () => {
    reconnectNow();
    await queryClient.invalidateQueries();
  });

  const working = Object.values(runs).sort((a, b) => (a.run.createdAt < b.run.createdAt ? 1 : -1));
  const liveScreens = screens.filter(isLive);
  const runningConversations = new Set(working.map((w) => w.run.conversationId));
  const chats = (recent.data ?? []).filter((conv) => conv.origin !== "dream").slice(0, 5);
  const titleOf = (id: string) => recent.data?.find((conv) => conv.id === id)?.title;
  const openTasks = (tasks.data ?? [])
    .filter((t) => t.status === "in_review" || t.status === "blocked" || t.status === "in_progress" || t.status === "todo")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 4);
  const vaultLocked = boot.data && boot.data.vault.initialized && !boot.data.vault.unlocked;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Title large>{greeting()}</Stack.Title>
      <HeaderActions
        actions={[
          { icon: "compose", label: "New chat", onPress: () => router.push("/compose") },
          { icon: "tasks", label: "New task", onPress: () => router.push("/new-task") },
          { icon: "settings", label: "Settings", onPress: () => router.push("/settings") },
        ]}
      />

      <Pressable onPress={() => router.push("/settings")} style={styles.status}>
        <LiveDot live={status === "online"} color={status === "offline" ? c.warning : undefined} size={7} />
        <T variant="footnote" muted numberOfLines={1}>
          {status === "online" ? `${computer} · connected` : status === "connecting" ? `Connecting to ${computer}…` : `${computer} is out of reach`}
        </T>
      </Pressable>

      <WorkspaceChip />

      <Pressable
        onPress={() => {
          tap();
          router.push("/compose");
        }}
      >
        <Glass interactive style={styles.ask} fallback={c.surface}>
          <Icon name="sparkles" size={18} color={c.textMuted} />
          <T variant="body" muted style={{ flex: 1 }}>
            {workspace ? `Ask Godmode in ${workspace.name}…` : "Ask Godmode to do something…"}
          </T>
          <View style={[styles.askSend, { backgroundColor: c.primary }]}>
            <Icon name="send" size={14} color={c.onPrimary} weight="bold" />
          </View>
        </Glass>
      </Pressable>

      {status === "offline" && (
        <Card style={[styles.notice, { backgroundColor: c.warningSoft, borderColor: "transparent" }]} onPress={() => reconnectNow()}>
          <Icon name="wifi" size={18} color={c.warning} />
          <View style={{ flex: 1 }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              Can't reach {computer}
            </T>
            <T variant="footnote" muted>
              Make sure it's awake and Tailscale is on, here and there. Tap to retry.
            </T>
          </View>
        </Card>
      )}

      <Animated.View layout={LinearTransition} style={styles.section}>
        <SectionTitle title="Working now" />
        {working.length ? (
          <View style={{ gap: space.md }}>
            {working.map((w) => (
              <Animated.View key={w.run.id} entering={FadeIn}>
                <RunCard live={w} agent={agents.get(w.run.agentId)} title={titleOf(w.run.conversationId)} />
              </Animated.View>
            ))}
          </View>
        ) : (
          <Card style={styles.idle}>
            <View style={[styles.idleIcon, { backgroundColor: c.sunken }]}>
              <Icon name="check" size={15} color={c.textMuted} weight="bold" />
            </View>
            <View style={{ flex: 1 }}>
              <T variant="subhead" style={{ fontWeight: "600" }}>
                All quiet
              </T>
              <T variant="footnote" muted>
                No agent is working right now.
              </T>
            </View>
          </Card>
        )}
      </Animated.View>

      {(vaultLocked || (missing.data?.length ?? 0) > 0 || (questions.data?.length ?? 0) > 0) && (
        <View style={styles.section}>
          <SectionTitle title="Needs you" />
          <Card>
            {vaultLocked && (
              <NeedsRow icon="lock" title="The vault is locked" body="Agents can't sign in until you unlock it on your computer." />
            )}
            {questions.data?.slice(0, 4).map((q) => (
              <NeedsRow
                key={q.id}
                icon="warning"
                title={q.kind === "approval" ? `Needs your OK: ${q.title}` : q.title}
                body={q.taskNumber != null ? `Task #${q.taskNumber} — reply to answer` : "Open the chat and reply to answer"}
                onPress={() => router.push(`/chat/${q.conversationId}`)}
              />
            ))}
            {missing.data?.slice(0, 4).map((m) => (
              <NeedsRow key={m.id} icon="key" title={`${m.service}: ${m.kind === "missing_totp" ? "2FA code missing" : m.kind === "invalid_credential" ? "login doesn't work" : "login missing"}`} body={m.reason} />
            ))}
          </Card>
        </View>
      )}

      {liveScreens.length > 0 && (
        <View style={styles.section}>
          <SectionTitle title="Live screens" action="All" onAction={() => router.push("/screens")} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingRight: space.lg }} style={{ marginRight: -space.lg }}>
            {liveScreens.map((s) => (
              <ScreenTile key={s.key} screen={s} style={{ width: 260 }} />
            ))}
          </ScrollView>
        </View>
      )}

      {openTasks.length > 0 && (
        <View style={styles.section}>
          <SectionTitle title="Tasks" action="All" onAction={() => router.push("/tasks")} />
          <Card style={{ paddingVertical: 4 }}>
            {openTasks.map((t, i) => (
              <View key={t.id}>
                {i > 0 && <Hairline inset={72} />}
                <TaskRow task={t} agent={t.agentId ? agents.get(t.agentId) : undefined} />
              </View>
            ))}
          </Card>
        </View>
      )}

      <View style={styles.section}>
        <SectionTitle title="Recent chats" action={chats.length ? "All" : undefined} onAction={() => router.push("/chats")} />
        <Card style={{ paddingVertical: 4 }}>
          {chats.length ? (
            chats.map((conv) => <ConversationRow key={conv.id} conversation={conv} agent={agents.get(conv.agentId)} running={runningConversations.has(conv.id)} />)
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {recent.isLoading ? "Loading…" : "No chats yet. Ask Godmode something to start one."}
            </T>
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

function NeedsRow({ icon, title, body, onPress }: { icon: "lock" | "key" | "warning"; title: string; body: string; onPress?: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined}>
      <Row style={{ gap: space.md, padding: space.lg, alignItems: "flex-start" }}>
        <View style={[styles.needsIcon, { backgroundColor: c.warningSoft }]}>
          <Icon name={icon} size={14} color={c.warning} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="subhead" style={{ fontWeight: "600" }}>
            {title}
          </T>
          <T variant="footnote" muted numberOfLines={2}>
            {body}
          </T>
        </View>
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 140,
    gap: space.lg,
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
    marginTop: -space.sm,
  },
  ask: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: 8,
    height: 56,
    borderRadius: radius.pill,
  },
  askSend: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  section: {
    marginTop: space.sm,
  },
  idle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  idleIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  needsIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
