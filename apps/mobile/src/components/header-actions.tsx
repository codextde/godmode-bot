import { Stack } from "expo-router";
import { Pressable, View } from "react-native";
import { Icon, sfSymbol, type IconName } from "./icon";
import { tap } from "./ui";
import { useColors } from "@/lib/theme";

export interface HeaderAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  prominent?: boolean;
}

/** Header buttons: native Liquid Glass toolbar items on iOS, plain icon buttons on Android. */
export function HeaderActions({ actions, placement = "right" }: { actions: HeaderAction[]; placement?: "left" | "right" }) {
  const c = useColors();
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
      </Stack.Toolbar>
    );
  }
  const render = () => (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {actions.map((a) => (
        <Pressable key={a.label} accessibilityLabel={a.label} hitSlop={8} onPress={a.onPress} style={{ padding: 8 }}>
          <Icon name={a.icon} size={22} color={a.tint ?? c.text} />
        </Pressable>
      ))}
    </View>
  );
  return <Stack.Screen options={placement === "right" ? { headerRight: render } : { headerLeft: render }} />;
}
