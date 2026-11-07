import { useDeferredValue, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { phoneTimezone } from "./routine-row";
import { Hairline, T, tap } from "./ui";
import { space, type, radius, useColors } from "@/lib/theme";
import { allTimezones, timezoneOffset } from "@/lib/timezones";

const shown = (zone: string) => zone.replace(/_/g, " ");

/** A row with the timezone; tapping it opens a searchable list with the phone's own zone on top. */
export function TimezoneRow({ title, value, onChange }: { title: string; value: string; onChange: (zone: string) => void }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${shown(value)}`}
        onPress={() => {
          tap();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
      >
        <Icon name="globe" size={16} color={c.textMuted} />
        <T variant="callout" style={{ fontWeight: "500" }}>
          {title}
        </T>
        <T variant="subhead" muted numberOfLines={1} style={styles.value}>
          {`${shown(value)} ${timezoneOffset(value)}`.trim()}
        </T>
        <Icon name="chevron" size={11} color={c.textFaint} weight="semibold" />
      </Pressable>
      {open ? (
        <TimezoneSheet
          title={title}
          value={value}
          onClose={() => setOpen(false)}
          onPick={(zone) => {
            onChange(zone);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function TimezoneSheet({ title, value, onPick, onClose }: { title: string; value: string; onPick: (zone: string) => void; onClose: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["automations", "common"]);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase().replace(/\s+/g, "_"));
  const local = phoneTimezone();
  const zones = useMemo(() => {
    const top = [...new Set([local, value].filter((z): z is string => !!z))];
    const all = [...top, ...allTimezones().filter((z) => !top.includes(z))];
    return query ? all.filter((z) => z.toLowerCase().includes(query)) : all;
  }, [local, value, query]);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { backgroundColor: c.background }]}>
        <View style={styles.head}>
          <View style={styles.side} />
          <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
            {title}
          </T>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose} style={[styles.side, { alignItems: "flex-end" }]}>
            <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("common:actions.done")}
            </T>
          </Pressable>
        </View>
        <View style={[styles.search, { backgroundColor: c.sunken }]}>
          <Icon name="search" size={14} color={c.textMuted} />
          <TextInput
            accessibilityLabel={t("edit.timezoneSearch")}
            value={search}
            onChangeText={setSearch}
            placeholder={t("edit.timezoneSearch")}
            placeholderTextColor={c.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={[type.body, styles.input, { color: c.text }]}
          />
        </View>
        <FlatList
          data={zones}
          keyExtractor={(z) => z}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={20}
          ItemSeparatorComponent={Separator}
          ListEmptyComponent={
            <T variant="subhead" muted style={{ textAlign: "center", padding: space.xl }}>
              {t("edit.timezoneEmpty")}
            </T>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: item === value }}
              onPress={() => {
                tap();
                onPick(item);
              }}
              style={({ pressed }) => [styles.zone, pressed && { backgroundColor: c.sunken }]}
            >
              <T variant="body" numberOfLines={1} style={{ flex: 1 }}>
                {shown(item)}
              </T>
              <T variant="footnote" muted>
                {timezoneOffset(item)}
              </T>
              <View style={styles.check}>{item === value ? <Icon name="check" size={14} color={c.brandStrong} weight="bold" /> : null}</View>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const Separator = () => <Hairline inset={space.lg} />;

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48, paddingHorizontal: space.lg },
  value: { flex: 1, textAlign: "right" },
  sheet: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.lg },
  side: { minWidth: 64 },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 38, marginHorizontal: space.lg, marginBottom: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderCurve: "continuous" },
  input: { flex: 1, padding: 0 },
  zone: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 46, paddingHorizontal: space.lg },
  check: { width: 18, alignItems: "flex-end" },
});
