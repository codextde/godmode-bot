import { useQuery } from "@tanstack/react-query";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { DynamicColorIOS, Platform } from "react-native";
import { LiveAccessory } from "@/components/live-accessory";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { useColors } from "@/lib/theme";

const tint = Platform.OS === "ios" ? DynamicColorIOS({ light: "#1C1C1C", dark: "#F4F2ED" }) : undefined;

export default function TabsLayout() {
  const c = useColors();
  const working = useLive((s) => Object.keys(s.runs).length > 0);
  const offline = useLive((s) => s.status === "offline");
  const { data: boot } = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const needsYou = boot?.counts.openMissingLogins ?? 0;

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
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        {needsYou > 0 && <NativeTabs.Trigger.Badge>{String(needsYou)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="screens">
        <NativeTabs.Trigger.Label>Screens</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="macwindow.on.rectangle" md="desktop_windows" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "person.2", selected: "person.2.fill" }} md="group" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
