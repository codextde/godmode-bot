import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { LinkRow } from "./form";
import { T } from "./ui";
import { space, useColors } from "@/lib/theme";

function dateOf(value: string): Date {
  const [h = 0, m = 0] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date;
}

/** A time of day to the minute ("HH:MM"): the system's own picker, in the row on iOS and as its dialog on Android. */
export function TimeRow({ title, label, value, onChange }: { title: string; label?: string; value: string; onChange: (next: string) => void }) {
  const c = useColors();
  const [asking, setAsking] = useState(false);
  const date = useMemo(() => dateOf(value), [value]);
  const pick = (next: Date) => {
    const time = format(next, "HH:mm");
    if (time !== value) onChange(time);
  };
  if (process.env.EXPO_OS === "android") {
    return (
      <>
        <LinkRow title={title} value={value} chevron={false} onPress={() => setAsking(true)} />
        {asking ? (
          <DateTimePicker
            value={date}
            mode="time"
            accentColor={c.brand}
            onValueChange={(_, next) => {
              setAsking(false);
              pick(next);
            }}
            onDismiss={() => setAsking(false)}
          />
        ) : null}
      </>
    );
  }
  return (
    <View accessibilityLabel={label ?? title} style={styles.row}>
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
        {title}
      </T>
      <DateTimePicker value={date} mode="time" display="compact" accentColor={c.brand} onValueChange={(_, next) => pick(next)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 8,
  },
});
