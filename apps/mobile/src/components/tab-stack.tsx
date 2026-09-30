import { Stack } from "expo-router";
import { useColors } from "@/lib/theme";

const ios = process.env.EXPO_OS === "ios";

/** The navigation stack inside each tab: large titles over glass on iOS, a flat bar on Android. */
export function TabStack() {
  const c = useColors();
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: ios,
        headerTransparent: ios,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        headerStyle: ios ? undefined : { backgroundColor: c.background },
        headerTintColor: c.text,
        contentStyle: { backgroundColor: c.background },
      }}
    />
  );
}
