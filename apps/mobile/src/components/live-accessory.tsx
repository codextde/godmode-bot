import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { LiveDot, T, tap } from "./ui";
import { api } from "@/lib/api";
import { activityText } from "@/lib/format";
import { useLinkComputer, useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { reconnectNow } from "@/lib/realtime";
import { useWorkspaceRuns } from "@/lib/workspace";
import { space, useColors } from "@/lib/theme";

/** Floats above the tab bar: what the agents are doing right now, or that the computer can't be reached. */
export function LiveAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const offline = useLive((s) => s.status === "offline");
  const computer = useLinkComputer().name ?? t("liveAccessory.yourComputer");
  const { data: agents } = useQuery({ queryKey: qk.agents, queryFn: api.agents.list });
  const list = useWorkspaceRuns();
  const first = list[0];
  const agent = first ? agents?.find((a) => a.id === first.run.agentId) : undefined;
  const inline = placement === "inline";

  if (offline) {
    return (
      <Pressable style={styles.row} onPress={() => reconnectNow()}>
        <Icon name="wifi" size={15} color={c.warning} />
        <T variant="footnote" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
          {inline ? t("liveAccessory.offline") : t("liveAccessory.reconnecting", { computer })}
        </T>
        {!inline && <Icon name="refresh" size={15} color={c.textMuted} />}
      </Pressable>
    );
  }
  if (!first) return null;

  const label = first.run.status === "queued" ? t("liveAccessory.waitingToStart") : activityText(first.activity);
  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        tap();
        router.push({ pathname: "/chat/[id]", params: { id: first.run.conversationId } });
      }}
    >
      {inline || !agent ? <LiveDot /> : <CharacterAvatar agent={agent} size={26} mood={first.run.status === "queued" ? "idle" : "working"} />}
      {inline ? (
        <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
          {list.length > 1 ? t("liveAccessory.workingCount", { count: list.length }) : (agent?.name ?? t("liveAccessory.working"))}
        </T>
      ) : (
        <>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
              {agent?.name ?? t("liveAccessory.working")}
              {list.length > 1 ? <T variant="footnote" muted>{`  +${list.length - 1}`}</T> : null}
            </T>
            <T variant="caption" muted numberOfLines={1}>
              {label}
            </T>
          </View>
          <Pressable
            hitSlop={10}
            accessibilityLabel={t("common:actions.stop")}
            onPress={() => {
              tap();
              void api.runs.cancel(first.run.id);
            }}
            style={[styles.stop, { backgroundColor: c.sunken }]}
          >
            <Icon name="stop" size={11} color={c.text} />
          </Pressable>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  stop: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
