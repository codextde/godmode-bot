import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { parsePairingLink } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, T } from "@/components/ui";
import { api, errorText, pairWith } from "@/lib/api";
import { hostOf } from "@/lib/format";
import { queryClient } from "@/lib/query";
import { isGatewayUrl, useSession } from "@/lib/session";
import { radius, space, useColors } from "@/lib/theme";

export default function Pair() {
  const { t } = useTranslation(["onboarding", "common"]);
  const { d } = useLocalSearchParams<{ d?: string }>();
  const payload = useMemo(() => (d ? parsePairingLink(d) : null), [d]);
  const current = useSession((s) => s.connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = useColors();

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const connect = async () => {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      const connection = await pairWith(payload);
      if (current) await api.unpair().catch(() => undefined);
      queryClient.clear();
      await useSession.getState().connect(connection);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/");
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!payload) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Icon name="warning" size={28} color={c.warning} />
        <T variant="title">{t("pair.invalid.title")}</T>
        <T variant="subhead" muted style={{ textAlign: "center" }}>
          {t("pair.invalid.body")}
        </T>
        <Button title={t("pair.invalid.scanAgain")} icon="scan" onPress={() => router.replace("/scan")} style={{ alignSelf: "stretch" }} />
      </View>
    );
  }

  const expired = payload.exp * 1000 < Date.now();
  const switching = current && current.instance.id !== payload.id;
  const routes = [
    { label: "Tailscale", url: payload.urls.find((u) => !isGatewayUrl(u) && u.startsWith("http:")) },
    { label: t("pair.server"), url: payload.urls.find((u) => !isGatewayUrl(u) && u.startsWith("https:")) },
    { label: "Godmode Cloud", url: payload.urls.find(isGatewayUrl) },
  ].filter((route) => route.url);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Logo size={56} />
      <View style={{ alignItems: "center", gap: 6 }}>
        <T variant="title" style={{ textAlign: "center" }}>
          {t("pair.title", { name: payload.name })}
        </T>
        <T variant="subhead" muted style={{ textAlign: "center" }}>
          {t("pair.body")}
        </T>
      </View>

      <Card style={styles.details}>
        {routes.map((route) => (
          <View key={route.label} style={styles.detailRow}>
            <Icon name="network" size={16} color={c.textMuted} />
            <T variant="subhead" muted>
              {route.label}
            </T>
            <T variant="subhead" numberOfLines={1} style={{ flex: 1, textAlign: "right", fontWeight: "500" }}>
              {hostOf(route.url)}
            </T>
          </View>
        ))}
        {switching && (
          <View style={styles.detailRow}>
            <Icon name="warning" size={16} color={c.warning} />
            <T variant="footnote" style={{ flex: 1 }}>
              {t("pair.replaces", { name: current.instance.name })}
            </T>
          </View>
        )}
      </Card>

      {error || expired ? (
        <View style={[styles.error, { backgroundColor: c.dangerSoft }]}>
          <T variant="footnote" color={c.danger}>
            {expired && !error ? t("pair.expired") : error}
          </T>
        </View>
      ) : null}

      <View style={{ alignSelf: "stretch", gap: space.sm, marginTop: "auto" }}>
        {expired ? (
          <Button title={t("pair.scanNew")} icon="scan" size="lg" onPress={() => router.replace("/scan")} />
        ) : (
          <Button title={busy ? t("pair.connecting") : t("pair.connect")} icon="link" size="lg" loading={busy} onPress={() => void connect()} />
        )}
        <Button title={t("common:actions.cancel")} variant="secondary" onPress={close} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    gap: space.lg,
    padding: space.xxl,
    paddingTop: 36,
  },
  details: {
    alignSelf: "stretch",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
    borderRadius: radius.md,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  error: {
    alignSelf: "stretch",
    padding: space.md,
    borderRadius: radius.sm,
  },
});
