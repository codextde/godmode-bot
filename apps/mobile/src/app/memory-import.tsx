import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { IMPORT_MAX_CHARS, MEMORY_EXPORT_PROMPT, MEMORY_SOURCES, type MemorySource } from "@godmode/shared";
import { Group, SegmentRow } from "@/components/form";
import { Button, Row, T, tap } from "@/components/ui";
import { ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { settingsApi } from "@/lib/settings-api";
import { radius, space, useColors } from "@/lib/theme";

const failure = (err: unknown) => (err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));

/** Bring what another assistant remembers about you into Godmode: ask it with the prompt, paste its answer, and the main agent sorts it in. */
export default function MemoryImportSheet() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const [source, setSource] = useState<MemorySource>("chatgpt");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const from = MEMORY_SOURCES.find((s) => s.id === source)!;
  const name = source === "other" ? t("memory.import.otherAssistant") : from.label;

  const start = useMutation({
    mutationFn: () => settingsApi.memory.import(source, text.trim()),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      router.dismissAll();
      router.push({ pathname: "/chat/[id]", params: { id: result.conversation.id } });
    },
    onError: (err) => Alert.alert(t("memory.import.failed"), failure(err)),
  });
  const ready = !!text.trim() && !start.isPending;

  const copy = async () => {
    tap();
    await Clipboard.setStringAsync(MEMORY_EXPORT_PROMPT);
    setCopied(true);
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <Row>
        <Pressable accessibilityRole="button" hitSlop={10} disabled={start.isPending} onPress={() => router.back()} style={styles.headSide}>
          <T variant="callout" muted>
            {t("common:actions.cancel")}
          </T>
        </Pressable>
        <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
          {t("memory.import.title")}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready, busy: start.isPending }}
          hitSlop={10}
          disabled={!ready}
          onPress={() => {
            tap();
            start.mutate();
          }}
          style={[styles.headSide, { alignItems: "flex-end" }]}
        >
          {start.isPending ? (
            <ActivityIndicator size="small" color={c.textMuted} />
          ) : (
            <T variant="callout" color={ready ? c.brandStrong : c.textFaint} style={{ fontWeight: "600" }}>
              {t("memory.import.import")}
            </T>
          )}
        </Pressable>
      </Row>

      <Group>
        <SegmentRow<MemorySource>
          title={t("memory.import.from")}
          options={MEMORY_SOURCES.map((s) => ({ value: s.id, label: s.id === "other" ? t("memory.import.other") : s.label }))}
          value={source}
          onChange={(next) => setSource(next)}
        />
      </Group>

      <View style={{ gap: space.md }}>
        <Step n={1} text={t("memory.import.step1", { name })} />
        <Row style={{ gap: space.sm }}>
          <Button title={copied ? t("memory.import.copied") : t("memory.import.copy")} icon={copied ? "check" : "copy"} variant="outline" onPress={() => void copy()} style={{ flex: 1 }} />
          {from.url ? <Button title={t("memory.import.open", { name })} icon="external" variant="outline" onPress={() => void Linking.openURL(from.url)} style={{ flex: 1 }} /> : null}
        </Row>
      </View>

      <View style={{ gap: space.md }}>
        <Step n={2} text={t("memory.import.step2")} />
        <TextInput
          accessibilityLabel={t("memory.import.answer")}
          value={text}
          onChangeText={setText}
          placeholder={t("memory.import.placeholder")}
          placeholderTextColor={c.textFaint}
          maxLength={IMPORT_MAX_CHARS}
          multiline
          style={[styles.answer, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
        />
      </View>
    </ScrollView>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  const c = useColors();
  return (
    <Row style={{ gap: space.md, alignItems: "flex-start" }}>
      <View style={[styles.badge, { backgroundColor: c.sunken }]}>
        <T variant="caption" style={{ fontWeight: "600" }}>
          {n}
        </T>
      </View>
      <T variant="subhead" style={{ flex: 1 }}>
        {text}
      </T>
    </Row>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 20,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.xl,
  },
  headSide: {
    minWidth: 76,
    height: 32,
    justifyContent: "center",
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  answer: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 160,
    maxHeight: 320,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: "top",
  },
});
