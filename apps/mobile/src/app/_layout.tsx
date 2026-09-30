import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AppLock } from "@/components/app-lock";
import { queryClient } from "@/lib/query";
import { startRealtime } from "@/lib/realtime";
import { useSession } from "@/lib/session";
import { useColors, useNavigationTheme } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const ready = useSession((s) => s.ready);
  const paired = useSession((s) => !!s.connection);
  const deviceId = useSession((s) => s.connection?.deviceId);
  const theme = useNavigationTheme();
  const c = useColors();

  useEffect(() => {
    void useSession.getState().load();
  }, []);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    if (!deviceId) {
      queryClient.clear();
      return;
    }
    return startRealtime();
  }, [deviceId]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={theme}>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal", contentStyle: { backgroundColor: c.background } }}>
              <Stack.Protected guard={paired}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="chat/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="agent/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="compose" options={{ presentation: "formSheet", sheetAllowedDetents: [0.62, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="task/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="new-task" options={{ presentation: "formSheet", sheetAllowedDetents: [0.8, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="workspaces" options={{ presentation: "formSheet", sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="settings" options={{ presentation: "formSheet", sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="live" options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: "#000" } }} />
              </Stack.Protected>
              <Stack.Protected guard={!paired}>
                <Stack.Screen name="welcome" options={{ headerShown: false }} />
              </Stack.Protected>
              <Stack.Screen name="scan" options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: "#000" } }} />
              <Stack.Screen name="pair" options={{ presentation: "formSheet", sheetAllowedDetents: [0.6], sheetGrabberVisible: true, headerShown: false }} />
            </Stack>
            <AppLock />
          </ThemeProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
