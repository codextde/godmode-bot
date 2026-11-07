import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Tile } from "./form";
import { Icon, type IconName } from "./icon";
import { RowPressable } from "./row-pressable";
import { Hairline, Row, T, tap } from "./ui";
import { space, useColors, useLargeText } from "@/lib/theme";

export interface LinkPickerItem {
  id: string;
  title: string;
  subtitle?: string | null;
  domain?: string | null;
  suggested?: boolean;
}

const LIMIT = 50;

/**
 * Links a vault item to a login or a 2FA code, like the desktop's picker: opens in place with a search, what fits the
 * site first, and only the best matches so a big vault stays quick. `value` "" = not linked.
 */
export function LinkPickerRow({
  icon,
  title,
  value,
  onChange,
  items,
  loading,
  noneLabel,
  searchPlaceholder,
  noun,
}: {
  icon?: IconName;
  title: string;
  value: string;
  onChange: (next: string) => void;
  items: LinkPickerItem[];
  loading?: boolean;
  noneLabel: string;
  searchPlaceholder: string;
  noun: "login" | "code";
}) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const large = useLargeText();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = items.find((i) => i.id === value)?.title ?? noneLabel;

  const indexed = useMemo(() => items.map((item) => ({ item, haystack: `${item.title} ${item.subtitle ?? ""} ${item.domain ?? ""}`.toLowerCase() })), [items]);
  const { suggested, rest, total, hidden } = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length ? indexed.filter((x) => tokens.every((k) => x.haystack.includes(k))).map((x) => x.item) : items;
    const top = hits.filter((i) => i.suggested || i.id === value).slice(0, LIMIT);
    const others = hits.filter((i) => !i.suggested && i.id !== value).slice(0, LIMIT - top.length);
    return { suggested: top, rest: others, total: hits.length, hidden: hits.length - top.length - others.length };
  }, [indexed, items, query, value]);

  const pick = (next: string) => {
    setOpen(false);
    setQuery("");
    if (next !== value) onChange(next);
  };
  const row = (item: LinkPickerItem) => <Choice key={item.id} title={item.title} detail={item.subtitle} selected={item.id === value} onPress={() => pick(item.id)} />;

  return (
    <View>
      <RowPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tap();
          setOpen((v) => !v);
          setQuery("");
        }}
        style={styles.row}
      >
        {icon ? <Tile icon={icon} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
            {title}
          </T>
          {large ? (
            <T variant="footnote" muted numberOfLines={1}>
              {current}
            </T>
          ) : null}
        </View>
        {large ? null : (
          <T variant="subhead" muted numberOfLines={1} style={styles.value}>
            {current}
          </T>
        )}
        <Icon name="down" size={12} color={c.textFaint} weight="semibold" style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} />
      </RowPressable>
      {open ? (
        <View style={{ backgroundColor: c.surfaceAlt }}>
          <Row style={styles.search}>
            <Icon name="search" size={15} color={c.textMuted} />
            <TextInput
              accessibilityLabel={searchPlaceholder}
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={c.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
              style={[styles.searchInput, { color: c.text }]}
            />
          </Row>
          <Hairline />
          {loading ? (
            <Row style={styles.note}>
              <ActivityIndicator size="small" color={c.textMuted} />
              <T variant="footnote" muted>
                {t(`linkPicker.${noun}.loading`)}
              </T>
            </Row>
          ) : (
            <>
              {query.trim() ? null : <Choice title={noneLabel} selected={!value} onPress={() => pick("")} />}
              {suggested.length ? <Heading title={query.trim() ? t("linkPicker.bestMatches") : t("linkPicker.suggested")} /> : null}
              {suggested.map(row)}
              {rest.length ? <Heading title={query.trim() ? (suggested.length ? t("linkPicker.otherMatches") : t("linkPicker.matches", { count: total })) : t(`linkPicker.${noun}.all`)} /> : null}
              {rest.map(row)}
              {total === 0 && query.trim() ? <Note>{t(`linkPicker.${noun}.empty`, { query: query.trim() })}</Note> : null}
              {hidden > 0 ? <Note>{query.trim() ? t("linkPicker.moreMatches", { count: hidden }) : t(`linkPicker.${noun}.more`, { count: hidden })}</Note> : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function Heading({ title }: { title: string }) {
  const c = useColors();
  return (
    <T variant="caption" color={c.textMuted} style={styles.heading}>
      {title.toUpperCase()}
    </T>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <T variant="footnote" muted style={styles.note}>
      {children}
    </T>
  );
}

function Choice({ title, detail, selected, onPress }: { title: string; detail?: string | null; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.choice, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="subhead" numberOfLines={1} style={{ fontWeight: selected ? "600" : "400" }}>
          {title}
        </T>
        {detail ? (
          <T variant="footnote" muted numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {selected ? <Icon name="check" size={14} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 52,
    paddingVertical: 11,
  },
  value: {
    flexShrink: 1,
    maxWidth: "60%",
    textAlign: "right",
  },
  search: {
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 11,
  },
  heading: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    minHeight: 44,
  },
  note: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
});
