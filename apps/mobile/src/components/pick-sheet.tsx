import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Tile } from "./form";
import { Icon, type IconName } from "./icon";
import { Row, T, tap } from "./ui";
import { space, useColors } from "@/lib/theme";

/** A sheet that picks something and applies it right away: its title, and Done to close it. */
export function PickSheet({ title, children }: { title: string; children: ReactNode }) {
  const c = useColors();
  const { t } = useTranslation("common");
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <Row style={styles.head}>
        <View style={styles.side} />
        <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
          {title}
        </T>
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => {
            tap();
            router.back();
          }}
          style={[styles.side, { alignItems: "flex-end" }]}
        >
          <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
            {t("actions.done")}
          </T>
        </Pressable>
      </Row>
      {children}
    </ScrollView>
  );
}

/** One choice: a check on the picked one (or each picked one, for `multi`). */
export function PickRow({
  icon,
  emoji,
  lead,
  title,
  detail,
  selected,
  multi = false,
  disabled = false,
  onPress,
}: {
  icon?: IconName;
  emoji?: string;
  lead?: ReactNode;
  title: string;
  detail?: string;
  selected: boolean;
  multi?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }, disabled && { opacity: 0.45 }]}
    >
      {lead ?? (icon || emoji ? <Tile icon={icon} emoji={emoji} tint={selected ? c.brandStrong : undefined} /> : null)}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {title}
        </T>
        {detail ? (
          <T variant="footnote" muted numberOfLines={2}>
            {detail}
          </T>
        ) : null}
      </View>
      {multi ? (
        <Icon name={selected ? "checkFill" : "circle"} size={21} color={selected ? c.brandStrong : c.textFaint} />
      ) : selected ? (
        <Icon name="check" size={15} color={c.brandStrong} weight="bold" />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 48,
    gap: space.xl,
  },
  head: {
    paddingTop: space.xs,
  },
  side: {
    width: 64,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    minHeight: 52,
  },
});
