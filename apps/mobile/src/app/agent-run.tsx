import { useMutation } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { failureText } from "@/components/agent-actions";
import { CharacterAvatar } from "@/components/character";
import { Button, Row, T } from "@/components/ui";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

/** The desktop's "Run a task": a one-off job in a new chat, right now. Left empty, the agent follows its instructions. */
export default function AgentRun() {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const agent = useAgents().byId.get(agentId);
  const { id: scope } = useWorkspace();
  const [prompt, setPrompt] = useState("");
  const run = useMutation({
    mutationFn: () => api.agents.runOnce(agentId, prompt.trim(), agent?.workspaceId ?? scope),
    onSuccess: (res) => {
      useLive.getState().runStarted(res.run);
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      router.dismiss();
      router.push({ pathname: "/chat/[id]", params: { id: res.conversation.id } });
    },
    onError: (err) => Alert.alert(t("run.failed"), failureText(err)),
  });
  const name = agent?.name ?? t("common:words.agent");

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <Row style={{ gap: space.md }}>
        <CharacterAvatar agent={agent} size={40} />
        <T variant="title" style={{ flex: 1 }} numberOfLines={2}>
          {t("run.title", { name })}
        </T>
      </Row>
      <View style={[styles.field, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          accessibilityLabel={t("run.label")}
          value={prompt}
          onChangeText={setPrompt}
          placeholder={agent?.description ? t("run.placeholderExample", { description: agent.description }) : t("run.placeholder")}
          placeholderTextColor={c.textFaint}
          multiline
          autoFocus
          maxLength={100_000}
          style={[styles.input, { color: c.text }]}
        />
      </View>
      <T variant="footnote" muted style={{ marginTop: -space.md, paddingHorizontal: 4 }}>
        {t("run.hint", { name })}
      </T>
      <Button title={t("run.submit")} icon="play" size="lg" loading={run.isPending} disabled={!agent?.enabled} onPress={() => run.mutate()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 28,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.xl,
  },
  field: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    fontSize: 16,
    lineHeight: 22,
    minHeight: 132,
    maxHeight: 260,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    textAlignVertical: "top",
  },
});
