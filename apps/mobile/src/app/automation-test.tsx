import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isRefused, NeedsFullAccess, useFullAccess } from "@/components/admin";
import { appName } from "@/components/routine-row";
import { SheetHeader } from "@/components/secret-parts";
import { ErrorState, LoadingState, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { automationAdmin, parsePayload } from "@/lib/automation-admin";
import { qk, queryClient } from "@/lib/query";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** Send a sample event to an app or webhook automation; it goes through the filter like a real one (desktop: test-event-dialog.tsx). */
export default function AutomationTest() {
  const c = useColors();
  const { t } = useTranslation(["automations", "common", "components"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fullAccess } = useFullAccess();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const routine = list.data?.find((r) => r.id === id);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const parsed = parsePayload(text);

  const send = async () => {
    if (!routine || sending || parsed.error) return;
    setSending(true);
    try {
      await automationAdmin.testEvent(routine.id, parsed.input);
      void queryClient.invalidateQueries({ queryKey: qk.routines });
      tap();
      router.back();
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("testEvent.sendFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setSending(false);
    }
  };

  const trigger = routine?.trigger;
  const description = trigger?.type === "app" ? t("testEvent.descriptionApp", { name: routine!.name, app: appName(trigger.toolkit) }) : routine ? t("testEvent.descriptionWebhook", { name: routine.name }) : "";
  const placeholder = trigger?.type === "app" ? '{\n  "from": "billing@acme.com",\n  "subject": "Invoice #1042"\n}' : '{\n  "event": "checkout.abandoned",\n  "items": 2,\n  "total": 128\n}';

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={t("testEvent.title")} action={t("testEvent.send")} onAction={() => void send()} ready={!!routine && !parsed.error && fullAccess === true} busy={sending} />
      {fullAccess === false ? (
        <NeedsFullAccess />
      ) : !routine ? (
        list.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState
            title={list.isError ? t("automation.loadFailed") : t("automation.notFound")}
            error={list.isError ? errorText(list.error) : t("automation.maybeDeleted")}
            onRetry={list.isError ? () => void list.refetch() : undefined}
          />
        )
      ) : (
        <View style={{ gap: space.sm }}>
          <T variant="subhead" muted>
            {description}
          </T>
          <TextInput
            accessibilityLabel={t("testEvent.dataLabel")}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={c.textFaint}
            multiline
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.payload, { color: c.text, backgroundColor: c.surface, borderColor: parsed.error ? c.danger : c.border }]}
          />
          <T variant="footnote" color={parsed.error ? c.danger : c.textMuted}>
            {parsed.error ?? t("testEvent.hint")}
          </T>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: space.xl,
    paddingHorizontal: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  payload: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 19,
    minHeight: 180,
    maxHeight: 360,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
