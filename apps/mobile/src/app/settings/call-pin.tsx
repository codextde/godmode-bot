import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View, type TextInputInstance } from "react-native";
import { useTranslation } from "react-i18next";
import { isWeakOwnerPin, OWNER_PIN_LENGTH } from "@godmode/shared";
import { confirmWithBiometrics, FullAccessGate } from "@/components/admin";
import { T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { callsAdmin, ck } from "@/lib/calls-admin";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** Settings → Calls → the owner's PIN: typed twice, never shown, sent once (full access only). */
export default function CallPin() {
  const { t } = useTranslation("admin");
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("callSetup.pinTitle"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        <PinEntry />
      </FullAccessGate>
    </View>
  );
}

function PinEntry() {
  const c = useColors();
  const { t } = useTranslation("admin");
  const input = useRef<TextInputInstance>(null);
  const [first, setFirst] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (message: string) => {
    setError(message);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  };

  const enter = async (raw: string) => {
    const next = raw.replace(/\D/g, "").slice(0, OWNER_PIN_LENGTH);
    setValue(next);
    if (next) setError(null);
    if (next.length < OWNER_PIN_LENGTH) return;
    setValue("");
    if (!first) {
      if (isWeakOwnerPin(next)) return fail(t("callSetup.pinWeak"));
      return setFirst(next);
    }
    if (next !== first) {
      setFirst("");
      return fail(t("callSetup.pinMismatch"));
    }
    // Face ID here, on the screen that sends it: a link straight to this screen gets no way around it.
    if (!(await confirmWithBiometrics(t("callSetup.pinSet")))) return setFirst("");
    setSaving(true);
    try {
      queryClient.setQueryData(ck.pin, await callsAdmin.setPin(next));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      router.back();
    } catch (err) {
      setFirst("");
      fail(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Pressable accessible={false} onPress={() => input.current?.focus()} style={styles.body}>
      <T variant="headline" style={{ textAlign: "center" }}>
        {first ? t("callSetup.pinRepeat") : t("callSetup.pinChoose")}
      </T>
      <View style={styles.boxes}>
        {Array.from({ length: OWNER_PIN_LENGTH }, (_, i) => (
          <View
            key={i}
            style={[
              styles.box,
              { backgroundColor: c.surface, borderColor: error ? c.danger : i === value.length ? c.brand : c.border },
            ]}
          >
            {i < value.length ? <View style={[styles.dot, { backgroundColor: c.text }]} /> : null}
          </View>
        ))}
      </View>
      {saving ? (
        <ActivityIndicator color={c.textMuted} />
      ) : error ? (
        <T variant="footnote" color={c.danger} style={{ textAlign: "center" }}>
          {error}
        </T>
      ) : null}
      <TextInput
        ref={input}
        accessibilityLabel={first ? t("callSetup.pinRepeat") : t("callSetup.pinChoose")}
        value={value}
        onChangeText={(v) => void enter(v)}
        editable={!saving}
        autoFocus
        keyboardType="number-pad"
        secureTextEntry
        textContentType="none"
        maxLength={OWNER_PIN_LENGTH}
        caretHidden
        style={styles.hidden}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  body: {
    flex: 1,
    alignItems: "center",
    paddingTop: 140,
    paddingHorizontal: space.lg,
    gap: space.xl,
  },
  boxes: {
    flexDirection: "row",
    gap: space.sm,
  },
  box: {
    width: 44,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
});
