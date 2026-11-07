import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { DEVICE_INVITE_PREFIX, RUNNER_CODE_PREFIX, parseDeviceInvite } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { Group } from "@/components/form";
import { actionFailed } from "@/components/linking-parts";
import { Button, Card, T, tap } from "@/components/ui";
import { useNow } from "@/lib/hooks";
import { linkingApi } from "@/lib/linking";
import { queryClient } from "@/lib/query";
import { sq } from "@/lib/settings-api";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** Settings → Devices → Join with an invite: this computer joins the group of the Mac that made the invite. */
export default function DevicesJoin() {
  const { t } = useTranslation("linking");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("devices.join") }} />
      <FullAccessGate>
        <Join />
      </FullAccessGate>
    </ScrollView>
  );
}

function Join() {
  const c = useColors();
  const { t } = useTranslation("linking");
  const [code, setCode] = useState("");
  const now = useNow(1000);
  const join = useMutation({
    mutationFn: (text: string) => linkingApi.devices.join(text),
    onSuccess: (next) => {
      tap(Haptics.ImpactFeedbackStyle.Medium);
      queryClient.setQueryData(sq.devices, next);
      // The setup here was replaced by the primary's: everything the app shows changed.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "devices" });
      Alert.alert(next.primaryName ? t("join.doneNamed", { name: next.primaryName }) : t("join.done"));
      router.back();
    },
    onError: (err) => actionFailed(t("join.failed"), err),
  });

  const text = code.trim();
  const parsed = text ? parseDeviceInvite(text) : null;
  const expired = !!parsed && parsed.exp * 1000 < now;
  const problem = !text
    ? null
    : !parsed
      ? text.startsWith(RUNNER_CODE_PREFIX)
        ? t("join.runnerCode", { prefix: DEVICE_INVITE_PREFIX })
        : t("join.notInvite", { prefix: DEVICE_INVITE_PREFIX })
      : expired
        ? t("join.expired")
        : null;
  const ready = !!parsed && !expired;

  const paste = async () => {
    const value = await Clipboard.getStringAsync();
    if (value) setCode(value.trim());
  };

  return (
    <>
      <View>
        <Card style={styles.card}>
          <TextInput
            accessibilityLabel={t("join.label")}
            value={code}
            onChangeText={setCode}
            editable={!join.isPending}
            placeholder={`${DEVICE_INVITE_PREFIX}…`}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            multiline
            scrollEnabled={false}
            style={[styles.input, { color: c.text }]}
          />
        </Card>
        {problem ? (
          <T variant="footnote" color={c.danger} style={styles.note}>
            {problem}
          </T>
        ) : null}
      </View>
      {!text ? <Button title={t("join.paste")} icon="copy" variant="secondary" onPress={() => void paste()} /> : null}
      <Group footer={t("join.takesSetupBody")}>
        <T variant="callout" style={styles.warning}>
          {parsed ? t("join.takesSetup", { name: parsed.name }) : t("join.takesSetupPrimary")}
        </T>
      </Group>
      <Button
        title={join.isPending ? t("join.joining") : parsed ? t("join.joinNamed", { name: parsed.name }) : t("join.join")}
        icon="link"
        loading={join.isPending}
        disabled={!ready}
        onPress={() => join.mutate(text)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.lg,
  },
  card: {
    borderRadius: radius.lg,
  },
  input: {
    minHeight: 110,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    textAlignVertical: "top",
  },
  note: {
    marginTop: space.sm,
    paddingHorizontal: 4,
  },
  warning: {
    fontWeight: "500",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
});
