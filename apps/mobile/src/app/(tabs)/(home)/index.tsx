import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { AgentQuestion } from "@godmode/shared";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { openHumanTask } from "@/components/human-task-row";
import { Icon } from "@/components/icon";
import { answerQuestion } from "@/components/question-card";
import { ConversationRow, RunCard } from "@/components/rows";
import { ScreenTile } from "@/components/screen-tile";
import { TaskRow } from "@/components/task-row";
import { Card, Hairline, LiveDot, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { greeting } from "@/lib/format";
import { chatListQuery, useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { useLive, useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { reconnectNow } from "@/lib/realtime";
import { isLive, useLiveScreens } from "@/lib/screens";
import { useSession } from "@/lib/session";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { chatProject, inProject, tasksInProject, useProjectIndex, useWorkspace, useWorkspaceRuns } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

export default function Home() {
  const c = useColors();
  const computer = useSession((s) => s.connection?.instance.name ?? "Your computer");
  const status = useLive((s) => s.status);
  const offlineReason = useLive((s) => s.offlineReason);
  const { byId: agents } = useAgents();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const { id: workspaceId, workspace, projectId, project } = useWorkspace();
  const projects = useProjectIndex();
  const openForYou = useOpenHumanTasks();
  // Scoped like the rest of Home: the workspace's tasks and the ones without a workspace.
  const mine = { data: openForYou.data?.filter((t) => !workspaceId || !t.workspaceId || t.workspaceId === workspaceId) };
  const recent = useQuery(chatListQuery(workspaceId));
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }) });
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const { screens } = useLiveScreens();
  // The lists, not the open chats: those refresh on their own events.
  const pull = usePullRefresh(async () => {
    reconnectNow();
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] !== "detail" });
  });

  const liveScreens = screens.filter(isLive);
  const runningConversations = useRunningChats();
  const chats = inProject(recent.data ?? [], projectId, agents)
    .filter((conv) => conv.origin !== "dream")
    .slice(0, 5);
  const openTasks = tasksInProject(tasks.data ?? [], projectId)
    .filter((t) => t.status === "in_review" || t.status === "blocked" || t.status === "in_progress" || t.status === "todo")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 4);
  const projectOf = (conv: (typeof chats)[number]) => {
    const id = chatProject(conv, agents);
    return id ? projects.get(id)?.project : undefined;
  };
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
            {project ? `Ask Godmode in ${project.name}…` : workspace ? `Ask Godmode in ${workspace.name}…` : "Ask Godmode to do something…"}
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
              {offlineReason ?? "Make sure it's awake and connected to Tailscale or Godmode Cloud."} Tap to retry.
            </T>
          </View>
        </Card>
      )}

      <WorkingNow computer={computer} />

      {(vaultLocked || (missing.data?.length ?? 0) > 0 || (questions.data?.length ?? 0) > 0 || (mine.data?.length ?? 0) > 0) && (
        <View style={styles.section}>
          <SectionTitle title="Needs you" />
          <Card>
            {vaultLocked && (
              <NeedsRow icon="lock" title="The vault is locked" body="Agents can't sign in until you unlock it on your computer." />
            )}
            {mine.data?.slice(0, 4).map((t) => (
              <NeedsRow
                key={t.id}
                icon="person"
                title={t.title}
                body={`${t.priority === "high" ? "Urgent · " : ""}${t.agentName ? (t.kind === "decision" ? `${t.agentName} left you a decision` : `${t.agentName} needs you to do this`) : "Your task"}${t.status === "doing" ? " · you're on it" : ""}`}
                onPress={() => openHumanTask(t.id)}
              />
            ))}
            {(mine.data?.length ?? 0) > 4 && (
              <NeedsRow icon="person" title={`${mine.data!.length - 4} more tasks for you`} body="Open My tasks" onPress={() => router.push("/my-tasks")} />
            )}
            {questions.data?.slice(0, 4).map((q) => (
              <QuestionRow key={q.id} question={q} agentName={agents.get(q.agentId)?.name} />
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
            chats.map((conv) => (
              <ConversationRow
                key={conv.id}
                conversation={conv}
                agent={agents.get(conv.agentId)}
                running={runningConversations.has(conv.id)}
                project={projectId ? undefined : projectOf(conv)}
              />
            ))
          ) : recent.isLoading ? (
            <SkeletonRows count={3} />
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {recent.isError ? `Couldn't load your chats. ${errorText(recent.error)}` : "No chats yet. Ask Godmode something to start one."}
            </T>
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

/** Agents that work right now. On its own so their activity labels don't render the whole of Home again. */
const WorkingNow = memo(function WorkingNow({ computer }: { computer: string }) {
  const c = useColors();
  const status = useLive((s) => s.status);
  const { byId: agents } = useAgents();
  const { id: workspaceId } = useWorkspace();
  const recent = useQuery(chatListQuery(workspaceId));
  const working = useWorkspaceRuns();
  return (
    <Animated.View layout={LinearTransition} style={styles.section}>
      <SectionTitle title="Working now" />
      {working.length ? (
        <View style={{ gap: space.md }}>
          {working.map((w) => (
            <Animated.View key={w.run.id} entering={FadeIn}>
              <RunCard live={w} agent={agents.get(w.run.agentId)} title={recent.data?.find((conv) => conv.id === w.run.conversationId)?.title} />
            </Animated.View>
          ))}
        </View>
      ) : (
        <Card style={styles.idle}>
          <View style={[styles.idleIcon, { backgroundColor: c.sunken }]}>
            {status === "connecting" ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name="check" size={15} color={c.textMuted} weight="bold" />}
          </View>
          <View style={{ flex: 1 }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              {status === "connecting" ? "Checking in…" : "All quiet"}
            </T>
            <T variant="footnote" muted>
              {status === "connecting" ? `Asking ${computer} what the team is doing.` : "No agent is working right now."}
            </T>
          </View>
        </Card>
      )}
    </Animated.View>
  );
});

/** A question an agent waits on: an approval is answered right here, anything else in its chat. */
function QuestionRow({ question: q, agentName }: { question: AgentQuestion; agentName?: string }) {
  const c = useColors();
  const [sending, setSending] = useState<"approve" | "decline" | null>(null);
  const approval = q.kind === "approval";
  const decide = (decision: "approve" | "decline") => {
    if (sending) return;
    tap();
    setSending(decision);
    void answerQuestion(q.id, { decision }).finally(() => setSending(null));
  };
  return (
    <View>
      <NeedsRow
        icon="warning"
        title={approval ? `Needs your OK: ${q.title}` : q.title}
        body={[agentName, q.taskNumber != null ? `Task #${q.taskNumber}` : null, approval ? (q.body ?? "") : "Open the chat to answer"].filter(Boolean).join(" · ")}
        onPress={() => router.push(`/chat/${q.conversationId}`)}
      />
      {approval ? (
        <Row style={styles.decide}>
          {(["approve", "decline"] as const).map((decision) => (
            <Pressable
              key={decision}
              accessibilityRole="button"
              accessibilityLabel={decision === "approve" ? "Approve" : "Decline"}
              accessibilityState={{ busy: sending === decision, disabled: !!sending }}
              disabled={!!sending}
              onPress={() => decide(decision)}
              style={({ pressed }) => [
                styles.decision,
                { backgroundColor: decision === "approve" ? c.primary : c.surface, borderColor: decision === "approve" ? c.primary : c.borderStrong, opacity: pressed || (sending && sending !== decision) ? 0.6 : 1 },
              ]}
            >
              {sending === decision ? <ActivityIndicator size="small" color={decision === "approve" ? c.onPrimary : c.text} /> : null}
              <T variant="footnote" color={decision === "approve" ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                {decision === "approve" ? "Approve" : "Decline"}
              </T>
            </Pressable>
          ))}
        </Row>
      ) : null}
    </View>
  );
}

function NeedsRow({ icon, title, body, onPress }: { icon: "lock" | "key" | "warning" | "person"; title: string; body: string; onPress?: () => void }) {
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
  decide: {
    gap: space.sm,
    paddingLeft: space.lg + 28 + space.md,
    paddingBottom: space.md,
    marginTop: -4,
  },
  decision: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 34,
    minWidth: 92,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  needsIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
