import { router, Stack } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { EmptyState, Button } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { space } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

export default function Workspaces() {
  const { t } = useTranslation("settings");
  const { workspaces } = useWorkspace();
  const { data: agents } = useAgents();
  const create = () => router.push({ pathname: "/settings/new", params: { kind: "workspace" } });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("overview.team.workspaces") }} />
      <CloseButton />
      <HeaderActions actions={[{ icon: "plus", label: t("workspaces.new"), onPress: create }]} />
      {workspaces.length ? (
        <Group footer={t("workspaces.footer")}>
          {workspaces.map((w) => {
            const team = agents?.filter((a) => a.workspaceId === w.id).length ?? 0;
            const facts = [
              w.projects.length ? t("overview.team.projects", { count: w.projects.length }) : null,
              team ? t("workspaces.agents", { count: team }) : null,
              w.sources.length ? t("workspaces.repositories", { count: w.sources.length }) : null,
            ].filter(Boolean);
            return (
              <LinkRow
                key={w.id}
                emoji={w.icon || "🗂️"}
                title={w.name}
                detail={facts.length ? facts.join(" · ") : w.description || t("workspaces.empty")}
                onPress={() => router.push({ pathname: "/settings/workspace/[id]", params: { id: w.id } })}
              />
            );
          })}
        </Group>
      ) : (
        <EmptyState
          icon="layers"
          title={t("workspaces.none.title")}
          body={t("workspaces.none.body")}
          action={<Button title={t("workspaces.create")} icon="plus" onPress={create} />}
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
