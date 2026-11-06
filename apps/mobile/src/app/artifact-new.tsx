import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { useTranslation } from "react-i18next";
import { ARTIFACT_STARTERS } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Composer, type ComposerHandle } from "@/components/composer";
import { T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { pickAgent } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const STARTER_KEYS = ["sales", "kpi", "pipeline", "budget", "content", "calculator"] as const;

/** Describe a dashboard or a small app; the picked agent builds it in a new chat. */
export default function NewArtifact() {
  const c = useColors();
  const { t } = useTranslation("artifacts");
  const { data: agents } = useAgents();
  const { id: workspaceId } = useWorkspace();
  const enabled = agentsFor(agents ?? [], workspaceId)
    .filter((a) => a.enabled)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const [picked, setPicked] = useState<string | undefined>();
  const current = pickAgent(enabled, picked);
  const composer = useRef<ComposerHandle>(null);
  const rail = useRef<ScrollViewInstance>(null);

  const start = async (prompt: string) => {
    try {
      const { conversationId } = await api.artifacts.start({ prompt, agentId: current?.id, workspaceId });
      router.dismiss();
      router.push({ pathname: "/chat/[id]", params: { id: conversationId } });
    } catch (err) {
      Alert.alert(t("new.startError"), errorText(err));
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
        <T variant="title">{t("new.title")}</T>
        <WorkspaceChip />
      </View>
      {enabled.length > 1 ? (
        <ScrollView ref={rail} horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.rail}>
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
      ) : null}
      <View style={{ paddingHorizontal: space.md }}>
        <Composer ref={composer} draftKey="new-artifact" agentId={current?.id} onSend={(text) => start(text)} autoFocus placeholder={t("new.placeholder")} />
      </View>
      <View style={styles.starters}>
        {STARTER_KEYS.map((key) => {
          const starter = ARTIFACT_STARTERS.find((s) => s.id === key);
          if (!starter) return null;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              onPress={() => {
                tap();
                composer.current?.setText(starter.prompt);
              }}
              style={({ pressed }) => [styles.starter, { borderColor: c.border, opacity: pressed ? 0.6 : 1 }]}
            >
              <T variant="subhead" muted>
                {t(`starters.${key}`)}
              </T>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { paddingTop: 28, paddingBottom: 40, gap: space.lg },
  rail: { gap: space.sm, paddingHorizontal: space.xl },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingLeft: 8, paddingRight: 14, borderRadius: radius.pill },
  starters: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.xl },
  starter: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
});
