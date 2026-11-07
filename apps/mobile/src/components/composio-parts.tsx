import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Badge, T } from "./ui";
import { connectionTone } from "@/lib/composio-admin";
import { useColors } from "@/lib/theme";

/** Logos are mostly dark marks drawn for white, like the desktop's tile; in dark mode too. */
const LOGO_TILE = "#FFFFFF";

/** An app's logo on a white tile, its initial when there is none. */
export function ToolkitLogo({ uri, name, size = 30 }: { uri?: string | null; name: string; size?: number }) {
  const c = useColors();
  const [failed, setFailed] = useState(false);
  const show = !!uri && !failed;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: show ? LOGO_TILE : c.sunken, borderColor: c.border }]}
    >
      {show ? (
        <Image source={{ uri: uri! }} style={{ width: size * 0.64, height: size * 0.64 }} contentFit="contain" onError={() => setFailed(true)} />
      ) : (
        <T variant="footnote" style={{ fontWeight: "600" }}>
          {name.trim().charAt(0).toUpperCase() || "?"}
        </T>
      )}
    </View>
  );
}

/** Active, waiting for the sign-in, or what Composio reports. */
export function ConnectionBadge({ status }: { status: string }) {
  const { t } = useTranslation("integrations");
  const tone = connectionTone(status);
  const label =
    tone === "ok"
      ? t("composioAdmin.status.active")
      : tone === "pending"
        ? t("composioAdmin.status.pending")
        : status.toUpperCase() === "DELETED"
          ? t("composioAdmin.status.deleted")
          : status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  return <Badge label={label} tone={tone === "ok" ? "success" : tone === "pending" ? "warning" : tone === "error" ? "danger" : "neutral"} live={tone === "pending"} />;
}

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
