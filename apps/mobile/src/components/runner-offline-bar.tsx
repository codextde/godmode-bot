import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { errorText } from "@/lib/api";
import type { Place } from "@/lib/chat-extras";
import { linkingApi } from "@/lib/linking";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** Above the composer of a chat whose computer can't be reached: try it now, or move the chat here, like the desktop. */
export function RunnerOfflineBar({ conversationId, place, here }: { conversationId: string; place: Place; here: Place | null }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const connect = useMutation({
    mutationFn: () => linkingApi.runners.connect(place.runnerId!),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["devices", "group"] }),
    onError: (err) => Alert.alert(t("runnerAway.unreachable", { name: place.name }), errorText(err)),
  });
  const connecting = place.state === "connecting" || connect.isPending;
  const update = place.state === "update_required";
  const action = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => (pressed || disabled) && { opacity: 0.5 }}
    >
      <T variant="footnote" color={c.primary} numberOfLines={1} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
  return (
    <View accessibilityRole="alert" style={[styles.bar, { backgroundColor: c.surface, borderColor: c.border }]}>
      {connecting ? <ActivityIndicator size="small" /> : <Icon name={update ? "warning" : "wifi"} size={15} color={update ? c.warning : c.textMuted} />}
      <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={2}>
        {t(connecting ? "runnerAway.connecting" : update ? "runnerAway.update" : "runnerAway.offline", { name: place.name })}
      </T>
      {update
        ? action(t("runnerAway.devices"), () => router.push("/settings/devices"))
        : action(t("common:actions.tryAgain"), () => connect.mutate(), connecting)}
      {here ? action(t("runnerAway.moveHere"), () => router.push({ pathname: "/chat-move", params: { conversationId, to: here.runnerId ?? "" } })) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
