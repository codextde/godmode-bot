import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, Share, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isRefused } from "./admin";
import { Button, Card, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** An action the computer refused or that failed: the lock sentence when this phone has no full access (any more). */
export function actionFailed(title: string, err: unknown) {
  if (isRefused(err)) {
    void queryClient.invalidateQueries({ queryKey: qk.me });
    Alert.alert(translate("linking:refused"));
    return;
  }
  Alert.alert(title, errorText(err));
}

/** Text to hand to another app or computer (an invite, a key, a command): selectable, with Copy and Share. */
export function CodeBlock({ title, text, dimmed }: { title?: string; text: string; dimmed?: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["linking", "common"]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await Clipboard.setStringAsync(text);
    tap(Haptics.ImpactFeedbackStyle.Medium);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <View style={{ gap: space.sm }}>
      {title ? (
        <T variant="footnote" muted style={{ paddingHorizontal: 4, fontWeight: "500" }}>
          {title}
        </T>
      ) : null}
      <Card style={[styles.block, dimmed && { opacity: 0.4 }]}>
        <View style={[styles.code, { backgroundColor: c.sunken }]}>
          <T variant="mono" selectable numberOfLines={8} style={{ lineHeight: 18 }}>
            {text}
          </T>
        </View>
        <View style={styles.actions}>
          <Button title={copied ? t("common:actions.copied") : t("common:actions.copy")} icon={copied ? "check" : "copy"} variant="secondary" disabled={dimmed} onPress={() => void copy()} style={{ flex: 1 }} />
          <Button title={t("share")} icon="share" variant="secondary" disabled={dimmed} onPress={() => void Share.share({ message: text }).catch(() => undefined)} style={{ flex: 1 }} />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    padding: space.md,
    gap: space.md,
  },
  code: {
    borderRadius: radius.md,
    borderCurve: "continuous",
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  actions: {
    flexDirection: "row",
    gap: space.sm,
  },
});
