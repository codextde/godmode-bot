import { useQuery } from "@tanstack/react-query";
import { isHumanTaskWaiting } from "@godmode/shared";
import { NativeTabs } from "expo-router/native-tabs";
import { useTranslation } from "react-i18next";
import { DynamicColorIOS, Platform } from "react-native";
import { LiveAccessory } from "@/components/live-accessory";
import { api } from "@/lib/api";
import { useOpenHumanTasks } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { useColors } from "@/lib/theme";

const tint = Platform.OS === "ios" ? DynamicColorIOS({ light: "#1C1C1C", dark: "#F4F2ED" }) : undefined;

export default function TabsLayout() {
  const c = useColors();
  const { t } = useTranslation("tabs");
  const working = useLive((s) => Object.keys(s.runs).length > 0);
  const running = useLive((s) => Object.values(s.runs).filter(({ run }) => run.status === "running").length);
  const offline = useLive((s) => s.status === "offline");
  const { data: boot } = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  // The desktop's sidebar counts: what waits for the human (a parked backlog task doesn't), tickets to review or unblock.
  const forYou = useOpenHumanTasks().data?.filter(isHumanTaskWaiting).length ?? 0;
  const attention = boot?.counts.attention;
  const needsYou = attention
    ? attention.question + attention.todo + attention.login + attention.review + attention.blocked
    : (boot?.counts.openMissingLogins ?? 0) + (boot?.counts.openQuestions ?? 0) + forYou;
  const tasks = (attention?.review ?? 0) + (attention?.blocked ?? 0);

  return (
    <NativeTabs
      tintColor={tint ?? c.text}
      minimizeBehavior="onScrollDown"
      backgroundColor={Platform.OS === "android" ? c.surface : undefined}
      indicatorColor={Platform.OS === "android" ? c.sunken : undefined}
      labelStyle={Platform.OS === "android" ? { selected: { color: c.text } } : undefined}
    >
      {(working || offline) && (
        <NativeTabs.BottomAccessory>
          <LiveAccessory />
        </NativeTabs.BottomAccessory>
      )}
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Label>{t("tabBar.home")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        {needsYou > 0 && <NativeTabs.Trigger.Badge>{String(needsYou)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Label>{t("tabBar.chats")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Label>{t("tabBar.tasks")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "rectangle.split.3x1", selected: "rectangle.split.3x1.fill" }} md="view_kanban" />
        {tasks > 0 && <NativeTabs.Trigger.Badge>{String(tasks)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="screens">
        <NativeTabs.Trigger.Label>{t("tabBar.screens")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="macwindow.on.rectangle" md="desktop_windows" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Label>{t("tabBar.agents")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "face.smiling.inverse", selected: "face.smiling" }} md="smart_toy" />
        {running > 0 && <NativeTabs.Trigger.Badge>{String(running)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
