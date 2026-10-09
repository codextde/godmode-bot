import { useMutation, useQuery } from "@tanstack/react-query";
import { format, isToday } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import type { Routine } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { CharacterAvatar } from "@/components/character";
import { HeaderActions } from "@/components/header-actions";
import { ConversationRow, RunCard } from "@/components/rows";
import { Badge, Button, Card, ErrorState, Hairline, LoadingState, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { useProjectIndex } from "@/lib/workspace";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agents = useAgents();
  const { byId } = agents;
  const agent = byId.get(id);
  const project = useProjectIndex().get(agent?.projectId ?? "")?.project;
  const runs = useLive((s) => s.runs);
  const working = Object.values(runs).filter((r) => r.run.agentId === id && r.run.status === "running");
  const routines = useQuery({ queryKey: qk.agentRoutines(id), queryFn: () => api.routines.list({ agentId: id }) });
  const chats = useQuery({ queryKey: [...qk.conversations, "agent", id], queryFn: () => api.conversations.list({ agentId: id, limit: 5 }) });

  if (!agent) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>Agent</Stack.Title>
        {agents.isLoading ? (
          <LoadingState label="Loading the agent…" />
        ) : (
          <ErrorState
            title={agents.isError ? "Couldn't load the agent" : "This agent is gone"}
            error={agents.isError ? errorText(agents.error) : "It was deleted on your computer."}
            onRetry={agents.isError ? () => void agents.refetch() : undefined}
          />
        )}
      </View>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>{agent.name}</Stack.Title>
      <HeaderActions actions={[{ icon: "slider", label: `Set up ${agent.name}`, onPress: () => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } }) }]} />
      <View style={styles.hero}>
        <CharacterAvatar agent={agent} size={76} running={working.length > 0} style={{ marginTop: space.md }} />
        <T variant="title">{agent.name}</T>
        <Row style={{ gap: 6 }}>
          {agent.isDefault && <Badge label="Main assistant" />}
          {project ? <Badge label={`${project.icon ? `${project.icon} ` : ""}${project.name}`} /> : null}
          {!agent.enabled ? (
            <Badge label="Off" />
          ) : working.length ? (
            <Badge label={working.length > 1 ? `Working in ${working.length} chats` : "Working"} tone="brand" live />
          ) : (agent.openQuestions ?? 0) > 0 ? (
            <Badge label="Needs your answer" tone="warning" />
          ) : agent.failedRunId ? (
            <Badge label="Last run failed" tone="danger" />
          ) : null}
        </Row>
        {agent.role ? (
          <T variant="subhead" style={{ textAlign: "center" }}>
            {agent.role}
          </T>
        ) : null}
        {agent.description ? (
          <T variant="subhead" muted style={{ textAlign: "center", maxWidth: 320 }}>
            {agent.description}
          </T>
        ) : null}
        <Button
          title="Give it a task"
          icon="compose"
          disabled={!agent.enabled}
          onPress={() => router.push({ pathname: "/compose", params: { agentId: agent.id } })}
          style={{ marginTop: space.sm, alignSelf: "stretch" }}
        />
      </View>

      {working.length > 0 && (
        <View>
          <SectionTitle title="Working now" />
          <View style={{ gap: space.md }}>
            {working.map((w) => (
              <RunCard key={w.run.id} live={w} agent={agent} />
            ))}
          </View>
        </View>
      )}

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
          ) : (
            routines.isLoading ? (
              <SkeletonRows count={2} avatar={0} />
            ) : (
              <T variant="subhead" muted style={{ padding: space.lg }}>
                No automations yet.
              </T>
            )
          )}
        </Card>
      </View>

      <View>
        <SectionTitle title="Recent chats" />
        <Card style={{ paddingVertical: 4 }}>
          {chats.data?.length ? (
            chats.data.map((conv) => <ConversationRow key={conv.id} conversation={conv} agent={agent} running={working.some((w) => w.run.conversationId === conv.id)} />)
          ) : (
            chats.isLoading ? (
              <SkeletonRows count={3} />
            ) : (
              <T variant="subhead" muted style={{ padding: space.lg }}>
                No chats yet.
              </T>
            )
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

function triggerText(r: Routine): string {
  switch (r.trigger.type) {
    case "schedule":
      return r.nextRunAt ? `Next run ${format(new Date(r.nextRunAt), isToday(new Date(r.nextRunAt)) ? "'today at' HH:mm" : "EEE 'at' HH:mm")}` : "On a schedule";
    case "app":
      return `When: ${r.trigger.triggerName}`;
    case "condition":
      return `When ${r.trigger.condition}`;
    case "webhook":
      return "When its webhook is called";
  }
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
  runNow: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
