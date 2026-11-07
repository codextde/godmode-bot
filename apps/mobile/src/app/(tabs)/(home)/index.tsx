import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentQuestion } from "@godmode/shared";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { AwaySummaryCard } from "@/components/away-summary";
import { OffersCard } from "@/components/offers-card";
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
import { trackAway } from "@/lib/away";
import { greeting, pickAgent, SUGGESTIONS, type Need } from "@/lib/desktop-parity";
import { chatListQuery, useAgents } from "@/lib/hooks";
import { useNeeds } from "@/lib/needs";
import { useLinkComputer, useLive, useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { reconnectNow } from "@/lib/realtime";
import { isLive, useLiveScreens } from "@/lib/screens";
import { confirmHideSuggestions, useSuggestions } from "@/lib/suggestions";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { chatProject, inProject, useProjectIndex, useWorkspace, useWorkspaceRuns } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const NEEDS_SHOWN = 5;
const RECENT_SHOWN = 6;

const NEED_ICON: Record<Need["kind"], IconName> = {
  question: "warning",
  todo: "person",
  login: "key",
  review: "check",
  blocked: "warning",
  paused: "pause",
  failed: "warning",
  automation: "workflow",
  access: "personCircle",
};

export default function Home() {
  const c = useColors();
  const { t } = useTranslation(["tabs", "common"]);
  const hideSuggestions = useSuggestions((s) => s.hidden);
  const link = useLinkComputer();
  const computer = link.name ?? t("home.yourComputer");
  const status = useLive((s) => s.status);
  const offlineReason = useLive((s) => s.offlineReason);
  const { data: allAgents } = useAgents();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const projects = useProjectIndex();
  const pull = usePullRefresh(async () => {
    reconnectNow();
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] !== "detail" });
  });
  useEffect(() => trackAway(), []);

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
          { icon: "compose", label: t("home.newChat"), onPress: () => router.push("/compose") },
          { icon: "tasks", label: t("home.newTask"), onPress: () => router.push("/new-task") },
          { icon: "settings", label: t("common:words.settings"), onPress: () => router.push("/settings") },
        ]}
        menu={[
          { icon: "search", title: t("common:actions.search"), onPress: () => router.push("/search") },
          { icon: "inbox", title: t("home.inbox"), onPress: () => router.push("/inbox") },
          { icon: "call", title: t("home.calls"), onPress: () => router.push("/calls") },
          { icon: "artifact", title: t("home.artifacts"), onPress: () => router.push("/artifacts") },
        ]}
      />

      <Pressable onPress={() => router.push("/settings")} style={styles.status}>
        <LiveDot live={status === "online"} color={status === "offline" ? c.warning : undefined} size={7} />
        <T variant="footnote" muted numberOfLines={1}>
          {status === "online"
            ? link.away
              ? t("home.status.connectedThrough", { computer, away: link.away })
              : t("home.status.connected", { computer })
            : status === "connecting"
              ? t("home.status.connecting", { computer })
              : t("home.status.outOfReach", { computer })}
        </T>
      </Pressable>

      <View style={styles.hero}>
        <T variant="largeTitle" style={styles.greeting}>
          {greeting(now)}
          {userName ? `, ${userName}` : ""}.
        </T>
      </View>

      <WorkspaceChip />

      <Pressable accessibilityRole="button" onPress={() => ask()}>
        <Glass interactive style={styles.ask} fallback={c.surface}>
          <Icon name="sparkles" size={18} color={c.textMuted} />
          <T variant="body" muted numberOfLines={1} style={{ flex: 1 }}>
            {agent ? t("home.askAgent", { name: agent.name }) : t("home.ask")}
          </T>
          <View style={[styles.askSend, { backgroundColor: c.primary }]}>
            <Icon name="send" size={14} color={c.onPrimary} weight="bold" />
          </View>
        </Glass>
      </Pressable>

      {hideSuggestions ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.suggestions} contentContainerStyle={styles.suggestionRow}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s.text}
              accessibilityRole="button"
              accessibilityActions={[{ name: "hide", label: t("home.hideSuggestions") }]}
              onAccessibilityAction={confirmHideSuggestions}
              onPress={() => ask(s.text)}
              onLongPress={() => {
                tap();
                confirmHideSuggestions();
              }}
              style={({ pressed }) => [styles.suggestion, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.6 : 1 }]}
            >
              <Icon name={s.icon} size={13} color={c.textMuted} />
              <T variant="footnote" muted numberOfLines={1} style={{ flexShrink: 1 }}>
                {s.text}
              </T>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {status === "offline" && (
        <Card style={[styles.notice, { backgroundColor: c.warningSoft, borderColor: "transparent" }]} onPress={() => reconnectNow()}>
          <Icon name="wifi" size={18} color={c.warning} />
          <View style={{ flex: 1 }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              {t("home.offline.title", { computer })}
            </T>
            <T variant="footnote" muted>
              {t("home.offline.body", { reason: offlineReason ?? t("home.offline.hint") })}
            </T>
          </View>
        </Card>
      )}

      <AwaySummaryCard />
      <OffersCard />
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
  const { t } = useTranslation("tabs");
  const { byId: agents } = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  const needs = useNeeds();

  const { items, elsewhere } = useMemo(() => {
    const all = needs.items;
    // The picked workspace's (and the global ones); in a project, what its tickets and agents wait for.
    const scoped = all.filter((n) => {
      if (workspaceId && n.workspaceId && n.workspaceId !== workspaceId) return false;
      if (!projectId) return true;
      return n.task ? n.task.projectId === projectId : !n.agentId || agents.get(n.agentId)?.projectId === projectId;
    });
    return { items: scoped, elsewhere: all.length - scoped.length };
  }, [needs.items, agents, workspaceId, projectId]);

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
          {t("home.needs.elsewhere", { count: elsewhere })}
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
        title={t("home.needs.title")}
        count={total}
        tone="warning"
        action={more ? (elsewhere > 0 ? t("home.needs.moreElsewhere", { count: elsewhere }) : t("home.inbox")) : undefined}
        onAction={() => router.push("/inbox")}
      />
      <Card>
        {vaultLocked && <NeedsRow icon="lock" title={t("home.needs.vaultLocked")} body={t("home.needs.vaultLockedBody")} />}
        {shown.map((n) =>
          n.question ? (
            <QuestionRow key={n.id} need={n} question={n.question} />
          ) : n.kind === "paused" && n.conversationId ? (
            <PausedRow key={n.id} need={n} conversationId={n.conversationId} />
          ) : (
            <NeedsRow
              key={n.id}
              icon={NEED_ICON[n.kind]}
              title={n.title}
              body={n.kind === "access" ? [n.detail, t("home.attention.onComputer")].filter(Boolean).join(" · ") : n.detail}
              tone={n.kind === "failed" || n.kind === "automation" ? "danger" : undefined}
              onPress={needAction(n)}
            />
          ),
        )}
      </Card>
    </View>
  );
}

