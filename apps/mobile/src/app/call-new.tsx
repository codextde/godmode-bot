import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { toE164 } from "@godmode/shared";
import { CALL_LANGUAGES, openCall } from "@/components/call-parts";
import { Group, PickerRow } from "@/components/form";
import { EmptyState, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { languageName } from "@/lib/languages";
import { queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { fonts, space, useColors } from "@/lib/theme";

const failure = (err: unknown) => (err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));

/** Godmode's voice calls someone for the human, like the desktop's New call: who, what for and in which language. */
export default function NewCall() {
  const c = useColors();
  const { t } = useTranslation(["calls", "common"]);
  const settings = useSettings();
  const phone = settings.data?.phone;
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const to = toE164(number);
  const language = picked ?? phone?.language ?? "en";
  const place = useMutation({
    mutationFn: () => api.calls.place({ to: to!, goal: goal.trim(), context: context.trim() || undefined, contactName: name.trim() || undefined, language }),
    onSuccess: (call) => {
      void queryClient.invalidateQueries({ queryKey: ["calls"] });
      router.dismiss();
      openCall(call.id);
    },
    onError: (err) => Alert.alert(t("new.failed"), failure(err)),
  });

  const on = !!phone?.enabled;
  const ready = on && !!to && !!goal.trim() && !place.isPending;
  const badNumber = (touched || number.length > 6) && !!number.trim() && !to;
  const languages = [...(CALL_LANGUAGES.includes(language as never) ? [] : [language]), ...CALL_LANGUAGES].map((code) => ({ value: code, label: languageName(code) }));

  const confirm = () => {
    setTouched(true);
    if (!ready) return;
    tap();
    const who = name.trim() || to!;
    Alert.alert(t("new.confirmTitle", { name: who }), t("new.confirmBody", { name: who }), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("new.callNow"), onPress: () => place.mutate() },
    ]);
  };

  const header = (
    <Row>
      <Pressable accessibilityRole="button" hitSlop={10} disabled={place.isPending} onPress={() => router.back()} style={styles.headSide}>
        <T variant="callout" muted>
          {t("common:actions.cancel")}
        </T>
      </Pressable>
      <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
        {t("new.title")}
      </T>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready, busy: place.isPending }}
        hitSlop={10}
        disabled={!on || place.isPending}
        onPress={confirm}
        style={[styles.headSide, { alignItems: "flex-end" }]}
      >
        {place.isPending ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : on ? (
          <T variant="callout" color={ready ? c.brandStrong : c.textFaint} style={{ fontWeight: "600" }}>
            {t("new.call")}
          </T>
        ) : null}
      </Pressable>
    </Row>
  );

  if (!settings.data) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {header}
        {settings.isError ? <ErrorState title={t("new.loadFailed")} error={failure(settings.error)} onRetry={() => void settings.refetch()} /> : <LoadingState />}
      </View>
    );
  }

  if (!on) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {header}
        <EmptyState icon="call" title={t("new.offTitle")} body={t("new.offBody")} style={{ marginTop: space.xxl }} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <View style={{ gap: space.sm }}>
        {header}
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {t("new.intro")}
        </T>
      </View>

      <Group footer={<T variant="footnote" color={badNumber ? c.danger : c.textMuted}>{badNumber ? t("new.badNumber") : t("new.numberHint")}</T>}>
        <Line label={t("new.number")}>
          <TextInput
            accessibilityLabel={t("new.number")}
            value={number}
            onChangeText={setNumber}
            onBlur={() => number.trim() && setTouched(true)}
            placeholder="+49 40 1234567"
            placeholderTextColor={c.textFaint}
            keyboardType="phone-pad"
            autoFocus
            maxLength={40}
            style={[styles.input, { color: badNumber ? c.danger : c.text, fontFamily: fonts.mono }]}
          />
        </Line>
        <Line label={t("new.who")}>
          <TextInput
            accessibilityLabel={t("new.who")}
            value={name}
            onChangeText={setName}
            placeholder={t("new.whoPlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={120}
            style={[styles.input, { color: c.text }]}
          />
        </Line>
      </Group>

      <Group>
        <Stacked label={t("new.goal")}>
          <TextInput
            accessibilityLabel={t("new.goal")}
            value={goal}
            onChangeText={setGoal}
            placeholder={t("new.goalPlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={2000}
            multiline
            style={[styles.area, { color: c.text }]}
          />
        </Stacked>
        <Stacked label={t("new.context")}>
          <TextInput
            accessibilityLabel={t("new.context")}
            value={context}
            onChangeText={setContext}
            placeholder={t("new.contextPlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={8000}
            multiline
            style={[styles.area, { color: c.text, minHeight: 64 }]}
          />
        </Stacked>
      </Group>

      <Group>
        <PickerRow icon="globe" title={t("new.language")} value={language} options={languages} onChange={setPicked} />
      </Group>
    </ScrollView>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.line}>
      <T variant="callout" style={styles.lineLabel}>
        {label}
      </T>
      {children}
    </View>
  );
}

function Stacked({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.stacked}>
      <T variant="footnote" muted>
        {label}
      </T>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    paddingTop: 20,
    paddingHorizontal: space.xl,
  },
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
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
  },
  lineLabel: {
    width: 76,
    fontWeight: "500",
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    paddingVertical: 12,
  },
  stacked: {
    gap: 2,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    paddingBottom: 6,
  },
  area: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 20,
    minHeight: 84,
    maxHeight: 200,
    paddingTop: 4,
    paddingBottom: 6,
    textAlignVertical: "top",
  },
});
