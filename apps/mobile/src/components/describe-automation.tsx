import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Icon, type IconName } from "./icon";
import { Row, T, tap } from "./ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const EXAMPLES = [
  { icon: "clock", key: "weeklyReport" },
  { icon: "clock", key: "inbox" },
  { icon: "layers", key: "customerEmail" },
  { icon: "eye", key: "competitorPricing" },
] as const satisfies readonly { icon: IconName; key: string }[];

/**
 * "Describe what to automate": hands the sentence to Godmode, which picks the trigger, the agent and the steps in a
 * chat, like the desktop's card. `open`: show the examples without focusing first (no automations yet).
 */
export function DescribeAutomation({ open = false }: { open?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("automations");
  const { id: workspaceId } = useWorkspace();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const { data: agents } = useAgents();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const godmode = boot.data?.defaultAgentId ?? agents?.find((a) => a.isDefault)?.id;

  const start = useMutation({
    mutationFn: () => api.chat.start({ agentId: godmode, content: t("describe.prompt", { text: text.trim() }), workspaceId }),
    onSuccess: (res) => {
      setText("");
      useLive.getState().runStarted(res.run);
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      router.push({ pathname: "/chat/[id]", params: { id: res.conversation.id } });
    },
    onError: (err) => Alert.alert(t("describe.unreachable"), errorText(err)),
  });
  const ready = text.trim().length > 3 && !start.isPending;
  const submit = () => {
    if (!ready) return;
    tap();
    start.mutate();
  };
  const examples = open || focused || text.length > 0;

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: focused ? c.borderStrong : c.border, boxShadow: c.shadowCard }]}>
      <Row style={{ gap: 6 }}>
        <Icon name="sparkles" size={13} color={c.textMuted} />
        <T variant="footnote" muted style={{ fontWeight: "600" }}>
          {t("describe.title")}
        </T>
      </Row>
      <TextInput
        accessibilityLabel={t("describe.title")}
        value={text}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={t("describe.placeholder")}
        placeholderTextColor={c.textFaint}
        multiline
        maxLength={2000}
        style={[styles.input, { color: c.text }]}
      />
      {examples ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6 }} style={{ marginHorizontal: -space.md }}>
            <View style={{ width: space.md - 6 }} />
            {EXAMPLES.map((ex) => (
              <Pressable
                key={ex.key}
                accessibilityRole="button"
                onPress={() => {
                  tap();
                  setText(t(`describe.examples.${ex.key}`));
                }}
                style={({ pressed }) => [styles.example, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
              >
                <Icon name={ex.icon} size={12} color={c.textMuted} />
                <T variant="footnote" muted numberOfLines={1} style={{ maxWidth: 260 }}>
                  {t(`describe.examples.${ex.key}`)}
                </T>
              </Pressable>
            ))}
            <View style={{ width: space.md - 6 }} />
          </ScrollView>
        </Animated.View>
      ) : null}
      {examples || text.trim() ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready, busy: start.isPending }}
          disabled={!ready}
          onPress={submit}
          style={({ pressed }) => [styles.submit, { backgroundColor: c.primary, opacity: !ready ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          {start.isPending ? <ActivityIndicator size="small" color={c.onPrimary} /> : <Icon name="sparkles" size={13} color={c.onPrimary} />}
          <T variant="footnote" color={c.onPrimary} style={{ fontWeight: "600" }}>
            {t("describe.submit")}
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    fontSize: 16,
    lineHeight: 21,
    minHeight: 44,
    maxHeight: 140,
    paddingVertical: 4,
    textAlignVertical: "top",
  },
  example: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  submit: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
});
