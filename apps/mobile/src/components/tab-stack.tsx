import { Stack } from "expo-router";
import { useColors, usePageStyle } from "@/lib/theme";
import { readableLayout } from "./readable";

const ios = process.env.EXPO_OS === "ios";

/**
 * The navigation stack inside each tab: large titles over glass on iOS, a flat bar on Android. `readable`: on wide screens
 * the content keeps to a centered column (only for a tab without a large title, which stays at the leading edge).
 */
export function TabStack({ readable = false }: { readable?: boolean }) {
  const c = useColors();
  const page = usePageStyle();
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
        contentStyle: page,
      }}
      screenLayout={readable ? readableLayout : undefined}
    />
  );
}
