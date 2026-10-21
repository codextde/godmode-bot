import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { router, Stack } from "expo-router";
import { memo, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { AgentQuestion } from "@godmode/shared";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { openHumanTask } from "@/components/human-task-row";
import { Icon, type IconName } from "@/components/icon";
import { answerQuestion } from "@/components/question-card";
import { ConversationRow, RunCard } from "@/components/rows";
import { ScreenTile } from "@/components/screen-tile";
import { openTask } from "@/components/task-row";
import { Card, LiveDot, Row, SkeletonRows, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { greeting, needsYou, pickAgent, SUGGESTIONS, type Need } from "@/lib/desktop-parity";
import { chatListQuery, useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { useLinkComputer, useLive, useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { reconnectNow } from "@/lib/realtime";
import { isLive, useLiveScreens } from "@/lib/screens";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { chatProject, inProject, useProjectIndex, useWorkspace, useWorkspaceRuns } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const NEEDS_SHOWN = 5;
const RECENT_SHOWN = 6;

const NEED_ICON: Record<Need["kind"], IconName> = { question: "warning", todo: "person", login: "key", review: "check", blocked: "warning" };

export default function Home() {
  const c = useColors();
  const link = useLinkComputer();
  const computer = link.name ?? "Your computer";
  const status = useLive((s) => s.status);
  const offlineReason = useLive((s) => s.offlineReason);
  const { data: allAgents } = useAgents();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const projects = useProjectIndex();
  const pull = usePullRefresh(async () => {
    reconnectNow();
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] !== "detail" });
  });

  const enabled = (allAgents ?? []).filter((a) => a.enabled);
  const agent = pickAgent(enabled);
  const userName = boot.data?.settings.general.userName?.trim();
  const vaultLocked = !!boot.data && boot.data.vault.initialized && !boot.data.vault.unlocked;
  const now = new Date();
  const ask = (prompt?: string) => {
    tap();
    router.push(prompt ? { pathname: "/compose", params: { prompt } } : "/compose");
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: "", headerLargeTitleEnabled: false }} />
      <HeaderActions
        actions={[
          { icon: "compose", label: "New chat", onPress: () => router.push("/compose") },
          { icon: "tasks", label: "New task", onPress: () => router.push("/new-task") },
          { icon: "settings", label: "Settings", onPress: () => router.push("/settings") },
        ]}
        menu={[
          { icon: "inbox", title: "Inbox", onPress: () => router.push("/inbox") },
          { icon: "call", title: "Calls", onPress: () => router.push("/calls") },
        ]}
      />

      <Pressable onPress={() => router.push("/settings")} style={styles.status}>
        <LiveDot live={status === "online"} color={status === "offline" ? c.warning : undefined} size={7} />
        <T variant="footnote" muted numberOfLines={1}>
          {status === "online"
            ? link.away
              ? `Connected through ${computer} — ${link.away} is away`
              : `${computer} · connected`
            : status === "connecting"
              ? `Connecting to ${computer}…`
              : `${computer} is out of reach`}
        </T>
      </Pressable>

      <View style={styles.hero}>
        <View style={[styles.pill, { backgroundColor: c.surface, borderColor: c.border }]}>
          <LiveDot size={6} />
          <T variant="caption" muted>
            {format(now, "EEEE, MMMM d")}
            {enabled.length > 0 ? ` · ${enabled.length === 1 ? "1 agent ready" : `${enabled.length} agents ready`}` : ""}
          </T>
        </View>
        <T variant="largeTitle" style={styles.greeting}>
          {greeting(now)}
          {userName ? `, ${userName}` : ""}.
          <T variant="largeTitle" color={c.textFaint} style={styles.greeting}>
            {"\n"}What should we get done?
          </T>
        </T>
      </View>

      <WorkspaceChip />

      <Pressable accessibilityRole="button" onPress={() => ask()}>
        <Glass interactive style={styles.ask} fallback={c.surface}>
          <Icon name="sparkles" size={18} color={c.textMuted} />
          <T variant="body" muted numberOfLines={1} style={{ flex: 1 }}>
            {agent ? `Ask ${agent.name} anything, or hand over a task…` : "Ask anything, or hand over a task…"}
          </T>
          <View style={[styles.askSend, { backgroundColor: c.primary }]}>
            <Icon name="send" size={14} color={c.onPrimary} weight="bold" />
          </View>
        </Glass>
      </Pressable>

      <View style={styles.suggestions}>
        {SUGGESTIONS.map((s) => (
          <Pressable
            key={s.text}
            accessibilityRole="button"
            onPress={() => ask(s.text)}
            style={({ pressed }) => [styles.suggestion, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon name={s.icon} size={13} color={c.textMuted} />
            <T variant="footnote" muted numberOfLines={1} style={{ flexShrink: 1 }}>
              {s.text}
            </T>
          </Pressable>
        ))}
      </View>

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

      <NeedsYou vaultLocked={vaultLocked} />
      <WorkingNow />
      <LiveScreens />
      <RecentChats projects={projects} />
    </ScrollView>
  );
}

/** What waits for the human, first thing on Home: the newest few, the rest in the Inbox. */
function NeedsYou({ vaultLocked }: { vaultLocked: boolean }) {
  const c = useColors();
  const { byId: agents } = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  const humanTasks = useOpenHumanTasks();
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const tasks = useQuery({ queryKey: qk.taskList(null), queryFn: () => api.tasks.list({}) });

  const { items, elsewhere } = useMemo(() => {
    const all = needsYou({
      questions: questions.data ?? [],
      humanTasks: humanTasks.data ?? [],
      missing: missing.data ?? [],
      tasks: tasks.data ?? [],
      nameOf: (id) => (id ? (agents.get(id)?.name ?? "An agent") : "An agent"),
    });
    // The picked workspace's (and the global ones); in a project, what its tickets and agents wait for.
    const scoped = all.filter((n) => {
      if (workspaceId && n.workspaceId && n.workspaceId !== workspaceId) return false;
      if (!projectId) return true;
      return n.task ? n.task.projectId === projectId : !n.agentId || agents.get(n.agentId)?.projectId === projectId;
    });
    return { items: scoped, elsewhere: all.length - scoped.length };
  }, [questions.data, humanTasks.data, missing.data, tasks.data, agents, workspaceId, projectId]);

  const total = items.length + (vaultLocked ? 1 : 0);
  if (!total && !elsewhere) return null;
  if (!total) {
    return (
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push("/inbox")}
        style={({ pressed }) => [styles.elsewhere, { borderColor: c.borderStrong, opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={[styles.dot, { backgroundColor: c.warning }]} />
        <T variant="footnote" muted style={{ flex: 1 }}>
          Nothing waits for you here. {elsewhere} {elsewhere === 1 ? "thing waits" : "things wait"} in other workspaces
        </T>
        <Icon name="chevron" size={11} color={c.textFaint} />
      </Pressable>
    );
  }
  const shown = items.slice(0, NEEDS_SHOWN);
  const more = items.length > shown.length || elsewhere > 0;
  return (
    <View style={styles.section}>
      <Head
        title="Needs you"
        count={total}
        tone="warning"
        action={more ? (elsewhere > 0 ? `+${elsewhere} in other workspaces · Inbox` : `All ${items.length} in the Inbox`) : undefined}
        onAction={() => router.push("/inbox")}
      />
      <Card>
        {vaultLocked && <NeedsRow icon="lock" title="The vault is locked" body="Agents can't sign in until you unlock it on your computer." />}
        {shown.map((n) =>
          n.question ? (
            <QuestionRow key={n.id} need={n} question={n.question} />
          ) : (
            <NeedsRow
              key={n.id}
              icon={NEED_ICON[n.kind]}
              title={n.title}
              body={n.detail}
              onPress={n.humanTask ? () => openHumanTask(n.humanTask!.id) : n.task ? () => openTask(n.task!.id) : undefined}
            />
          ),
        )}
      </Card>
    </View>
  );
}

/** Agents that work right now. On its own so their activity labels don't render the whole of Home again. */
const WorkingNow = memo(function WorkingNow() {
  const { byId: agents } = useAgents();
  const { id: workspaceId } = useWorkspace();
  const recent = useQuery(chatListQuery(workspaceId));
  const live = useWorkspaceRuns();
  const working = live.filter((w) => w.run.status === "running");
  const queued = live.length - working.length;
  if (!working.length) return null;
  return (
    <Animated.View layout={LinearTransition} style={styles.section}>
      <Head title="Working now" count={working.length} live note={queued > 0 ? `· ${queued} queued` : undefined} />
      <View style={{ gap: space.md }}>
        {working.map((w) => (
          <Animated.View key={w.run.id} entering={FadeIn}>
            <RunCard live={w} agent={agents.get(w.run.agentId)} title={recent.data?.find((conv) => conv.id === w.run.conversationId)?.title} />
          </Animated.View>
        ))}
      </View>
    </Animated.View>
  );
});

/** What the agents' browsers, computers and phones show right now. */
function LiveScreens() {
  const live = useLiveScreens().screens.filter(isLive);
  if (!live.length) return null;
  return (
    <View style={styles.section}>
      <Head title="Live screens" count={live.length} action="All" onAction={() => router.push("/screens")} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingRight: space.lg }} style={{ marginRight: -space.lg }}>
        {live.map((s) => (
          <ScreenTile key={s.key} screen={s} style={{ width: 260 }} />
        ))}
      </ScrollView>
    </View>
  );
}

/** The latest chats, pinned first. */
function RecentChats({ projects }: { projects: ReturnType<typeof useProjectIndex> }) {
  const { byId: agents } = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  const recent = useQuery(chatListQuery(workspaceId));
  const running = useRunningChats();
  const chats = useMemo(
    () =>
      inProject(recent.data ?? [], projectId, agents)
        .filter((conv) => !conv.archived && conv.origin !== "dream")
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
        .slice(0, RECENT_SHOWN),
    [recent.data, projectId, agents],
  );
  if (!recent.isLoading && !recent.isError && !chats.length) return null;
  return (
    <View style={styles.section}>
      <Head title="Pick up where you left off" action="Your agents" onAction={() => router.push("/agents")} />
      <Card style={{ paddingVertical: 4 }}>
        {chats.length ? (
          chats.map((conv) => {
            const id = projectId ? null : chatProject(conv, agents);
            return (
              <ConversationRow
                key={conv.id}
                conversation={conv}
                agent={agents.get(conv.agentId)}
                running={running.has(conv.id) || !!conv.running}
                project={id ? projects.get(id)?.project : undefined}
              />
            );
          })
        ) : recent.isLoading ? (
          <SkeletonRows count={3} />
        ) : (
          <T variant="subhead" muted style={{ padding: space.lg }}>
            Couldn't load your chats. {errorText(recent.error)}
          </T>
        )}
      </Card>
    </View>
  );
}

/** A section's eyebrow with its count, like the desktop's: "Needs you 3", "Working now 2 · 1 queued". */
function Head({
  title,
  count,
  tone,
  live,
  note,
  action,
  onAction,
}: {
  title: string;
  count?: number;
  tone?: "warning";
  live?: boolean;
  note?: string;
  action?: string;
  onAction?: () => void;
}) {
  const c = useColors();
  return (
    <Row style={styles.head}>
      {live ? <LiveDot size={7} /> : null}
      <T variant="eyebrow" muted>
        {title}
      </T>
      {count ? (
        <View style={[styles.count, tone === "warning" ? { backgroundColor: c.warningSoft } : { backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}>
          <T variant="caption" color={tone === "warning" ? c.warning : c.text} style={styles.countText}>
            {count}
          </T>
        </View>
      ) : null}
      {note ? (
        <T variant="caption" muted>
          {note}
        </T>
      ) : null}
      {action && onAction ? (
        <Pressable hitSlop={10} onPress={onAction} style={{ marginLeft: "auto", flexShrink: 1 }}>
          <T variant="footnote" muted numberOfLines={1} style={{ fontWeight: "600" }}>
            {action}
          </T>
        </Pressable>
      ) : null}
    </Row>
  );
}

/** A question an agent waits on: an approval is answered right here, anything else in its chat. */
function QuestionRow({ need, question: q }: { need: Need; question: AgentQuestion }) {
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
        title={need.title}
        body={[need.detail, q.taskNumber != null ? `Task #${q.taskNumber}` : null, approval ? q.body : "Open the chat to answer"].filter(Boolean).join(" · ")}
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

function NeedsRow({ icon, title, body, onPress }: { icon: IconName; title: string; body: string; onPress?: () => void }) {
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
          {body ? (
            <T variant="footnote" muted numberOfLines={2}>
              {body}
            </T>
          ) : null}
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
  },
  hero: {
    gap: space.md,
    paddingHorizontal: 4,
    paddingTop: space.sm,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingVertical: 4,
    paddingLeft: 9,
    paddingRight: 11,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  greeting: {
    fontSize: 30,
    lineHeight: 35,
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
  suggestions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    marginTop: -space.xs,
  },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
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
  head: {
    gap: space.sm,
    paddingHorizontal: 4,
    marginBottom: space.sm,
  },
  count: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
    alignItems: "center",
  },
  countText: {
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  elsewhere: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: 1,
    borderStyle: "dashed",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
