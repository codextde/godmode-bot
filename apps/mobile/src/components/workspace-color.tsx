import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { AGENT_COLORS, CHARACTER_PALETTE } from "@godmode/shared";
import { SectionTitle, tap } from "./ui";
import { alpha, space, useColors } from "@/lib/theme";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The solid color of a workspace's token ("violet") or its hex color. */
export function workspaceHex(color: string | null | undefined): string {
  if (color && HEX.test(color)) return color.length === 4 ? `#${[...color.slice(1)].map((x) => x + x).join("")}` : color;
  return (CHARACTER_PALETTE[color ?? ""] ?? CHARACTER_PALETTE.violet)!.fill;
}

/** The soft tile behind a workspace's emoji, in its color, like the desktop's WorkspaceTile. */
export function workspaceTint(color: string | null | undefined): string {
  return alpha(workspaceHex(color), 0.22);
}

/** Pick the workspace's color: the agents' palette, a check on the current one. */
export function WorkspaceColors({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  return (
    <View>
      <SectionTitle title={t("workspaceColor.title")} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={{ marginHorizontal: -space.lg }}>
        {AGENT_COLORS.map((color) => {
          const on = color === value;
          return (
            <Pressable
              key={color}
              accessibilityRole="radio"
              accessibilityLabel={t(`workspaceColor.names.${color}`)}
              accessibilityState={{ checked: on }}
              hitSlop={4}
              onPress={() => {
                if (on) return;
                tap();
                onChange(color);
              }}
              style={[styles.ring, { borderColor: on ? c.text : "transparent" }]}
            >
              <View style={[styles.swatch, { backgroundColor: workspaceHex(color) }]} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 8,
    paddingHorizontal: space.lg,
    paddingVertical: 2,
  },
  ring: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
});
