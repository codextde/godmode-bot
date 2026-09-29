import { useMutation, useQuery } from "@tanstack/react-query";
import { format, isToday } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import type { Routine } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { ConversationRow, RunCard } from "@/components/rows";
import { Avatar, Badge, Button, Card, Hairline, Row, SectionTitle, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId } = useAgents();
  const agent = byId.get(id);
  const runs = useLive((s) => s.runs);
  const working = Object.values(runs).filter((r) => r.run.agentId === id);
  const routines = useQuery({ queryKey: qk.agentRoutines(id), queryFn: () => api.routines.list({ agentId: id }) });
  const chats = useQuery({ queryKey: [...qk.conversations, "agent", id], queryFn: () => api.conversations.list({ agentId: id, limit: 5 }) });

  if (!agent) return <Stack.Title>Agent</Stack.Title>;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>{agent.name}</Stack.Title>
      <View style={styles.hero}>
        <Avatar emoji={agent.avatar} size={76} running={working.length > 0} />
        <T variant="title">{agent.name}</T>
        <Row style={{ gap: 6 }}>
          {agent.isDefault && <Badge label="Main assistant" />}
          {!agent.enabled ? <Badge label="Paused" tone="warning" /> : working.length ? <Badge label="Working" tone="brand" live /> : null}
        </Row>
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
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {routines.isLoading ? "Loading…" : "No automations. Set them up on your computer."}
            </T>
          )}
        </Card>
      </View>

      <View>
        <SectionTitle title="Recent chats" />
        <Card style={{ paddingVertical: 4 }}>
          {chats.data?.length ? (
            chats.data.map((conv) => <ConversationRow key={conv.id} conversation={conv} agent={agent} running={working.some((w) => w.run.conversationId === conv.id)} />)
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {chats.isLoading ? "Loading…" : "No chats yet."}
            </T>
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
