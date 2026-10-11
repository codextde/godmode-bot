import { Stack } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, sfSymbol, type IconName } from "./icon";
import { Hairline, T, tap } from "./ui";
import { radius, space, useColors } from "@/lib/theme";

export interface HeaderAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  prominent?: boolean;
}

export interface HeaderMenuItem {
  icon: IconName;
  title: string;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * Header buttons: native Liquid Glass toolbar items on iOS, plain icon buttons on Android. `menu`: more actions behind a
 * "more" button — the system menu on iOS, a sheet from the bottom on Android.
 */
export function HeaderActions({ actions = [], menu = [], placement = "right" }: { actions?: HeaderAction[]; menu?: HeaderMenuItem[]; placement?: "left" | "right" }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  if (process.env.EXPO_OS === "ios") {
    return (
      <Stack.Toolbar placement={placement}>
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
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
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
      {actions.map((a) => (
        <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={a.label} hitSlop={8} onPress={a.onPress} style={{ padding: 8 }}>
          <Icon name={a.icon} size={22} color={a.tint ?? c.text} />
        </Pressable>
      ))}
      {menu.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel="More" hitSlop={8} onPress={() => setOpen(true)} style={{ padding: 8 }}>
          <Icon name="more" size={22} color={c.text} />
        </Pressable>
      )}
    </View>
  );
  return (
    <>
      <Stack.Screen options={placement === "right" ? { headerRight: render } : { headerLeft: render }} />
      <MenuSheet items={menu} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** A short list of actions from the bottom of the screen. */
export function MenuSheet({ items, open, onClose }: { items: HeaderMenuItem[]; open: boolean; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
      <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: Math.max(insets.bottom, space.md) }]} accessibilityViewIsModal>
        {items.map((m, i) => (
          <View key={m.title}>
            {i > 0 && <Hairline inset={52} />}
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: c.sunken }}
              onPress={() => {
                onClose();
                tap();
                m.onPress();
              }}
              style={styles.item}
            >
              <Icon name={m.icon} size={19} color={m.destructive ? c.danger : c.textMuted} />
              <T variant="body" color={m.destructive ? c.danger : c.text}>
                {m.title}
              </T>
            </Pressable>
          </View>
        ))}
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
    paddingTop: space.sm,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    minHeight: 52,
    paddingHorizontal: space.lg,
  },
});
