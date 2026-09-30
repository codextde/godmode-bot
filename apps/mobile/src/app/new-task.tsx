import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { MAX_TASK_TITLE_LENGTH, TASK_TYPES, type Agent, type TaskType } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { TYPE_META } from "@/components/task-row";
import { Button, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const NONE = "none";

/** A new task in the picked workspace: with an agent it starts right away, without one it waits in the backlog. */
export default function NewTask() {
  const c = useColors();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const { id: workspaceId, workspace } = useWorkspace();
  const { data: allAgents } = useAgents();
  const agents = agentsFor(allAgents ?? [], workspaceId).filter((a) => a.enabled);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TaskType>("general");
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const [saving, setSaving] = useState(false);
  const agent = picked === NONE ? undefined : (agents.find((a) => a.id === picked) ?? agents[0]);

  const create = async () => {
    const name = title.trim();
    if (!name) return;
    setSaving(true);
    try {
      const task = await api.tasks.create({ workspaceId, title: name, description: description.trim() || undefined, type, agentId: agent?.id ?? null });
      void queryClient.invalidateQueries({ queryKey: qk.tasks });
      router.dismiss();
      router.push({ pathname: "/task/[id]", params: { id: task.id } });
    } catch (err) {
      Alert.alert("Couldn't create the task", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <View style={{ gap: space.sm }}>
        <T variant="title">New task</T>
        <WorkspaceChip />
      </View>

      <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="What needs to be done?"
          placeholderTextColor={c.textFaint}
          maxLength={MAX_TASK_TITLE_LENGTH}
          autoFocus
          // Done puts the keyboard away so the kind, the agent and the button show.
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          style={[styles.title, { color: c.text }]}
        />
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Details, links, what done looks like (optional)"
          placeholderTextColor={c.textFaint}
          multiline
          style={[styles.description, { color: c.text }]}
        />
      </View>

      <View style={{ gap: space.sm }}>
        <T variant="eyebrow" muted>
          Kind
        </T>
        <View style={styles.chips}>
          {TASK_TYPES.map((t) => (
            <Chip key={t} active={t === type} onPress={() => setType(t)} label={TYPE_META[t].label} />
          ))}
        </View>
        <T variant="footnote" muted>
          {TYPE_META[type].hint}
          {type === "coding" && !workspace ? ". Pick a workspace with a repository on your computer." : "."}
        </T>
      </View>

      <View style={{ gap: space.sm }}>
        <T variant="eyebrow" muted>
          Agent
        </T>
        <View style={styles.chips}>
          {agents.map((a) => (
            <Chip key={a.id} active={a.id === agent?.id} onPress={() => setPicked(a.id)} label={a.name} agent={a} />
          ))}
          <Chip active={!agent} onPress={() => setPicked(NONE)} label="Nobody yet" />
        </View>
        <T variant="footnote" muted>
          {agent ? `${agent.name} starts as soon as you create it.` : "It waits in the backlog until you assign an agent."}
        </T>
      </View>

      <Button
        title={agent ? `Start with ${agent.name}` : "Add to backlog"}
        icon={agent ? "play" : "plus"}
        size="lg"
        loading={saving}
        disabled={!title.trim()}
        onPress={() => void create()}
      />
    </ScrollView>
  );
}

function Chip({ active, onPress, label, agent }: { active: boolean; onPress: () => void; label: string; agent?: Agent }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }, agent && { paddingLeft: 8 }]}
    >
      {agent ? <CharacterAvatar agent={agent} size={24} /> : null}
      <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 28,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.xl,
  },
  fields: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  description: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 96,
    maxHeight: 200,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
});
