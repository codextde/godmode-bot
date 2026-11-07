import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { useTranslation } from "react-i18next";
import { chatOptionsBody, useNewChatOptions } from "@/lib/chat-options";
import { CharacterAvatar } from "@/components/character";
import { Icon } from "@/components/icon";
import { Composer, type ComposerHandle, type SendOptions } from "@/components/composer";
import { ModelButton } from "@/components/model-button";
import { ProjectPicker } from "@/components/project-picker";
import { Skeleton, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { pickAgent, SUGGESTIONS } from "@/lib/desktop-parity";
import { useNewChatChoice } from "@/lib/composer";
import { markVoiceRun } from "@/lib/voice-replies";
import { confirmHideSuggestions, useSuggestions } from "@/lib/suggestions";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { agentsFor, projectsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/** A new chat in the picked workspace: pick who does it, say what to do. */
export default function Compose() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const hideSuggestions = useSuggestions((s) => s.hidden);
  const { agentId, prompt } = useLocalSearchParams<{ agentId?: string; prompt?: string }>();
  const { data: agents, isLoading } = useAgents();
  const { id: workspaceId, projectId: scopeProject, workspaces } = useWorkspace();
  const enabled = agentsFor(agents ?? [], workspaceId)
    .filter((a) => a.enabled)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const current = pickAgent(enabled, picked);
  const [idea, setIdea] = useState(prompt ?? "");
  const projects = projectsFor(current, workspaces, workspaceId);
  /** Picked here; undefined = the phone's project when the agent may work on it, else the agent's own. */
  const pickFor = `${current?.id ?? ""}|${workspaceId ?? ""}`;
  const [projectChoice, setProjectChoice] = useState<{ for: string; id: string | null } | null>(null);
  const projectPick = projectChoice?.for === pickFor ? projectChoice.id : undefined;
  const setProjectPick = (id: string | null) => setProjectChoice({ for: pickFor, id });
  const listed = (id: string | null | undefined) => (id && projects.some((p) => p.id === id) ? id : null);
  // Only a project from the list goes along; otherwise the agent's own project applies on the computer.
  const projectId = projectPick !== undefined ? listed(projectPick) : (listed(scopeProject) ?? listed(current?.projectId));

  const composer = useRef<ComposerHandle>(null);
  const rail = useRef<ScrollViewInstance>(null);
  const revealed = useRef(false);
  const choice = useNewChatChoice((s) => s.choice);
  const options = useNewChatOptions((s) => s.options);
  // A fresh sheet starts a normal chat; a profile belongs to the agent it was picked for.
  useEffect(() => useNewChatOptions.getState().reset(), []);
  useEffect(() => useNewChatOptions.getState().set({ browserProfileId: null }), [current?.id]);
  useEffect(() => {
    if (prompt) composer.current?.setText(prompt);
  }, [prompt]);
  // The model belongs to the agent picked here: a new pick starts from that agent's default.
  useEffect(() => useNewChatChoice.getState().reset(), [current?.id]);

  const start = async (content: string, files: PendingFile[], sent: SendOptions) => {
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
        ...chatOptionsBody(options),
      });
      useNewChatOptions.getState().reset();
      useLive.getState().runStarted(result.run);
      if (sent.voice) markVoiceRun(result.run.id);
      router.dismiss();
      router.push({ pathname: "/chat/[id]", params: { id: result.conversation.id } });
    } catch (err) {
      Alert.alert(t("compose.startFailed"), errorText(err));
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
        <View style={styles.head}>
          <T variant="title" style={{ flexShrink: 1 }} numberOfLines={1}>
            {options.private ? t("conv.privateStart") : t("compose.title")}
          </T>
          <PrivateToggle value={options.private} onChange={(on) => useNewChatOptions.getState().set({ private: on })} />
        </View>
        <WorkspaceChip />
      </View>
      {isLoading && !enabled.length ? (
        <View style={[styles.agents, { flexDirection: "row" }]} accessibilityLabel={t("compose.loadingAgents")}>
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
          placeholder={current ? t("compose.placeholderAgent", { name: current.name }) : t("compose.placeholder")}
          voice
          trailing={
            current ? (
              <>
                <OptionsButton
                  set={
                    !!options.browserProfileId ||
                    !!options.instructions.trim() ||
                    !!options.workingDirectory ||
                    !!options.vmId ||
                    options.sshServerIds.length > 0 ||
                    options.androidDeviceIds.length > 0 ||
                    options.runnerId !== undefined
                  }
                  onPress={() => router.push({ pathname: "/chat-options", params: { agentId: current.id, ...(workspaceId ? { workspaceId } : {}) } })}
                />
                <ModelButton agent={current} choice={choice} />
              </>
            ) : null
          }
        />
      </View>
      <ProjectPicker
        projects={projects}
        value={projectId}
        onChange={setProjectPick}
        inset={space.xl}
        allowNone={!current?.projectId}
        hint={projectId ? t("compose.projectHint") : undefined}
      />
      {hideSuggestions ? null : (
        <View style={{ paddingHorizontal: space.xl, gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <T variant="eyebrow" muted>
              {t("compose.try")}
            </T>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("compose.hideSuggestions")}
              hitSlop={10}
              onPress={() => {
                tap();
                confirmHideSuggestions();
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Icon name="close" size={12} weight="semibold" color={c.textFaint} />
            </Pressable>
          </View>
          {SUGGESTIONS.map(({ text }) => (
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
      )}
    </ScrollView>
  );
}

/** Top right of the sheet, like the desktop's Home: a private chat keeps nothing and is gone once you leave it. */
function PrivateToggle({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={t("conv.private")}
      accessibilityHint={value ? t("conv.privateOff") : t("conv.privateHint")}
      hitSlop={6}
      onPress={() => {
        tap();
        onChange(!value);
      }}
      style={({ pressed }) => [
        styles.private,
        value ? { backgroundColor: c.primary, borderColor: c.primary } : { borderColor: c.border, backgroundColor: c.surface },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Icon name="incognito" size={13} color={value ? c.onPrimary : c.textMuted} />
      <T variant="footnote" color={value ? c.onPrimary : c.textMuted} style={{ fontWeight: "600" }}>
        {t("conv.private")}
      </T>
    </Pressable>
  );
}

/** Browser profile and instructions for the new chat; tinted once something is picked. */
function OptionsButton({ set, onPress }: { set: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("conv.options")}
      accessibilityState={{ selected: set }}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.tool, { backgroundColor: set ? c.brandSoft : "transparent", opacity: pressed ? 0.6 : 1 }]}
    >
      <Icon name="slider" size={16} color={set ? c.brandStrong : c.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  private: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 30,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tool: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
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
