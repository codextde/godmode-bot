import { router } from "expo-router";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { AppNotification, NotificationKind } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { T } from "./ui";
import { shortTime } from "@/lib/format";
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

const param = (query: string, key: string) => new RegExp(`(?:^|&)${key}=([^&]+)`).exec(query)?.[1];

/**
 * Where a notification's desktop link leads on the phone ("/chat/…", "/tasks?task=…", "/calls?call=…"); false when the
 * phone has no such screen (settings, the vault, plugins stay on the computer).
 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function openNotificationLink(link: string | null): boolean {
  if (!link) return false;
  const [path = "", query = ""] = link.split("?");
  const [, section, id] = path.split("/");
  const task = param(query, "task");
  const call = param(query, "call");
  if (section === "chat" && id) router.push({ pathname: "/chat/[id]", params: { id: decode(id) } });
  else if (section === "agents" && id) router.push({ pathname: "/agent/[id]", params: { id: decode(id) } });
  else if (section === "tasks" && task) router.push({ pathname: "/task/[id]", params: { id: decode(task) } });
  else if (section === "my-tasks") router.push(task ? { pathname: "/human-task/[id]", params: { id: decode(task) } } : "/my-tasks");
  else if (section === "calls") router.push(call ? { pathname: "/call/[id]", params: { id: decode(call) } } : "/calls");
  else if (section === "automations") router.push("/automations");
  else return false;
  return true;
}

export const NotificationRow = memo(function NotificationRow({ notification: n, onOpen }: { notification: AppNotification; onOpen: () => void }) {
  const c = useColors();
  const meta = KIND[n.kind] ?? KIND.info;
  const tone = meta.tone(c);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${n.read ? "" : "Unread: "}${n.title}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
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
        {n.body ? (
          <T variant="footnote" muted numberOfLines={2}>
            {n.body}
          </T>
        ) : null}
      </View>
    </Pressable>
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
