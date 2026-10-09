import { router, Stack } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { EmptyState, Button } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { space } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export default function Workspaces() {
  const { workspaces } = useWorkspace();
  const { data: agents } = useAgents();
  const create = () => router.push({ pathname: "/settings/new", params: { kind: "workspace" } });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Workspaces" }} />
      <CloseButton />
      <HeaderActions actions={[{ icon: "plus", label: "New workspace", onPress: create }]} />
      {workspaces.length ? (
        <Group footer="A workspace gives a client or product its own agents, context, repositories and projects.">
          {workspaces.map((w) => {
            const team = agents?.filter((a) => a.workspaceId === w.id).length ?? 0;
            const facts = [
              w.projects.length ? plural(w.projects.length, "project", "projects") : null,
              team ? plural(team, "agent", "agents") : null,
              w.sources.length ? plural(w.sources.length, "repository", "repositories") : null,
            ].filter(Boolean);
            return (
              <LinkRow
                key={w.id}
                emoji={w.icon || "🗂️"}
                title={w.name}
                detail={facts.length ? facts.join(" · ") : w.description || "Empty"}
                onPress={() => router.push({ pathname: "/settings/workspace/[id]", params: { id: w.id } })}
              />
            );
          })}
        </Group>
      ) : (
        <EmptyState
          icon="layers"
          title="No workspaces yet"
          body="Give a client or product its own agents, context and repositories."
          action={<Button title="Create a workspace" icon="plus" onPress={create} />}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
