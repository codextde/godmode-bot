import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Pressable, StyleSheet, View } from "react-native";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { LiveDot, T, tap } from "./ui";
import { api } from "@/lib/api";
import { activityText } from "@/lib/format";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { reconnectNow } from "@/lib/realtime";
import { useSession } from "@/lib/session";
import { useWorkspaceRuns } from "@/lib/workspace";
import { space, useColors } from "@/lib/theme";

/** Floats above the tab bar: what the agents are doing right now, or that the computer can't be reached. */
export function LiveAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const c = useColors();
  const offline = useLive((s) => s.status === "offline");
  const computer = useSession((s) => s.connection?.instance.name ?? "your computer");
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
          {inline ? "Offline" : `Reconnecting to ${computer}…`}
        </T>
        {!inline && <Icon name="refresh" size={15} color={c.textMuted} />}
      </Pressable>
    );
  }
  if (!first) return null;

  const label = first.run.status === "queued" ? "Waiting to start" : activityText(first.activity);
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
          {list.length > 1 ? `${list.length} working` : (agent?.name ?? "Working")}
        </T>
      ) : (
        <>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
              {agent?.name ?? "Working"}
              {list.length > 1 ? <T variant="footnote" muted>{`  +${list.length - 1}`}</T> : null}
            </T>
            <T variant="caption" muted numberOfLines={1}>
              {label}
            </T>
          </View>
          <Pressable
            hitSlop={10}
            accessibilityLabel="Stop"
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
