import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { CharacterAvatar } from "@/components/character";
import { Composer, type ComposerHandle } from "@/components/composer";
import { ModelButton } from "@/components/model-button";
import { ProjectPicker } from "@/components/project-picker";
import { Skeleton, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { useNewChatChoice } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { agentsFor, projectsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const IDEAS = ["Check my inbox and summarize what needs me", "Find the cheapest flight to Berlin next Friday", "What did you work on today?"];

/** A new chat in the picked workspace: pick who does it, say what to do. */
export default function Compose() {
  const c = useColors();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const { data: agents, isLoading } = useAgents();
  const { id: workspaceId, projectId: scopeProject, workspaces } = useWorkspace();
  const enabled = agentsFor(agents ?? [], workspaceId).filter((a) => a.enabled);
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const current =
    enabled.find((a) => a.id === picked) ??
    (scopeProject ? enabled.find((a) => a.projectId === scopeProject) : undefined) ??
    (workspaceId ? enabled.find((a) => a.workspaceId === workspaceId) : undefined) ??
    enabled.find((a) => a.isDefault) ??
    enabled[0];
  const [idea, setIdea] = useState("");
  const projects = projectsFor(current, workspaces, workspaceId);
  /** Picked here; undefined = the phone's project when the agent may work on it, else the agent's own. */
  const [projectPick, setProjectPick] = useState<string | null | undefined>(undefined);
  useEffect(() => setProjectPick(undefined), [current?.id, workspaceId]);
  const listed = (id: string | null | undefined) => (id && projects.some((p) => p.id === id) ? id : null);
  // Only a project from the list goes along; otherwise the agent's own project applies on the computer.
  const projectId = projectPick !== undefined ? listed(projectPick) : (listed(scopeProject) ?? listed(current?.projectId));

  const composer = useRef<ComposerHandle>(null);
  const rail = useRef<ScrollView>(null);
  const revealed = useRef(false);
  const choice = useNewChatChoice((s) => s.choice);
  // The model belongs to the agent picked here: a new pick starts from that agent's default.
  useEffect(() => useNewChatChoice.getState().reset(), [current?.id]);

  const start = async (content: string, files: PendingFile[]) => {
    try {
      const attachments = await encodeFiles(files);
      const result = await api.chat.start({
        agentId: current?.id,
        content,
        workspaceId,
        ...(projectId ? { projectId } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(choice.ultracode !== null ? { ultracode: choice.ultracode } : {}),
      });
      useLive.getState().runStarted(result.run);
      router.dismiss();
      router.push({ pathname: "/chat/[id]", params: { id: result.conversation.id } });
    } catch (err) {
      Alert.alert("Couldn't start the chat", errorText(err));
      throw err;
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.root}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <View style={{ paddingHorizontal: space.xl, gap: space.sm }}>
        <T variant="title">New chat</T>
        <WorkspaceChip />
      </View>
      {isLoading && !enabled.length ? (
        <View style={[styles.agents, { flexDirection: "row" }]} accessibilityLabel="Loading agents">
          {[112, 136, 96].map((w) => (
            <Skeleton key={w} width={w} height={36} radius={18} />
          ))}
        </View>
      ) : null}
      {/* One scrolling row, so a big team never pushes the message field off the sheet. */}
      <ScrollView
        ref={rail}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.agents}
      >
        {enabled.map((a) => {
          const active = a.id === current?.id;
          return (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => {
                tap();
                setPicked(a.id);
              }}
              onLayout={(e) => {
                if (!active || revealed.current) return;
                revealed.current = true;
                rail.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - space.xl), animated: false });
              }}
              style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
            >
              <CharacterAvatar agent={a} size={24} />
              <T variant="subhead" numberOfLines={1} color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                {a.name}
              </T>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ paddingHorizontal: space.md }}>
        <Composer
          ref={composer}
          draftKey="new-chat"
          agentId={current?.id}
          attachments
          onSend={start}
          autoFocus
          placeholder={current ? `What should ${current.name} do?` : "What should Godmode do?"}
          trailing={current ? <ModelButton agent={current} choice={choice} /> : null}
        />
      </View>
      <ProjectPicker
        projects={projects}
        value={projectId}
        onChange={setProjectPick}
        inset={space.xl}
        allowNone={!current?.projectId}
        hint={projectId ? "It works with the project's context, folders and repositories." : undefined}
      />
      <View style={{ paddingHorizontal: space.xl, gap: space.sm }}>
        <T variant="eyebrow" muted>
          Try
        </T>
        {IDEAS.map((text) => (
          <Pressable
            key={text}
            onPress={() => {
              tap();
              setIdea(text);
              composer.current?.setText(text);
            }}
            style={({ pressed }) => [styles.idea, { borderColor: idea === text ? c.borderStrong : c.border, opacity: pressed ? 0.6 : 1 }]}
          >
            <T variant="subhead" muted>
              {text}
            </T>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingTop: 28,
    paddingBottom: 40,
    gap: space.lg,
  },
  agents: {
    gap: space.sm,
    paddingHorizontal: space.xl,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: radius.pill,
  },
  idea: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
