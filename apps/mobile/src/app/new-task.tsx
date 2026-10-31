import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["chat", "common"]);
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
      Alert.alert(t("newTask.tooLongTitle"), t("newTask.tooLongMessage"));
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
      Alert.alert(t("newTask.createFailed"), errorText(err));
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
        <T variant="title">{t("newTask.title")}</T>
        <WorkspaceChip />
      </View>

      <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={t("newTask.titlePlaceholder")}
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
          placeholder={t("newTask.detailsPlaceholder")}
          placeholderTextColor={c.textFaint}
          multiline
          style={[styles.description, { color: c.text }]}
        />
        {files.length > 0 && <AttachmentTray files={files} busy={saving} onRemove={remove} />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={files.length ? t("newTask.addMoreFilesA11y", { count: files.length }) : t("newTask.addFiles")}
          disabled={saving}
          onPress={() => {
            tap();
            void attach();
          }}
          style={({ pressed }) => [styles.attach, { borderTopColor: c.border, opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon name="attach" size={15} color={c.textMuted} />
          <T variant="subhead" muted style={{ flex: 1 }}>
            {files.length ? t("newTask.addMore") : t("newTask.addFiles")}
          </T>
          {files.length > 0 && (
            <T variant="footnote" color={c.textFaint}>
              {t("newTask.fileCount", { count: files.length })}
            </T>
          )}
        </Pressable>
      </View>

      <View style={{ gap: space.sm }}>
        <T variant="eyebrow" muted>
          {t("newTask.kind")}
        </T>
        <View style={styles.chips}>
          {TASK_TYPES.map((k) => (
            <Chip key={k} active={k === type} onPress={() => setType(k)} label={TYPE_META[k].label} />
          ))}
        </View>
        <T variant="footnote" muted>
          {TYPE_META[type].hint}
          {type === "coding" && !workspace ? t("newTask.codingNeedsWorkspace") : "."}
        </T>
      </View>

      <ProjectPicker
        bleed={space.xl}
        projects={workspace?.projects ?? []}
        value={projectId}
        onChange={setProjectPick}
        hint={projectId ? t("newTask.projectHint") : t("newTask.workspaceHint")}
      />

      <View style={{ gap: space.sm }}>
        <T variant="eyebrow" muted>
          {t("common:words.agent")}
        </T>
        <View style={styles.chips}>
          {agentsLoading
            ? [104, 128, 92].map((w) => <Skeleton key={w} width={w} height={36} radius={18} />)
            : agents.map((a) => <Chip key={a.id} active={a.id === agent?.id} onPress={() => setPicked(a.id)} label={a.name} agent={a} />)}
          <Chip active={!agent} onPress={() => setPicked(NONE)} label={t("newTask.unassigned")} />
        </View>
        <T variant="footnote" muted>
          {agent ? t("newTask.agentStarts", { name: agent.name }) : t("newTask.waitsInBacklog")}
        </T>
      </View>

      <Button
        title={agent ? t("newTask.startWith", { name: agent.name }) : t("newTask.addToBacklog")}
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
