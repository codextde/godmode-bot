import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useFullAccess } from "./full-access";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { usePlugins } from "@/lib/integrations";
import { radius, useColors } from "@/lib/theme";

/** Who wrote a plugin's note, leading to the plugin when this phone can open it. */
export function ModChip({ name }: { name: string }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  const { fullAccess } = useFullAccess();
  const mod = usePlugins().data?.find((m) => m.name === name);
  const title = mod?.title || name;
  const box = [styles.chip, { backgroundColor: c.surface, borderColor: c.border }];
  const label = (
    <>
      <Icon name="puzzle" size={11} color={c.textMuted} />
      <T variant="caption" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
        {title}
      </T>
    </>
  );
  if (!mod || !fullAccess) return <View style={box}>{label}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("thread.pluginNote", { name: title })}
      hitSlop={8}
      onPress={() => {
        tap();
        router.push({ pathname: "/settings/plugin", params: { id: mod.id } });
      }}
      style={({ pressed }) => [box, pressed && { opacity: 0.6 }]}
    >
      {label}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: "45%",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
