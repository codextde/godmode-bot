import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { CharacterAvatar } from "@/components/character";
import { Composer, type ComposerHandle } from "@/components/composer";
import { ModelButton } from "@/components/model-button";
import { T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { useNewChatChoice } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const IDEAS = ["Check my inbox and summarize what needs me", "Find the cheapest flight to Berlin next Friday", "What did you work on today?"];

/** A new chat in the picked workspace: pick who does it, say what to do. */
export default function Compose() {
  const c = useColors();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const { data: agents } = useAgents();
  const { id: workspaceId } = useWorkspace();
  const enabled = agentsFor(agents ?? [], workspaceId).filter((a) => a.enabled);
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const current =
    enabled.find((a) => a.id === picked) ??
    (workspaceId ? enabled.find((a) => a.workspaceId === workspaceId) : undefined) ??
    enabled.find((a) => a.isDefault) ??
    enabled[0];
  const [idea, setIdea] = useState("");

  const composer = useRef<ComposerHandle>(null);
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
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={{ paddingHorizontal: space.xl, gap: space.sm }}>
        <T variant="title">New chat</T>
        <WorkspaceChip />
      </View>
      <View style={styles.agents}>
        {enabled.map((a) => {
          const active = a.id === current?.id;
          return (
            <Pressable
              key={a.id}
              onPress={() => {
                tap();
                setPicked(a.id);
              }}
              style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
            >
              <CharacterAvatar agent={a} size={24} />
              <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                {a.name}
              </T>
            </Pressable>
          );
        })}
      </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingTop: 28,
    gap: space.lg,
  },
  agents: {
    flexDirection: "row",
    flexWrap: "wrap",
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