/** Agents that work right now. On its own so their activity labels don't render the whole of Home again. */
const WorkingNow = memo(function WorkingNow() {
  const { t } = useTranslation("tabs");
  const { byId: agents } = useAgents();
  const { id: workspaceId } = useWorkspace();
  const recent = useQuery(chatListQuery(workspaceId));
  const live = useWorkspaceRuns();
  const working = live.filter((w) => w.run.status === "running");
  const queued = live.length - working.length;
  if (!working.length) return null;
  return (
    <Animated.View layout={LinearTransition} style={styles.section}>
      <Head title={t("home.workingNow")} count={working.length} live note={queued > 0 ? `· ${t("home.queued", { count: queued })}` : undefined} />
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
  const { t } = useTranslation(["tabs", "common"]);
  const live = useLiveScreens().screens.filter(isLive);
  if (!live.length) return null;
  return (
    <View style={styles.section}>
      <Head title={t("home.liveScreens")} count={live.length} action={t("common:words.all")} onAction={() => router.push("/screens")} />
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
  const { t } = useTranslation("tabs");
  const { byId: agents } = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  const recent = useQuery(chatListQuery(workspaceId));
  const running = useRunningChats();
  const chats = useMemo(
    () =>
      inProject(recent.data ?? [], projectId, agents)
        .filter((conv) => !conv.archived && conv.origin !== "dream" && conv.origin !== "review")
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
        .slice(0, RECENT_SHOWN),
    [recent.data, projectId, agents],
  );
  if (!recent.isLoading && !recent.isError && !chats.length) return null;
  return (
    <View style={styles.section}>
      <Head title={t("home.recent.title")} action={t("home.recent.yourAgents")} onAction={() => router.push("/agents")} />
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
            {t("home.recent.loadError", { error: errorText(recent.error) })}
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
  const { t } = useTranslation("tabs");
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
        body={[need.detail, q.taskNumber != null ? t("home.question.taskNumber", { number: q.taskNumber }) : null, approval ? q.body : t("home.question.openChat")].filter(Boolean).join(" · ")}
        onPress={() => router.push(`/chat/${q.conversationId}`)}
      />
      {approval ? (
        <Row style={styles.decide}>
          {(["approve", "decline"] as const).map((decision) => (
            <Pressable
              key={decision}
              accessibilityRole="button"
              accessibilityLabel={decision === "approve" ? t("home.question.approve") : t("home.question.decline")}
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
                {decision === "approve" ? t("home.question.approve") : t("home.question.decline")}
              </T>
            </Pressable>
          ))}
        </Row>
      ) : null}
    </View>
  );
}

/** Where a row leads: the ticket, the human's task, the chat that stands still or failed, the automation. */
function needAction(n: Need): (() => void) | undefined {
  if (n.humanTask) return () => openHumanTask(n.humanTask!.id);
  if (n.task) return () => openTask(n.task!.id);
  if (n.kind === "automation" && n.routineId) return () => router.push({ pathname: "/automation/[id]", params: { id: n.routineId! } });
  if (n.conversationId) return () => router.push({ pathname: "/chat/[id]", params: { id: n.conversationId! } });
  return undefined;
}

/** A run that stands still until the human lets it go on. */
function PausedRow({ need, conversationId }: { need: Need; conversationId: string }) {
  const c = useColors();
  const { t } = useTranslation("tabs");
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(conversationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: (err) => Alert.alert(t("home.attention.continueError"), errorText(err)),
  });
  return (
    <View>
      <NeedsRow icon={NEED_ICON.paused} title={need.title} body={need.detail} onPress={needAction(need)} />
      <Row style={styles.decide}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: resume.isPending, disabled: resume.isPending }}
          disabled={resume.isPending}
          onPress={() => {
            tap();
            resume.mutate();
          }}
          style={({ pressed }) => [styles.decision, { backgroundColor: c.primary, borderColor: c.primary, opacity: pressed ? 0.7 : 1 }]}
        >
          {resume.isPending ? <ActivityIndicator size="small" color={c.onPrimary} /> : <Icon name="play" size={11} color={c.onPrimary} />}
          <T variant="footnote" color={c.onPrimary} style={{ fontWeight: "600" }}>
            {t("home.attention.continue")}
          </T>
        </Pressable>
      </Row>
    </View>
  );
}

function NeedsRow({ icon, title, body, tone, onPress }: { icon: IconName; title: string; body: string; tone?: "danger"; onPress?: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined}>
      <Row style={{ gap: space.md, padding: space.lg, alignItems: "flex-start" }}>
        <View style={[styles.needsIcon, { backgroundColor: tone === "danger" ? c.dangerSoft : c.warningSoft }]}>
          <Icon name={icon} size={14} color={tone === "danger" ? c.danger : c.warning} />
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
    flexGrow: 0,
    marginHorizontal: -space.lg,
    marginTop: -space.xs,
  },
  suggestionRow: {
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 300,
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
