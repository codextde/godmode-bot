import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow, TextEditor } from "@/components/form";
import { Identity, Sources } from "@/components/setup";
import { EmptyState, SectionTitle } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { patchProject } from "@/lib/setup";
import { space } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const DEFAULT = "default";

export default function ProjectScreen() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspaces, loading } = useWorkspace();
  const { data: agents } = useAgents();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const workspace = workspaces.find((w) => w.projects.some((p) => p.id === id));
  const p = workspace?.projects.find((x) => x.id === id);

  if (!workspace || !p) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: t("agent.project") }} />
        <CloseButton />
        {loading ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="folder" title={t("project.notFound")} body={t("agent.notFound.body")} />}
      </ScrollView>
    );
  }

  const team = agents?.filter((a) => a.projectId === p.id) ?? [];
  const usable = (profiles.data ?? []).filter((b) => !b.workspaceId || b.workspaceId === workspace.id);

  const remove = () =>
    Alert.alert(t("workspace.deleteDialog.title", { name: p.name }), t("project.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await api.projects.delete(p.id);
            await queryClient.invalidateQueries({ queryKey: qk.workspaces });
            router.back();
          } catch (err) {
            Alert.alert(t("workspace.deleteFailed"), errorText(err));
          }
        },
      },
    ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: p.name, headerLargeTitleEnabled: false }} />
      <CloseButton />

      <Identity icon={p.icon} name={p.name} description={p.description} fallbackIcon="📁" onChange={(patch) => void patchProject(p.id, patch)} />

      <LinkRow
        emoji={workspace.icon || "🗂️"}
        title={workspace.name}
        detail={t("project.workspaceDetail")}
        onPress={() => router.push({ pathname: "/settings/workspace/[id]", params: { id: workspace.id } })}
      />

      <View>
        <SectionTitle title={t("project.context")} />
        <TextEditor
          label={t("project.contextLabel", { name: p.name })}
          value={p.instructions}
          placeholder={t("project.contextPlaceholder")}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          onSave={(instructions) => patchProject(p.id, { instructions }, { quiet: true })}
        />
      </View>

      {team.length ? (
        <Group title={t("project.agents")} footer={t("project.agentsFooter")}>
          {team.map((a) => (
            <LinkRow
              key={a.id}
              lead={<CharacterAvatar agent={a} size={30} />}
              title={a.name}
              detail={a.role || undefined}
              onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: a.id } })}
            />
          ))}
        </Group>
      ) : null}

      <Sources
        sources={p.sources}
        footer={t("project.sourcesFooter")}
        onSave={(sources) => patchProject(p.id, { sources })}
        onSync={(sourceId) => api.projects.sync(p.id, sourceId)}
      />

      <Group>
        <PickerRow
          icon="globe"
          title={t("workspace.browserProfile")}
          value={p.browserProfileId ?? DEFAULT}
          options={[{ value: DEFAULT, label: t("project.workspaceProfile") }, ...usable.map((b) => ({ value: b.id, label: b.name }))]}
          onChange={(v) => void patchProject(p.id, { browserProfileId: v === DEFAULT ? null : v })}
        />
      </Group>

      <Group>
        <LinkRow icon="trash" title={t("project.delete")} tone="danger" chevron={false} onPress={remove} />
      </Group>
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
