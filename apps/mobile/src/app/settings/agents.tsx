import { router, Stack } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import type { Agent } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { useAgents } from "@/lib/hooks";
import { space } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

export default function Agents() {
  const { data: agents } = useAgents();
  const { workspaces, id: picked } = useWorkspace();
  const groups = [
    { key: "global", title: "Everywhere", agents: (agents ?? []).filter((a) => !a.workspaceId) },
    ...workspaces.map((w) => ({ key: w.id, title: w.name, agents: (agents ?? []).filter((a) => a.workspaceId === w.id) })),
  ].filter((g) => g.agents.length);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Agents" }} />
      <CloseButton />
      <HeaderActions
        actions={[{ icon: "plus", label: "New agent", onPress: () => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: picked ?? "" } }) }]}
      />
      {groups.map((g) => (
        <Group key={g.key} title={g.title}>
          {g.agents.map((a) => (
            <AgentLink key={a.id} agent={a} />
          ))}
        </Group>
      ))}
    </ScrollView>
  );
}

function AgentLink({ agent }: { agent: Agent }) {
  return (
    <LinkRow
      lead={<CharacterAvatar agent={agent} size={34} />}
      title={agent.name}
      detail={agent.role || agent.description || undefined}
      value={!agent.enabled ? "Off" : agent.heartbeat.enabled ? "Heartbeat" : undefined}
      onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } })}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
