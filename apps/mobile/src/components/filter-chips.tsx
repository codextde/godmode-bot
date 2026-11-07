import { Pressable, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { radius, space, textScale, useColors } from "@/lib/theme";

export interface Filter<V extends string> {
  id: V;
  label: string;
  count?: number;
}

/** One scrolling row of filters, the desktop's status tabs on a phone. `bleed`: how far the row reaches past its parent's padding. */
export function FilterChips<V extends string>({ filters, value, onChange, bleed = 0 }: { filters: readonly Filter<V>[]; value: V; onChange: (next: V) => void; bleed?: number }) {
  const c = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      style={{ marginHorizontal: -bleed }}
      contentContainerStyle={[styles.row, { paddingHorizontal: bleed }]}
    >
      {filters.map((f) => {
        const active = f.id === value;
        return (
          <Pressable
            key={f.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            hitSlop={4}
            onPress={() => {
              if (active) return;
              tap();
              onChange(f.id);
            }}
            style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
          >
            <T variant="subhead" numberOfLines={1} maxScale={textScale.control} color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
              {f.label}
            </T>
            {f.count ? (
              <T variant="footnote" maxScale={textScale.control} color={active ? c.onPrimary : c.textMuted} style={{ fontVariant: ["tabular-nums"], opacity: active ? 0.7 : 1 }}>
                {f.count}
              </T>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A filter picked in the header's filter menu, on the list's top line; tap to take it off. */
export function ActiveFilterChip({ label, count, onClear }: { label: string; count?: number; onClear: () => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count ? `${label} ${count}` : label}. ${t("filterToolbar.clear")}`}
      hitSlop={6}
      onPress={() => {
        tap();
        onClear();
      }}
      style={({ pressed }) => [styles.chip, styles.active, { backgroundColor: c.brandSoft, opacity: pressed ? 0.7 : 1 }]}
    >
      <T variant="subhead" numberOfLines={1} maxScale={textScale.control} color={c.brandStrong} style={{ fontWeight: "600" }}>
        {count ? `${label} ${count}` : label}
      </T>
      <Icon name="close" size={10} color={c.brandStrong} weight="bold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: space.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  active: {
    paddingHorizontal: 12,
  },
});
