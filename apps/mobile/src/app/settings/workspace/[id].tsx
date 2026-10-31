import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow, SwitchRow, TextEditor } from "@/components/form";
import { Identity, Sources } from "@/components/setup";
import { EmptyState, SectionTitle } from "@/components/ui";
import { api, ApiError, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { firstLine, patchWorkspace } from "@/lib/setup";
import { space } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const DEFAULT = "default";

export default function WorkspaceScreen() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspaces, loading } = useWorkspace();
  const { data: agents } = useAgents();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const w = workspaces.find((x) => x.id === id);

  if (!w) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: t("workspace.title") }} />
        <CloseButton />
        {loading ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="layers" title={t("workspace.notFound")} body={t("agent.notFound.body")} />}
      </ScrollView>
    );
  }

  const team = agents?.filter((a) => a.workspaceId === w.id) ?? [];
  const usable = (profiles.data ?? []).filter((p) => !p.workspaceId || p.workspaceId === w.id);

  const remove = () =>
    Alert.alert(t("workspace.deleteDialog.title", { name: w.name }), t("workspace.deleteDialog.body"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await api.workspace.delete(w.id);
            await queryClient.invalidateQueries({ queryKey: qk.workspaces });
            router.back();
          } catch (err) {
            Alert.alert(t("workspace.deleteFailed"), err instanceof ApiError && err.status === 409 ? t("workspace.notEmpty", { name: w.name }) : errorText(err));
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
      <Stack.Screen options={{ title: w.name, headerLargeTitleEnabled: false }} />
      <CloseButton />

      <Identity icon={w.icon} name={w.name} description={w.description} fallbackIcon="🗂️" onChange={(patch) => void patchWorkspace(w.id, patch)} />

      <View>
        <SectionTitle title={t("workspace.context")} />
        <TextEditor
          label={t("workspace.contextLabel", { name: w.name })}
          value={w.instructions}
          placeholder={t("workspace.contextPlaceholder")}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          onSave={(instructions) => patchWorkspace(w.id, { instructions }, { quiet: true })}
        />
      </View>

      <Group title={t("workspace.projects")} footer={t("workspace.projectsFooter")}>
        {w.projects.map((p) => (
          <LinkRow
            key={p.id}
            emoji={p.icon || "📁"}
            title={p.name}
            detail={firstLine(p.instructions) || p.description || t("instructions.workspaces.noProjectContext")}
            onPress={() => router.push({ pathname: "/settings/project/[id]", params: { id: p.id } })}
          />
        ))}
        <LinkRow icon="plus" title={t("workspace.newProject")} tone="brand" chevron={false} onPress={() => router.push({ pathname: "/settings/new", params: { kind: "project", workspaceId: w.id } })} />
      </Group>

      <Group title={t("common:words.agents")}>
        {team.map((a) => (
          <LinkRow
            key={a.id}
            lead={<CharacterAvatar agent={a} size={30} />}
            title={a.name}
            detail={a.role || a.description || undefined}
            value={a.enabled ? undefined : t("common:status.off")}
            onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: a.id } })}
          />
        ))}
        <LinkRow icon="plus" title={t("agents.new")} tone="brand" chevron={false} onPress={() => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: w.id } })} />
      </Group>

      <Sources
        sources={w.sources}
        footer={t("workspace.sourcesFooter")}
        onSave={(sources) => patchWorkspace(w.id, { sources })}
        onSync={(sourceId) => api.workspace.sync(w.id, sourceId)}
      />

      <Group title={t("workspace.behavior")}>
        <SwitchRow
          icon="branch"
          title={t("workspace.autoMerge")}
          detail={t("workspace.autoMergeDetail")}
          value={w.autoMerge}
          onChange={(autoMerge) => void patchWorkspace(w.id, { autoMerge })}
        />
        <PickerRow
          icon="globe"
          title={t("workspace.browserProfile")}
          value={w.browserProfileId ?? DEFAULT}
          options={[{ value: DEFAULT, label: t("agent.thinking.default") }, ...usable.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => void patchWorkspace(w.id, { browserProfileId: v === DEFAULT ? null : v })}
        />
      </Group>

      <Group footer={t("workspace.deleteFooter")}>
        <LinkRow icon="trash" title={t("workspace.delete")} tone="danger" chevron={false} onPress={remove} />
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
