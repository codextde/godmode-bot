import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useRef, useState } from "react";
import { Linking, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parsePairingLink } from "@godmode/shared";
import { Glass } from "@/components/glass";
import { Button, GlassIconButton, SMOKE, T } from "@/components/ui";
import { radius, space } from "@/lib/theme";

const WHITE = "#FFFFFF";

export default function Scan() {
  const { t } = useTranslation(["onboarding", "common"]);
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const handled = useRef(false);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const box = Math.min(width, height) * 0.68;

  const open = (text: string) => {
    const payload = parsePairingLink(text);
    if (!payload) {
      setHint(t("scan.notGodmode"));
      return false;
    }
    handled.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace({ pathname: "/pair", params: { d: /[?&#]d=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? text.trim() } });
    return true;
  };

  const onScanned = (result: BarcodeScanningResult) => {
    if (handled.current) return;
    open(result.data);
  };

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text || !open(text)) setHint(t("scan.copyFirst"));
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {permission?.granted ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned} />
      ) : null}

      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        <View style={{ width: box, height: box }}>
          {(["tl", "tr", "bl", "br"] as const).map((corner) => (
            <View key={corner} style={[styles.corner, cornerStyle(corner)]} />
          ))}
        </View>
      </View>

      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <GlassIconButton icon="close" label={t("common:actions.close")} onPress={() => router.back()} dark />
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.xl }]}>
        {permission && !permission.granted ? (
          <Glass style={styles.panel} scheme="dark" fallback={SMOKE}>
            <T variant="headline" color={WHITE}>
              {t("scan.camera.title")}
            </T>
            <T variant="subhead" color="rgba(255,255,255,0.75)" style={{ textAlign: "center" }}>
              {permission.canAskAgain
                ? t("scan.camera.why")
                : t("scan.camera.off")}
            </T>
            <Button
              title={permission.canAskAgain ? t("common:actions.continue") : t("scan.camera.openSettings")}
              icon="camera"
              variant="glass" dark
              onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings())}
            />
          </Glass>
        ) : (
          <Animated.View entering={FadeIn.delay(200)}>
            <Glass style={styles.pill} scheme="dark" fallback={SMOKE}>
              <T variant="subhead" color={WHITE} style={{ fontWeight: "600", textAlign: "center" }}>
                {hint ?? t("scan.point")}
              </T>
              <T variant="footnote" color="rgba(255,255,255,0.7)" style={{ textAlign: "center" }}>
                {t("scan.path")}
              </T>
            </Glass>
          </Animated.View>
        )}
        <Button title={t("scan.paste")} variant="glass" dark onPress={() => void paste()} style={{ alignSelf: "center" }} />
      </View>
    </View>
  );
}

function cornerStyle(corner: "tl" | "tr" | "bl" | "br") {
  const edge = 4;
  return {
    top: corner[0] === "t" ? 0 : undefined,
    bottom: corner[0] === "b" ? 0 : undefined,
    left: corner[1] === "l" ? 0 : undefined,
    right: corner[1] === "r" ? 0 : undefined,
    borderTopWidth: corner[0] === "t" ? edge : 0,
    borderBottomWidth: corner[0] === "b" ? edge : 0,
    borderLeftWidth: corner[1] === "l" ? edge : 0,
    borderRightWidth: corner[1] === "r" ? edge : 0,
    borderTopLeftRadius: corner === "tl" ? 28 : 0,
    borderTopRightRadius: corner === "tr" ? 28 : 0,
    borderBottomLeftRadius: corner === "bl" ? 28 : 0,
    borderBottomRightRadius: corner === "br" ? 28 : 0,
  } as const;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center" },
  corner: { position: "absolute", width: 44, height: 44, borderColor: WHITE },
  top: { position: "absolute", top: 0, left: space.lg },
  bottom: { position: "absolute", bottom: 0, left: space.xl, right: space.xl, gap: space.lg },
  pill: { paddingVertical: space.md, paddingHorizontal: space.xl, borderRadius: radius.xl, gap: 2, alignSelf: "center" },
  panel: { padding: space.xl, borderRadius: radius.xl, gap: space.md, alignItems: "center" },
});
