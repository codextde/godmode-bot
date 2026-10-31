import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import { findModel, leadOf, presenceLabel, reportsOf, type Agent, type Routine, type TaskStatus } from "@godmode/shared";
import { AgentHistory, FailedRunBanner } from "@/components/agent-history";
import { DreamsCard } from "@/components/dreams-card";
import { HeartbeatCard } from "@/components/heartbeat-card";
import { Icon } from "@/components/icon";
import { CharacterAvatar, moodOf, useAgentPresence } from "@/components/character";
import { HeaderActions } from "@/components/header-actions";
import { triggerText } from "@/components/routine-row";
import { ConversationRow, openChat } from "@/components/rows";
import { openTask, STATUS_META } from "@/components/task-row";
import { Badge, Button, Card, ErrorState, Hairline, LiveDot, LoadingState, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { useProjectIndex, useWorkspace } from "@/lib/workspace";
import { api, errorText } from "@/lib/api";
import { useModelCatalog } from "@/lib/composer";
import { activityText, whenText } from "@/lib/format";
import { dateLocale, intlLocale, currentLanguage } from "@/lib/i18n";
import { chatListQuery, useAgents } from "@/lib/hooks";
import { useLive, useRunCounts } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const TICKET_ORDER: TaskStatus[] = ["in_progress", "blocked", "in_review", "todo"];
const SHOWN_TICKETS = 6;

export default function AgentScreen() {
  const { t } = useTranslation(["agents", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const agents = useAgents();
  const agent = agents.byId.get(id);

  if (!agent) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>{t("common:words.agent")}</Stack.Title>
        {agents.isLoading ? (
          <LoadingState label={t("detail.loading")} />
        ) : (
          <ErrorState
            title={agents.isError ? t("detail.loadFailed") : t("detail.notFound")}
            error={agents.isError ? errorText(agents.error) : t("detail.maybeDeleted")}
            onRetry={agents.isError ? () => void agents.refetch() : undefined}
          />
        )}
      </View>
    );
  }
  return <AgentView agent={agent} team={agents.data ?? []} />;
}

/**
 * The desktop's agent header (role, presence, lead, scope, model), a failed last run, what is on its plate, its recent
 * runs, memory and dreams, automations, heartbeat and chats.
 */
function AgentView({ agent, team }: { agent: Agent; team: Agent[] }) {
  const id = agent.id;
  const { t } = useTranslation(["agents", "common"]);
  const { workspaces } = useWorkspace();
  const project = useProjectIndex().get(agent.projectId ?? "")?.project;
  const catalog = useModelCatalog();
  const counts = useRunCounts().get(id);
  const presence = useAgentPresence(agent, { running: counts?.running, queued: counts?.queued });
  const routines = useQuery({ queryKey: qk.agentRoutines(id), queryFn: () => api.routines.list({ agentId: id }) });
  const chats = useQuery({ queryKey: [...qk.conversations, "agent", id], queryFn: () => api.conversations.list({ agentId: id, limit: 5 }) });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.agents.update(id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.agents }),
    onError: (err) => Alert.alert(t("detail.switchOnFailed"), errorText(err)),
  });

  const lead = leadOf(agent, team);
  const reports = reportsOf(agent, team);
  const workspace = workspaces.find((w) => w.id === agent.workspaceId);
  const model = agent.model ? (findModel(catalog.data?.models ?? [], agent.model)?.label ?? agent.model) : t("detail.defaultModel");
  const meta = [
    agent.isDefault ? t("detail.reportsToYou") : lead ? t("detail.reportsTo", { name: lead.name }) : null,
    reports.length ? t("detail.leads", { count: reports.length }) : null,
    workspace ? `${workspace.icon ? `${workspace.icon} ` : ""}${workspace.name}` : t("detail.global"),
    [model, agent.effort ? t("detail.effort", { effort: agent.effort }) : null, agent.ultracode ? "Ultracode" : null].filter(Boolean).join(" · "),
  ].filter(Boolean);
  const tone = presence.state === "working" ? "brand" : presence.state === "failed" ? "danger" : presence.needsYou ? "warning" : "neutral";
  const runTask = () => router.push({ pathname: "/new-task", params: { agentId: agent.id } });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>{agent.name}</Stack.Title>
      <HeaderActions actions={[{ icon: "slider", label: t("detail.setUp", { name: agent.name }), onPress: () => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } }) }]} />
      <View style={styles.hero}>
        <CharacterAvatar agent={agent} size={76} mood={moodOf(presence)} style={{ marginTop: space.md }} />
        <Row style={{ gap: space.sm }}>
          <T variant="title">{agent.name}</T>
          {agent.isDefault && <Badge label={t("detail.builtIn")} />}
        </Row>
        {agent.role ? (
          <T variant="subhead" style={{ textAlign: "center", fontWeight: "600" }}>
            {agent.role}
          </T>
        ) : null}
        {agent.description ? (
          <T variant="subhead" muted style={{ textAlign: "center", maxWidth: 320 }}>
            {agent.description}
          </T>
        ) : null}
        <Row style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          <Badge label={presenceLabel(presence, currentLanguage())} tone={tone} live={presence.state === "working"} />
          {project ? <Badge label={`${project.icon ? `${project.icon} ` : ""}${project.name}`} /> : null}
        </Row>
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {meta.join("  ·  ")}
        </T>
        <Row style={{ gap: space.sm, alignSelf: "stretch", marginTop: space.sm }}>
          <Button title={t("detail.runTask")} icon="play" variant="secondary" disabled={!agent.enabled} onPress={runTask} style={{ flex: 1 }} />
          <Button title={t("detail.chat")} icon="compose" onPress={() => router.push({ pathname: "/compose", params: { agentId: agent.id } })} style={{ flex: 1 }} />
        </Row>
      </View>

      <FailedRunBanner agent={agent} />

      <Plate agent={agent} onRunTask={runTask} onSwitchOn={() => toggle.mutate(true)} switching={toggle.isPending} />

      <AgentHistory agent={agent} />

      <MemoryCard agent={agent} />

      <DreamsCard agent={agent} />

      <View>
        <SectionTitle
          title={t("detail.automations")}
          action={agent.enabled ? t("detail.newAutomation") : undefined}
          onAction={() => router.push({ pathname: "/automation-edit", params: { agentId: agent.id } })}
        />
        <Card style={{ overflow: "hidden" }}>
          {routines.data?.length ? (
            routines.data.map((r, i) => (
              <View key={r.id}>
                {i > 0 && <Hairline inset={space.lg} />}
                <RoutineRow routine={r} />
              </View>
            ))
          ) : routines.isLoading ? (
            <SkeletonRows count={2} avatar={0} />
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {t("detail.noAutomations", { name: agent.name })}
            </T>
          )}
        </Card>
      </View>

      <HeartbeatCard agent={agent} />

      <View>
        <SectionTitle title={t("detail.recentChats")} />
        <Card style={{ paddingVertical: 4 }}>
          {chats.data?.length ? (
            chats.data.map((conv) => <ConversationRow key={conv.id} conversation={conv} agent={agent} running={!!conv.running} />)
          ) : chats.isLoading ? (
            <SkeletonRows count={3} />
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {t("detail.noChats", { name: agent.name })}
            </T>
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

/**
 * Everything the agent has going on, like the desktop's: what it works on right now, what stands still (and why), its
 * tickets on the board, the follow-ups it promised and its next automations.
 */
function Plate({ agent, onRunTask, onSwitchOn, switching }: { agent: Agent; onRunTask: () => void; onSwitchOn: () => void; switching: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const runs = useLive((s) => s.runs);
  const live = useMemo(() => Object.values(runs).filter((r) => r.run.agentId === agent.id), [runs, agent.id]);
  const paused = useQuery({ queryKey: [...qk.runs, "paused", agent.id], queryFn: () => api.runs.list({ agentId: agent.id, status: "paused", limit: 50 }) });
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const tasks = useQuery({ queryKey: qk.taskList(null), queryFn: () => api.tasks.list({}) });
  const chats = useQuery(chatListQuery(null));
  const routines = useQuery({ queryKey: qk.agentRoutines(agent.id), queryFn: () => api.routines.list({ agentId: agent.id }) });

  const tickets = (tasks.data ?? [])
    .filter((task) => task.agentId === agent.id && !task.archivedAt && TICKET_ORDER.includes(task.status))
    .sort((a, b) => TICKET_ORDER.indexOf(a.status) - TICKET_ORDER.indexOf(b.status) || a.position - b.position);
  const promised = (chats.data ?? []).filter((conv) => conv.agentId === agent.id && conv.followup).sort((a, b) => a.followup!.dueAt.localeCompare(b.followup!.dueAt));
  const next = (routines.data ?? []).filter((r) => r.enabled && r.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  const liveIds = new Set(live.map((r) => r.run.id));
  const standing = (paused.data ?? []).filter((r) => !liveIds.has(r.id));
  const titleOf = (conversationId: string, prompt?: string) =>
    (tasks.data ?? []).find((task) => task.conversationId === conversationId)?.title ??
    (chats.data ?? []).find((conv) => conv.id === conversationId)?.title ??
    (prompt ? prompt.replace(/^\[[^\]]*\]\s*/, "").slice(0, 80) : t("plate.aChat"));

  const loading = paused.isLoading || tasks.isLoading || routines.isLoading;
  const empty = !live.length && !standing.length && !tickets.length && !promised.length && !next.length;

  return (
    <View>
      <SectionTitle title={t("plate.title")} />
      <Card style={styles.plate}>
        {loading && empty ? (
          <SkeletonRows count={2} avatar={0} />
        ) : empty ? (
          <View style={{ gap: space.md, padding: space.sm }}>
            <T variant="subhead" muted>
              {agent.enabled ? t("plate.empty", { name: agent.name }) : t("plate.switchedOff", { name: agent.name })}
            </T>
            {agent.enabled ? (
              <Button title={t("detail.runTask")} icon="play" variant="secondary" onPress={onRunTask} />
            ) : (
              <Button title={t("plate.switchOn")} icon="power" variant="secondary" loading={switching} onPress={onSwitchOn} />
            )}
          </View>
        ) : (
          <View style={{ gap: space.md }}>
            {live.length > 0 || standing.length > 0 ? (
              <PlateGroup label={t("plate.now")}>
                {live.map(({ run, activity }) => (
                  <PlateRow
                    key={run.id}
                    icon={run.status === "running" ? <LiveDot size={7} /> : <Icon name="clock" size={13} color={c.textMuted} />}
                    title={run.status === "running" ? (activity ? activityText(activity) : t("plate.working")) : t("plate.queued")}
                    detail={titleOf(run.conversationId)}
                    onPress={() => openChat(run.conversationId)}
                  />
                ))}
                {standing.map((run) => {
                  const waiting = (questions.data ?? []).some((q) => q.runId === run.id);
                  const limit = run.pause?.reason === "limit";
                  return (
                    <PlateRow
                      key={run.id}
                      icon={<Icon name={waiting ? "warning" : limit ? "clock" : "pause"} size={13} color={waiting || limit ? c.warning : c.textMuted} />}
                      title={
                        waiting
                          ? t("plate.waitingAnswer")
                          : limit
                            ? run.pause?.auto && run.pause.resumeAt
                              ? t("plate.waitingLimitResumes", { limit: run.pause?.limit ?? t("plate.usageLimit"), when: whenText(run.pause.resumeAt) })
                              : t("plate.waitingLimit", { limit: run.pause?.limit ?? t("plate.usageLimit") })
                            : t("plate.paused")
                      }
                      detail={titleOf(run.conversationId, run.prompt)}
                      onPress={() => openChat(run.conversationId)}
                    />
                  );
                })}
              </PlateGroup>
            ) : null}
            {tickets.length > 0 ? (
              <PlateGroup label={t("plate.tickets")}>
                {tickets.slice(0, SHOWN_TICKETS).map((task) => (
                  <PlateRow
                    key={task.id}
                    icon={<Icon name="tasks" size={13} color={c.textMuted} />}
                    title={`#${task.number} ${task.title}`}
                    detail={task.status === "blocked" && task.blockedReason ? `${STATUS_META[task.status].label} — ${task.blockedReason}` : STATUS_META[task.status].label}
                    onPress={() => openTask(task.id)}
                  />
                ))}
                {tickets.length > SHOWN_TICKETS ? (
                  <T variant="footnote" muted style={styles.more}>
                    {t("plate.moreOnBoard", { count: tickets.length - SHOWN_TICKETS })}
                  </T>
                ) : null}
              </PlateGroup>
            ) : null}
            {promised.length > 0 ? (
              <PlateGroup label={t("plate.followups")}>
                {promised.map((conv) => (
                  <PlateRow
                    key={conv.id}
                    icon={<Icon name="clock" size={13} color={c.brandStrong} />}
                    title={conv.followup!.note || conv.title || t("plate.followup")}
                    detail={whenText(conv.followup!.dueAt)}
                    onPress={() => openChat(conv.id)}
                  />
                ))}
              </PlateGroup>
            ) : null}
            {next.length > 0 ? (
              <PlateGroup label={t("plate.nextAutomations", { count: next.length })}>
                {next.slice(0, 3).map((r) => (
                  <PlateRow
                    key={r.id}
                    icon={<Icon name="workflow" size={13} color={c.textMuted} />}
                    title={r.name}
                    detail={`${triggerText(r)} · ${formatDistanceToNowStrict(new Date(r.nextRunAt!), { addSuffix: true, locale: dateLocale() })}`}
                  />
                ))}
                {next.length > 3 ? (
                  <T variant="footnote" muted style={styles.more}>
                    {t("plate.andMore", { count: next.length - 3 })}
                  </T>
                ) : null}
              </PlateGroup>
            ) : null}
          </View>
        )}
      </Card>
    </View>
  );
}

/** MEMORY.md at a glance; hidden when the computer runs a Godmode without the memory editor. */
function MemoryCard({ agent }: { agent: Agent }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const memory = useQuery({ queryKey: qk.agentMemory(agent.id), queryFn: () => api.agents.memory(agent.id), retry: false });
  if (!memory.data) return null;
  const { chars, target, updatedAt, dreaming } = memory.data;
  const detail = !chars
    ? t("memoryCard.empty")
    : updatedAt
      ? t("memoryCard.sizeUpdated", { chars: chars.toLocaleString(intlLocale()), target: target.toLocaleString(intlLocale()), ago: formatDistanceToNowStrict(new Date(updatedAt), { addSuffix: true, locale: dateLocale() }) })
      : t("memoryCard.size", { chars: chars.toLocaleString(intlLocale()), target: target.toLocaleString(intlLocale()) });
  return (
    <View>
      <SectionTitle title={t("memoryCard.title")} />
      <Card style={styles.plate}>
        <PlateRow
          icon={<Icon name={dreaming ? "moon" : "brain"} size={14} color={dreaming ? c.dream : chars > target ? c.warning : c.textMuted} />}
          title={dreaming ? t("memoryCard.dreaming") : t("memoryCard.remembers")}
          detail={detail}
          onPress={() => router.push({ pathname: "/memory/[id]", params: { id: agent.id } })}
        />
      </Card>
    </View>
  );
}

function PlateGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <T variant="eyebrow" muted style={{ paddingHorizontal: space.sm }}>
        {label}
      </T>
      {children}
    </View>
  );
}

function PlateRow({ icon, title, detail, onPress }: { icon: ReactNode; title: string; detail?: string; onPress?: () => void }) {
  const c = useColors();
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      style={({ pressed }) => [styles.plateRow, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={styles.plateIcon}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="subhead" numberOfLines={1}>
          {title}
        </T>
        {detail ? (
          <T variant="caption" muted numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {onPress ? <Icon name="chevron" size={11} color={c.textFaint} /> : null}
    </Pressable>
  );
}

function RoutineRow({ routine }: { routine: Routine }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.routines.setEnabled(routine.id, enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.routines }),
    onError: (err) => Alert.alert(t("routine.changeFailed"), errorText(err)),
  });
  const run = useMutation({
    mutationFn: () => api.routines.run(routine.id),
    onSuccess: (r) => useLive.getState().runStarted(r),
    onError: (err) => Alert.alert(t("routine.runFailed"), errorText(err)),
  });
  const enabled = toggle.isPending ? !!toggle.variables : routine.enabled;
  const canRun = routine.enabled && !run.isPending;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        router.push({ pathname: "/automation/[id]", params: { id: routine.id } });
      }}
      style={({ pressed }) => [styles.routine, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={1}>
          {routine.name}
        </T>
        <T variant="footnote" muted numberOfLines={2}>
          {triggerText(routine)}
          {routine.lastStatus === "failed" ? t("routine.lastRunFailed") : ""}
        </T>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("routine.runNow", { name: routine.name })}
        accessibilityState={{ disabled: !canRun }}
        hitSlop={6}
        // Not `disabled`: a press on it must not fall through to the row and open the automation.
        onPress={() => {
          if (!canRun) return;
          tap();
          run.mutate();
        }}
        style={({ pressed }) => [styles.runNow, { backgroundColor: c.sunken, opacity: !routine.enabled ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <Icon name="play" size={12} color={c.text} />
      </Pressable>
      <Switch value={enabled} onValueChange={(v) => toggle.mutate(v)} trackColor={{ true: c.brand, false: c.sunken }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  hero: {
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
  },
  plate: {
    padding: space.sm,
  },
  plateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 8,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  plateIcon: {
    width: 16,
    alignItems: "center",
  },
  more: {
    paddingHorizontal: space.sm,
    paddingTop: 2,
  },
  routine: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  runNow: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
