import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
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
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspaces, loading } = useWorkspace();
  const { data: agents } = useAgents();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const workspace = workspaces.find((w) => w.projects.some((p) => p.id === id));
  const p = workspace?.projects.find((x) => x.id === id);

  if (!workspace || !p) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: "Project" }} />
        <CloseButton />
        {loading ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="folder" title="Project not found" body="It may have been deleted on your computer." />}
      </ScrollView>
    );
  }

  const team = agents?.filter((a) => a.projectId === p.id) ?? [];
  const usable = (profiles.data ?? []).filter((b) => !b.workspaceId || b.workspaceId === workspace.id);

  const remove = () =>
    Alert.alert(`Delete ${p.name}?`, "Its context and repositories go with it. Chats, tickets and agents stay in the workspace.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.projects.delete(p.id);
            await queryClient.invalidateQueries({ queryKey: qk.workspaces });
            router.back();
          } catch (err) {
            Alert.alert("Couldn't delete it", errorText(err));
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
        detail="Workspace: its context comes first"
        onPress={() => router.push({ pathname: "/settings/workspace/[id]", params: { id: workspace.id } })}
      />

      <View>
        <SectionTitle title="Project context" />
        <TextEditor
          label={`Context for ${p.name}`}
          value={p.instructions}
          placeholder={"Goals, scope, conventions and links for this project.\nAdded to the workspace's context on every run."}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          onSave={(instructions) => patchProject(p.id, { instructions }, { quiet: true })}
        />
      </View>

      {team.length ? (
        <Group title="Agents on it" footer="Agents work on this project by default. Chats and tickets can pick another.">
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
        footer="On top of the workspace's. Add folders of your computer there."
        onSave={(sources) => patchProject(p.id, { sources })}
        onSync={(sourceId) => api.projects.sync(p.id, sourceId)}
      />

      <Group>
        <PickerRow
          icon="globe"
          title="Browser profile"
          value={p.browserProfileId ?? DEFAULT}
          options={[{ value: DEFAULT, label: "The workspace's" }, ...usable.map((b) => ({ value: b.id, label: b.name }))]}
          onChange={(v) => void patchProject(p.id, { browserProfileId: v === DEFAULT ? null : v })}
        />
      </Group>

      <Group>
        <LinkRow icon="trash" title="Delete project" tone="danger" chevron={false} onPress={remove} />
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
