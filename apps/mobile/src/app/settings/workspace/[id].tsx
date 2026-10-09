import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
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
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspaces, loading } = useWorkspace();
  const { data: agents } = useAgents();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const w = workspaces.find((x) => x.id === id);

  if (!w) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: "Workspace" }} />
        <CloseButton />
        {loading ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="layers" title="Workspace not found" body="It may have been deleted on your computer." />}
      </ScrollView>
    );
  }

  const team = agents?.filter((a) => a.workspaceId === w.id) ?? [];
  const usable = (profiles.data ?? []).filter((p) => !p.workspaceId || p.workspaceId === w.id);

  const remove = () =>
    Alert.alert(`Delete ${w.name}?`, "Its repositories and context go with it. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.workspace.delete(w.id);
            await queryClient.invalidateQueries({ queryKey: qk.workspaces });
            router.back();
          } catch (err) {
            Alert.alert("Couldn't delete it", err instanceof ApiError && err.status === 409 ? `${w.name} still has projects, agents, tasks, logins or other things in it. Move or delete them first, or delete the workspace on your computer.` : errorText(err));
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
        <SectionTitle title="Agent context" />
        <TextEditor
          label={`Agent context for ${w.name}`}
          value={w.instructions}
          placeholder={"Who the client is, what the product does, links, tone, rules.\nEvery agent in this workspace gets it on every run."}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          onSave={(instructions) => patchWorkspace(w.id, { instructions }, { quiet: true })}
        />
      </View>

      <Group title="Projects" footer="Projects add their own context and repositories on top of the workspace's.">
        {w.projects.map((p) => (
          <LinkRow
            key={p.id}
            emoji={p.icon || "📁"}
            title={p.name}
            detail={firstLine(p.instructions) || p.description || "No project context yet"}
            onPress={() => router.push({ pathname: "/settings/project/[id]", params: { id: p.id } })}
          />
        ))}
        <LinkRow icon="plus" title="New project" tone="brand" chevron={false} onPress={() => router.push({ pathname: "/settings/new", params: { kind: "project", workspaceId: w.id } })} />
      </Group>

      <Group title="Agents">
        {team.map((a) => (
          <LinkRow
            key={a.id}
            lead={<CharacterAvatar agent={a} size={30} />}
            title={a.name}
            detail={a.role || a.description || undefined}
            value={a.enabled ? undefined : "Off"}
            onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: a.id } })}
          />
        ))}
        <LinkRow icon="plus" title="New agent" tone="brand" chevron={false} onPress={() => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: w.id } })} />
      </Group>

      <Sources
        sources={w.sources}
        footer="Every agent in the workspace works with these. Tasks get their own branch of a repository. Add folders of your computer there."
        onSave={(sources) => patchWorkspace(w.id, { sources })}
        onSync={(sourceId) => api.workspace.sync(w.id, sourceId)}
      />

      <Group title="Behavior">
        <SwitchRow
          icon="branch"
          title="Merge pull requests right away"
          detail="A ticket is done when its agent delivers, without your review."
          value={w.autoMerge}
          onChange={(autoMerge) => void patchWorkspace(w.id, { autoMerge })}
        />
        <PickerRow
          icon="globe"
          title="Browser profile"
          value={w.browserProfileId ?? DEFAULT}
          options={[{ value: DEFAULT, label: "Default" }, ...usable.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => void patchWorkspace(w.id, { browserProfileId: v === DEFAULT ? null : v })}
        />
      </Group>

      <Group footer="Only an empty workspace can be deleted here: no projects, agents, tasks or logins. Its chats move to every workspace.">
        <LinkRow icon="trash" title="Delete workspace" tone="danger" chevron={false} onPress={remove} />
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
