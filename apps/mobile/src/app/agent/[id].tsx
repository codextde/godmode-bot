import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { findModel, leadOf, presenceLabel, reportsOf, type Agent, type Routine, type TaskStatus } from "@godmode/shared";
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
import { chatListQuery, useAgents } from "@/lib/hooks";
import { useLive, useRunCounts } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const TICKET_ORDER: TaskStatus[] = ["in_progress", "blocked", "in_review", "todo"];
const SHOWN_TICKETS = 6;

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agents = useAgents();
  const agent = agents.byId.get(id);

  if (!agent) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>Agent</Stack.Title>
        {agents.isLoading ? (
          <LoadingState label="Loading the agent…" />
        ) : (
          <ErrorState
            title={agents.isError ? "Couldn't load this agent" : "Agent not found"}
            error={agents.isError ? errorText(agents.error) : "It may have been deleted."}
            onRetry={agents.isError ? () => void agents.refetch() : undefined}
          />
        )}
      </View>
    );
  }
  return <AgentView agent={agent} team={agents.data ?? []} />;
}

/** The desktop's agent header (role, presence, lead, scope, model), what is on its plate, its automations and chats. */
function AgentView({ agent, team }: { agent: Agent; team: Agent[] }) {
  const id = agent.id;
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
    onError: (err) => Alert.alert("Couldn't switch it on", errorText(err)),
  });

  const lead = leadOf(agent, team);
  const reports = reportsOf(agent, team);
  const workspace = workspaces.find((w) => w.id === agent.workspaceId);
  const model = agent.model ? (findModel(catalog.data?.models ?? [], agent.model)?.label ?? agent.model) : "Default model";
  const meta = [
    agent.isDefault ? "Reports to you" : lead ? `Reports to ${lead.name}` : null,
    reports.length ? `Leads ${reports.length}` : null,
    workspace ? `${workspace.icon ? `${workspace.icon} ` : ""}${workspace.name}` : "Global",
    [model, agent.effort ? `${agent.effort} effort` : null, agent.ultracode ? "Ultracode" : null].filter(Boolean).join(" · "),
  ].filter(Boolean);
  const tone = presence.state === "working" ? "brand" : presence.state === "failed" ? "danger" : presence.needsYou ? "warning" : "neutral";
  const runTask = () => router.push({ pathname: "/new-task", params: { agentId: agent.id } });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>{agent.name}</Stack.Title>
      <HeaderActions actions={[{ icon: "slider", label: `Set up ${agent.name}`, onPress: () => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } }) }]} />
      <View style={styles.hero}>
        <CharacterAvatar agent={agent} size={76} mood={moodOf(presence)} style={{ marginTop: space.md }} />
        <Row style={{ gap: space.sm }}>
          <T variant="title">{agent.name}</T>
          {agent.isDefault && <Badge label="Built-in" />}
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
          <Badge label={presenceLabel(presence)} tone={tone} live={presence.state === "working"} />
          {project ? <Badge label={`${project.icon ? `${project.icon} ` : ""}${project.name}`} /> : null}
        </Row>
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {meta.join("  ·  ")}
        </T>
        <Row style={{ gap: space.sm, alignSelf: "stretch", marginTop: space.sm }}>
          <Button title="Run task" icon="play" variant="secondary" disabled={!agent.enabled} onPress={runTask} style={{ flex: 1 }} />
          <Button title="Chat" icon="compose" onPress={() => router.push({ pathname: "/compose", params: { agentId: agent.id } })} style={{ flex: 1 }} />
        </Row>
      </View>

      <Plate agent={agent} onRunTask={runTask} onSwitchOn={() => toggle.mutate(true)} switching={toggle.isPending} />

      <MemoryCard agent={agent} />

      <View>
        <SectionTitle title="Automations" />
        <Card>
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
              No automations yet. Set them up in Godmode on your computer.
            </T>
          )}
        </Card>
      </View>

      <View>
        <SectionTitle title="Recent chats" />
        <Card style={{ paddingVertical: 4 }}>
          {chats.data?.length ? (
            chats.data.map((conv) => <ConversationRow key={conv.id} conversation={conv} agent={agent} running={!!conv.running} />)
          ) : chats.isLoading ? (
            <SkeletonRows count={3} />
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              No chats with {agent.name} yet.
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
  const runs = useLive((s) => s.runs);
  const live = useMemo(() => Object.values(runs).filter((r) => r.run.agentId === agent.id), [runs, agent.id]);
  const paused = useQuery({ queryKey: [...qk.runs, "paused", agent.id], queryFn: () => api.runs.list({ agentId: agent.id, status: "paused", limit: 50 }) });
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const tasks = useQuery({ queryKey: qk.taskList(null), queryFn: () => api.tasks.list({}) });
  const chats = useQuery(chatListQuery(null));
  const routines = useQuery({ queryKey: qk.agentRoutines(agent.id), queryFn: () => api.routines.list({ agentId: agent.id }) });

  const tickets = (tasks.data ?? [])
    .filter((t) => t.agentId === agent.id && !t.archivedAt && TICKET_ORDER.includes(t.status))
    .sort((a, b) => TICKET_ORDER.indexOf(a.status) - TICKET_ORDER.indexOf(b.status) || a.position - b.position);
  const promised = (chats.data ?? []).filter((conv) => conv.agentId === agent.id && conv.followup).sort((a, b) => a.followup!.dueAt.localeCompare(b.followup!.dueAt));
  const next = (routines.data ?? []).filter((r) => r.enabled && r.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  const liveIds = new Set(live.map((r) => r.run.id));
  const standing = (paused.data ?? []).filter((r) => !liveIds.has(r.id));
  const titleOf = (conversationId: string, prompt?: string) =>
    (tasks.data ?? []).find((t) => t.conversationId === conversationId)?.title ??
    (chats.data ?? []).find((conv) => conv.id === conversationId)?.title ??
    (prompt ? prompt.replace(/^\[[^\]]*\]\s*/, "").slice(0, 80) : "A chat");

  const loading = paused.isLoading || tasks.isLoading || routines.isLoading;
  const empty = !live.length && !standing.length && !tickets.length && !promised.length && !next.length;

  return (
    <View>
      <SectionTitle title="On its plate" />
      <Card style={styles.plate}>
        {loading && empty ? (
          <SkeletonRows count={2} avatar={0} />
        ) : empty ? (
          <View style={{ gap: space.md, padding: space.sm }}>
            <T variant="subhead" muted>
              {agent.enabled ? `Nothing on ${agent.name}'s plate right now.` : `${agent.name} is switched off.`}
            </T>
            {agent.enabled ? (
              <Button title="Run task" icon="play" variant="secondary" onPress={onRunTask} />
            ) : (
              <Button title="Switch on" icon="power" variant="secondary" loading={switching} onPress={onSwitchOn} />
            )}
          </View>
        ) : (
          <View style={{ gap: space.md }}>
            {live.length > 0 || standing.length > 0 ? (
              <PlateGroup label="Now">
                {live.map(({ run, activity }) => (
                  <PlateRow
                    key={run.id}
                    icon={run.status === "running" ? <LiveDot size={7} /> : <Icon name="clock" size={13} color={c.textMuted} />}
                    title={run.status === "running" ? (activity ? activityText(activity) : "Working…") : "Queued — waiting for a free slot"}
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
                          ? "Waiting for your answer"
                          : limit
                            ? `Waiting for Claude's ${run.pause?.limit ?? "usage limit"}${run.pause?.auto && run.pause.resumeAt ? ` · continues ${whenText(run.pause.resumeAt)}` : ""}`
                            : "Paused"
                      }
                      detail={titleOf(run.conversationId, run.prompt)}
                      onPress={() => openChat(run.conversationId)}
                    />
                  );
                })}
              </PlateGroup>
            ) : null}
            {tickets.length > 0 ? (
              <PlateGroup label="Board tickets">
                {tickets.slice(0, SHOWN_TICKETS).map((t) => (
                  <PlateRow
                    key={t.id}
                    icon={<Icon name="tasks" size={13} color={c.textMuted} />}
                    title={`#${t.number} ${t.title}`}
                    detail={t.status === "blocked" && t.blockedReason ? `${STATUS_META[t.status].label} — ${t.blockedReason}` : STATUS_META[t.status].label}
                    onPress={() => openTask(t.id)}
                  />
                ))}
                {tickets.length > SHOWN_TICKETS ? (
                  <T variant="footnote" muted style={styles.more}>
                    {tickets.length - SHOWN_TICKETS} more on the board
                  </T>
                ) : null}
              </PlateGroup>
            ) : null}
            {promised.length > 0 ? (
              <PlateGroup label="Follow-ups">
                {promised.map((conv) => (
                  <PlateRow
                    key={conv.id}
                    icon={<Icon name="clock" size={13} color={c.brandStrong} />}
                    title={conv.followup!.note || conv.title || "Follow-up"}
                    detail={whenText(conv.followup!.dueAt)}
                    onPress={() => openChat(conv.id)}
                  />
                ))}
              </PlateGroup>
            ) : null}
            {next.length > 0 ? (
              <PlateGroup label={next.length > 1 ? "Next automations" : "Next automation"}>
                {next.slice(0, 3).map((r) => (
                  <PlateRow
                    key={r.id}
                    icon={<Icon name="workflow" size={13} color={c.textMuted} />}
                    title={r.name}
                    detail={`${triggerText(r)} · ${formatDistanceToNowStrict(new Date(r.nextRunAt!), { addSuffix: true })}`}
                  />
                ))}
                {next.length > 3 ? (
                  <T variant="footnote" muted style={styles.more}>
                    and {next.length - 3} more
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
  const memory = useQuery({ queryKey: qk.agentMemory(agent.id), queryFn: () => api.agents.memory(agent.id), retry: false });
  if (!memory.data) return null;
  const { chars, target, updatedAt, dreaming } = memory.data;
  const detail = !chars
    ? "Nothing remembered yet"
    : `${chars.toLocaleString()} of ${target.toLocaleString()} characters${updatedAt ? ` · updated ${formatDistanceToNowStrict(new Date(updatedAt), { addSuffix: true })}` : ""}`;
  return (
    <View>
      <SectionTitle title="Memory" />
      <Card style={styles.plate}>
        <PlateRow
          icon={<Icon name={dreaming ? "moon" : "brain"} size={14} color={dreaming ? c.dream : chars > target ? c.warning : c.textMuted} />}
          title={dreaming ? "Dreaming — tidying up its memory" : "What it remembers"}
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
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.routines.setEnabled(routine.id, enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.routines }),
    onError: (err) => Alert.alert("Couldn't change the automation", errorText(err)),
  });
  const run = useMutation({
    mutationFn: () => api.routines.run(routine.id),
    onSuccess: (r) => useLive.getState().runStarted(r),
    onError: (err) => Alert.alert("Couldn't run it", errorText(err)),
  });
  const enabled = toggle.isPending ? !!toggle.variables : routine.enabled;
  return (
    <Row style={{ gap: space.md, padding: space.lg }}>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={1}>
          {routine.name}
        </T>
        <T variant="footnote" muted numberOfLines={2}>
          {triggerText(routine)}
          {routine.lastStatus === "failed" ? " · last run failed" : ""}
        </T>
      </View>
      <Pressable
        accessibilityLabel={`Run ${routine.name} now`}
        disabled={run.isPending || !routine.enabled}
        onPress={() => {
          tap();
          run.mutate();
        }}
        style={({ pressed }) => [styles.runNow, { backgroundColor: c.sunken, opacity: !routine.enabled ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <Icon name="play" size={12} color={c.text} />
      </Pressable>
      <Switch value={enabled} onValueChange={(v) => toggle.mutate(v)} trackColor={{ true: c.brand, false: c.sunken }} />
    </Row>
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
  runNow: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
