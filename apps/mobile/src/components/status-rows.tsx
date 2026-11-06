import { formatDistanceToNowStrict } from "date-fns";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Tile } from "./form";
import { Icon, type IconName } from "./icon";
import { T, toneColors, type Tone } from "./ui";
import { dateLocale } from "@/lib/i18n";
import { space, useColors } from "@/lib/theme";

/** "5 minutes ago", "in 3 hours". */
export function ago(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() });
}

/** A label and its value, read-only: the status screens' row. `tone` puts a coloured dot before the value. */
export function InfoRow({ icon, label, detail, value, tone, mono }: { icon?: IconName; label: string; detail?: ReactNode; value?: string; tone?: Tone; mono?: boolean }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      {icon ? <Tile icon={icon} /> : null}
      <View style={styles.label}>
        <T variant="callout" style={{ fontWeight: "500" }} numberOfLines={1}>
          {label}
        </T>
        {detail ? (
          <T variant="footnote" muted numberOfLines={3}>
            {detail}
          </T>
        ) : null}
      </View>
      {value ? (
        <View style={styles.value}>
          {tone ? <View style={[styles.dot, { backgroundColor: toneColors(c, tone).dot }]} /> : null}
          <T variant={mono ? "mono" : "subhead"} muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {value}
          </T>
        </View>
      ) : null}
    </View>
  );
}

/** Something that works (a check), needs a look (a warning) or is optional and not there (null, a dash). */
export function CheckRow({ title, detail, ok }: { title: string; detail?: string; ok: boolean | null }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <View style={styles.label}>
        <T variant="callout" style={{ fontWeight: "500" }} numberOfLines={1}>
          {title}
        </T>
        {detail ? (
          <T variant="footnote" muted numberOfLines={3}>
            {detail}
          </T>
        ) : null}
      </View>
      <Icon name={ok ? "check" : ok === null ? "minus" : "warning"} size={15} color={ok ? c.success : ok === null ? c.textFaint : c.warning} weight="bold" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
    minHeight: 52,
  },
  label: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  value: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    maxWidth: "55%",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
