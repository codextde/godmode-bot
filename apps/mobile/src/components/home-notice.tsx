import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "./icon";
import { Card, Row, T, tap } from "./ui";
import { space, useColors } from "@/lib/theme";

/** A notice at the top of Home: what happened and the one thing to do about it. */
export function HomeNotice({
  icon,
  lead,
  tone,
  title,
  body,
  actions,
  dismissLabel,
  onDismiss,
  children,
}: {
  icon?: IconName;
  /** In place of the icon. */
  lead?: ReactNode;
  tone: "info" | "warning" | "danger";
  title: string;
  body?: string | null;
  actions?: ReactNode;
  dismissLabel?: string;
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  const c = useColors();
  const fg = tone === "danger" ? c.danger : tone === "warning" ? c.warning : c.brandStrong;
  const bg = tone === "danger" ? c.dangerSoft : tone === "warning" ? c.warningSoft : undefined;
  return (
    <Card style={[styles.card, bg ? { backgroundColor: bg, borderColor: "transparent" } : null]}>
      <Row style={styles.head}>
        {lead ?? (icon ? <Icon name={icon} size={18} color={fg} /> : null)}
        <View accessibilityRole="alert" style={{ flex: 1, gap: 2 }}>
          <T variant="subhead" style={{ fontWeight: "600" }}>
            {title}
          </T>
          {body ? (
            <T variant="footnote" muted>
              {body}
            </T>
          ) : null}
        </View>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dismissLabel}
            hitSlop={10}
            onPress={() => {
              tap();
              onDismiss();
            }}
          >
            <Icon name="close" size={13} color={c.textMuted} />
          </Pressable>
        ) : null}
      </Row>
      {actions ? <Row style={styles.actions}>{actions}</Row> : null}
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
    gap: space.md,
  },
  head: {
    alignItems: "flex-start",
    gap: space.md,
  },
  actions: {
    gap: space.sm,
    flexWrap: "wrap",
    paddingLeft: 18 + space.md,
  },
});
