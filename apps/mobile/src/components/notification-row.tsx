import { router } from "expo-router";
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AppNotification, NotificationKind } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { T } from "./ui";
import { RowPressable } from "./row-pressable";
import { shortTime } from "@/lib/format";
import { licenseText } from "@/lib/license-text";
import { notificationRoute } from "@/lib/notification-links";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors, type Colors } from "@/lib/theme";

const KIND: Record<NotificationKind, { icon: IconName; tone: (c: Colors) => { bg: string; fg: string } }> = {
  info: { icon: "bell", tone: (c) => ({ bg: c.sunken, fg: c.textMuted }) },
  success: { icon: "check", tone: (c) => ({ bg: c.successSoft, fg: c.success }) },
  warning: { icon: "warning", tone: (c) => ({ bg: c.warningSoft, fg: c.warning }) },
  error: { icon: "warning", tone: (c) => ({ bg: c.dangerSoft, fg: c.danger }) },
  missing_login: { icon: "key", tone: (c) => ({ bg: c.warningSoft, fg: c.warning }) },
  run: { icon: "sparkles", tone: (c) => ({ bg: c.sunken, fg: c.text }) },
  question: { icon: "warning", tone: (c) => ({ bg: c.warningSoft, fg: c.warning }) },
};

/** Opens what a notification's desktop link points at; false when the phone has no such screen. */
export function openNotificationLink(link: string | null): boolean {
  const route = notificationRoute(link, queryClient.getQueryData<{ fullAccess?: boolean }>(qk.me)?.fullAccess === true);
  if (!route) return false;
  router.push(route);
  return true;
}

export const NotificationRow = memo(function NotificationRow({ notification: n, onOpen }: { notification: AppNotification; onOpen: () => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const meta = KIND[n.kind] ?? KIND.info;
  const tone = meta.tone(c);
  const body = n.link === "/settings/license" ? licenseText(n.body) : n.body;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={n.read ? n.title : t("notificationRow.unread", { title: n.title })}
      onPress={onOpen}
      style={styles.row}
    >
      <View style={[styles.icon, { backgroundColor: tone.bg }]}>
        <Icon name={meta.icon} size={14} color={tone.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.titleRow}>
          <T variant="subhead" numberOfLines={1} muted={n.read} style={[{ flexShrink: 1 }, !n.read && { fontWeight: "600" }]}>
            {n.title}
          </T>
          {!n.read ? <View style={[styles.dot, { backgroundColor: c.brand }]} /> : null}
          <T variant="caption" color={c.textFaint} style={{ marginLeft: "auto" }}>
            {shortTime(n.createdAt)}
          </T>
        </View>
        {body ? (
          <T variant="footnote" muted numberOfLines={2}>
            {body}
          </T>
        ) : null}
      </View>
    </RowPressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
