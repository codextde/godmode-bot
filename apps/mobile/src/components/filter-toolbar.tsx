import { Stack } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HeaderAction, HeaderMenuItem } from "./header-actions";
import { MenuSheet } from "./header-actions";
import { Icon, sfSymbol, type IconName } from "./icon";
import { Hairline, T, tap } from "./ui";
import { radius, space, useColors } from "@/lib/theme";

export interface FilterOption {
  value: string;
  label: string;
}

/** One way to narrow a list (agent, trigger, label…): its options, the first being "all". */
export interface FilterSection {
  id: string;
  title: string;
  icon: IconName;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
}

/**
 * The header of a list that filters: its buttons, a filter menu (a submenu per section, a check on what's picked, the
 * icon filled while any is on) and the "more" menu. The system menu on iOS, a sheet from the bottom on Android.
 */
export function FilterToolbar({ actions = [], filters, menu = [] }: { actions?: HeaderAction[]; filters: FilterSection[]; menu?: HeaderMenuItem[] }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [open, setOpen] = useState<"filters" | "menu" | null>(null);
  const shown = filters.filter((f) => f.options.length > 2);
  const active = shown.some((f) => f.value !== f.options[0]?.value);
  const clear = () => shown.forEach((f) => f.onChange(f.options[0]!.value));
  if (process.env.EXPO_OS === "ios") {
    return (
      <Stack.Toolbar placement="right">
        {shown.length > 0 && (
          <Stack.Toolbar.Menu icon={sfSymbol(active ? "filterOn" : "filter")} accessibilityLabel={t("filterToolbar.filter")} tintColor={active ? c.brandStrong : undefined}>
            {shown.map((f) => (
              <Stack.Toolbar.Menu key={f.id} title={f.title} icon={sfSymbol(f.icon)}>
                {f.options.map((o) => (
                  <Stack.Toolbar.MenuAction key={o.value} isOn={o.value === f.value} onPress={() => f.onChange(o.value)}>
                    {o.label}
                  </Stack.Toolbar.MenuAction>
                ))}
              </Stack.Toolbar.Menu>
            ))}
            {active ? (
              <Stack.Toolbar.MenuAction icon="xmark.circle" onPress={clear}>
                {t("filterToolbar.clear")}
              </Stack.Toolbar.MenuAction>
            ) : null}
          </Stack.Toolbar.Menu>
        )}
        {actions.map((a) => (
          <Stack.Toolbar.Button
            key={a.label}
            icon={sfSymbol(a.icon)}
            accessibilityLabel={a.label}
            tintColor={a.tint}
            variant={a.prominent ? "prominent" : "plain"}
            onPress={() => {
              tap();
              a.onPress();
            }}
          />
        ))}
        {menu.length > 0 && (
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t("headerActions.more")}>
            {menu.map((m) => (
              <Stack.Toolbar.MenuAction key={m.title} icon={sfSymbol(m.icon)} destructive={m.destructive} onPress={m.onPress}>
                {m.title}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        )}
      </Stack.Toolbar>
    );
  }
  const render = () => (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {shown.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel={t("filterToolbar.filter")} hitSlop={8} onPress={() => setOpen("filters")} style={{ padding: 8 }}>
          <Icon name={active ? "filterOn" : "filter"} size={22} color={active ? c.brandStrong : c.text} />
        </Pressable>
      )}
      {actions.map((a) => (
        <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={a.label} hitSlop={8} onPress={a.onPress} style={{ padding: 8 }}>
          <Icon name={a.icon} size={22} color={a.tint ?? c.text} />
        </Pressable>
      ))}
      {menu.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel={t("headerActions.more")} hitSlop={8} onPress={() => setOpen("menu")} style={{ padding: 8 }}>
          <Icon name="more" size={22} color={c.text} />
        </Pressable>
      )}
    </View>
  );
  return (
    <>
      <Stack.Screen options={{ headerRight: render }} />
      <FilterSheet filters={shown} open={open === "filters"} active={active} onClear={clear} onClose={() => setOpen(null)} />
      <MenuSheet items={menu} open={open === "menu"} onClose={() => setOpen(null)} />
    </>
  );
}

function FilterSheet({ filters, open, active, onClear, onClose }: { filters: FilterSection[]; open: boolean; active: boolean; onClear: () => void; onClose: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable accessibilityLabel={t("common:actions.close")} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
      <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: Math.max(insets.bottom, space.md) }]} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={{ paddingVertical: space.sm }}>
          {filters.map((f) => (
            <View key={f.id} style={{ marginBottom: space.sm }}>
              <T variant="eyebrow" muted style={styles.title}>
                {f.title}
              </T>
              {f.options.map((o, i) => (
                <View key={o.value}>
                  {i > 0 && <Hairline inset={space.lg} />}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: o.value === f.value }}
                    android_ripple={{ color: c.sunken }}
                    onPress={() => {
                      tap();
                      f.onChange(o.value);
                    }}
                    style={styles.item}
                  >
                    <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
                      {o.label}
                    </T>
                    {o.value === f.value ? <Icon name="check" size={16} color={c.brandStrong} weight="bold" /> : null}
                  </Pressable>
                </View>
              ))}
            </View>
          ))}
          {active ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onClear();
                onClose();
              }}
              style={styles.item}
            >
              <T variant="body" color={c.brandStrong}>
                {t("filterToolbar.clear")}
              </T>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "75%",
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  title: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    minHeight: 48,
    paddingHorizontal: space.lg,
  },
});
