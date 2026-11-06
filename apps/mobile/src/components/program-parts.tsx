import * as Clipboard from "expo-clipboard";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { Button, Row, T, tap } from "./ui";
import { lastLines, type InstallResult } from "@/lib/programs";
import { errorText } from "@/lib/api";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** A small action at the end of a row (Install, Update, Fix); a spinner and its busy label while it runs. */
export function ActionPill({
  label,
  busyLabel,
  busy,
  disabled,
  tone = "brand",
  onPress,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  tone?: "brand" | "neutral" | "danger";
  onPress: () => void;
}) {
  const c = useColors();
  const bg = tone === "danger" ? c.dangerSoft : tone === "brand" ? c.brandSoft : c.sunken;
  const fg = tone === "danger" ? c.danger : tone === "brand" ? c.brandStrong : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      accessibilityLabel={busy ? (busyLabel ?? label) : label}
      disabled={disabled || busy}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <T variant="footnote" color={fg} style={{ fontWeight: "600" }}>
        {busy ? (busyLabel ?? label) : label}
      </T>
    </Pressable>
  );
}

/** A tool or permission with its state (none when `ok` is undefined), or what can be done about it from here. */
export function ToolRow({ title, detail, ok, action }: { title: string; detail?: string; ok?: boolean | null; action?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <View style={styles.label}>
        <T variant="callout" style={{ fontWeight: "500" }} numberOfLines={1}>
          {title}
        </T>
        {detail ? (
          <T variant="footnote" muted numberOfLines={3}>
            {detail}
          </T>
        ) : null}
      </View>
      {action ??
        (ok === undefined ? null : <Icon name={ok ? "check" : ok === null ? "minus" : "warning"} size={15} color={ok ? c.success : ok === null ? c.textFaint : c.warning} weight="bold" />)}
    </View>
  );
}

/** What an install did: a word when it worked, its last lines when it didn't. */
export function reportInstall(result: InstallResult | unknown, words: { done: string; failed: string }) {
  const r = result as Partial<InstallResult> | null;
  if (r && typeof r.ok === "boolean") {
    if (r.ok) return Alert.alert(words.done);
    return Alert.alert(words.failed, lastLines(r.output ?? "") || undefined);
  }
  Alert.alert(words.failed, errorText(result));
}

/**
 * Signing Claude in from the phone: the sign-in page opens in the phone's browser, it shows a code, the code goes back
 * to the computer here.
 */
export function SignInSteps({
  title,
  url,
  submitting,
  cancelling,
  onSubmit,
  onCancel,
}: {
  title: string;
  url: string | null;
  submitting: boolean;
  cancelling: boolean;
  onSubmit: (code: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation(["programs", "common"]);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const send = async () => {
    const value = code.trim();
    if (!value) return;
    if (await onSubmit(value)) setCode("");
  };
  const copy = async () => {
    if (!url) return;
    await Clipboard.setStringAsync(url);
    setCopied(true);
  };

  return (
    <View style={[styles.steps, { backgroundColor: c.surfaceAlt }]}>
      <Row style={{ gap: space.sm }}>
        <ActivityIndicator size="small" />
        <T variant="subhead" style={{ flex: 1, fontWeight: "600" }}>
          {title}
        </T>
        <ActionPill label={t("common:actions.cancel")} tone="neutral" busy={cancelling} onPress={onCancel} />
      </Row>
      {!url ? (
        <T variant="footnote" muted>
          {t("signIn.gettingLink")}
        </T>
      ) : (
        <>
          <T variant="footnote" muted>
            {t("signIn.steps")}
          </T>
          <Row style={{ gap: space.sm }}>
            <Button title={t("signIn.openPage")} icon="external" style={{ flex: 1 }} onPress={() => void Linking.openURL(url).catch(() => undefined)} />
            <Button title={copied ? t("common:actions.copied") : t("signIn.copyLink")} icon={copied ? "check" : "copy"} variant="outline" style={{ flex: 1 }} onPress={() => void copy()} />
          </Row>
          <View style={[styles.code, { backgroundColor: c.surface, borderColor: c.border }]}>
            <TextInput
              accessibilityLabel={t("signIn.codeLabel")}
              value={code}
              onChangeText={setCode}
              placeholder={t("signIn.codeLabel")}
              placeholderTextColor={c.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              onSubmitEditing={() => void send()}
              style={[styles.codeInput, { color: c.text }]}
            />
            <ActionPill label={t("signIn.send")} busy={submitting} disabled={!code.trim()} onPress={() => void send()} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
    minHeight: 52,
  },
  label: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  steps: {
    gap: space.md,
    padding: space.lg,
  },
  code: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: 6,
    height: 44,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeInput: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 14,
    paddingVertical: 0,
  },
});
