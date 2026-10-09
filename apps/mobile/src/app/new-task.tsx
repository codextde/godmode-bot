import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  TASK_TYPES,
  taskAttachmentMarkdown,
  type Agent,
  type TaskAttachment,
  type TaskType,
} from "@godmode/shared";
import { AttachmentTray } from "@/components/attachments";
import { CharacterAvatar } from "@/components/character";
import { Icon } from "@/components/icon";
import { ProjectPicker } from "@/components/project-picker";
import { TYPE_META } from "@/components/task-row";
import { Button, Skeleton, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { usePendingFiles } from "@/lib/attachments";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const NONE = "none";

/** A new task in the picked workspace: with an agent it starts right away, without one it waits in the backlog. */
export default function NewTask() {
  const c = useColors();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const { id: workspaceId, workspace, projectId: scopeProject } = useWorkspace();
  const [projectPick, setProjectPick] = useState<string | null | undefined>(undefined);
  // A workspace switched in the sheet takes its own projects: a pick from the old one doesn't carry over.
  useEffect(() => setProjectPick(undefined), [workspaceId]);
  const chosen = projectPick !== undefined ? projectPick : scopeProject;
  const projectId = chosen && workspace?.projects?.some((p) => p.id === chosen) ? chosen : null;
  const { data: allAgents, isLoading: agentsLoading } = useAgents();
  const agents = agentsFor(allAgents ?? [], workspaceId).filter((a) => a.enabled);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TaskType>("general");
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const { files, attach, remove } = usePendingFiles();
  const [saving, setSaving] = useState(false);
  const uploads = useRef(new Map<string, TaskAttachment>());
  const agent =
    picked === NONE ? undefined : (agents.find((a) => a.id === picked) ?? (projectId ? agents.find((a) => a.projectId === projectId) : undefined) ?? agents[0]);

  const create = async () => {
    const name = title.trim();
    if (!name) return;
    // Every link takes its name twice plus the url; checked before anything is uploaded.
    const links = files.reduce((sum, f) => sum + f.name.length * 3 + 64, 0);
    if (description.trim().length + links > MAX_TASK_DESCRIPTION_LENGTH) {
      Alert.alert("The details are too long", "Shorten the text or attach fewer files.");
      return;
    }
    setSaving(true);
    try {
      const attachments = [];
      for (const f of files) {
        // A retry after a failed create doesn't upload the same file again.
        const done = uploads.current.get(f.id) ?? (await api.tasks.upload(f));
        uploads.current.set(f.id, done);
        attachments.push(done);
      }
      const details = [description.trim(), ...attachments.map(taskAttachmentMarkdown)].filter(Boolean).join("\n\n");
      const task = await api.tasks.create({ workspaceId, ...(projectId ? { projectId } : {}), title: name, description: details || undefined, type, agentId: agent?.id ?? null });
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
        {files.length > 0 && <AttachmentTray files={files} busy={saving} onRemove={remove} />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={files.length ? `Add more files, ${files.length} added` : "Add photos or files"}
          disabled={saving}
          onPress={() => {
            tap();
            void attach();
          }}
          style={({ pressed }) => [styles.attach, { borderTopColor: c.border, opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon name="attach" size={15} color={c.textMuted} />
          <T variant="subhead" muted style={{ flex: 1 }}>
            {files.length ? "Add more" : "Add photos or files"}
          </T>
          {files.length > 0 && (
            <T variant="footnote" color={c.textFaint}>
              {files.length === 1 ? "1 file" : `${files.length} files`}
            </T>
          )}
        </Pressable>
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

      <ProjectPicker
        bleed={space.xl}
        projects={workspace?.projects ?? []}
        value={projectId}
        onChange={setProjectPick}
        hint={projectId ? "The agent works with the project's context, folders and repositories." : "It uses the workspace's setup."}
      />

      <View style={{ gap: space.sm }}>
        <T variant="eyebrow" muted>
          Agent
        </T>
        <View style={styles.chips}>
          {agentsLoading
            ? [104, 128, 92].map((w) => <Skeleton key={w} width={w} height={36} radius={18} />)
            : agents.map((a) => <Chip key={a.id} active={a.id === agent?.id} onPress={() => setPicked(a.id)} label={a.name} agent={a} />)}
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
  attach: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
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
