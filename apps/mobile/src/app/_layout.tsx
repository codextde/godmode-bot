import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { GeistMono_400Regular, GeistMono_500Medium } from "@expo-google-fonts/geist-mono";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Image } from "expo-image";
import { Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AppLock } from "@/components/app-lock";
import { api } from "@/lib/api";
import { loadAppearance, useAppearance } from "@/lib/appearance";
import { forgetQueries, persistQueries, restoreQueries } from "@/lib/persist";
import { qk, queryClient } from "@/lib/query";
import { startRealtime } from "@/lib/realtime";
import { useSession } from "@/lib/session";
import { fonts, useColors, useNavigationTheme } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync();

/** Embedded at build time by the expo-font plugin (app.json); a build from before that loads them here, under the same names. */
const FONT_FILES = {
  [fonts.regular]: Geist_400Regular,
  [fonts.medium]: Geist_500Medium,
  [fonts.semibold]: Geist_600SemiBold,
  [fonts.bold]: Geist_700Bold,
  [fonts.mono]: GeistMono_400Regular,
  [fonts.monoMedium]: GeistMono_500Medium,
};

export default function RootLayout() {
  const ready = useSession((s) => s.ready);
  const paired = useSession((s) => !!s.connection);
  const deviceId = useSession((s) => s.connection?.deviceId);
  const theme = useNavigationTheme();
  const c = useColors();
  const [fontsLoaded, fontError] = useFonts(FONT_FILES);
  const fontsReady = fontsLoaded || !!fontError;

  const [appearanceReady, setAppearanceReady] = useState(false);
  useEffect(() => {
    void useSession.getState().load();
    void loadAppearance().finally(() => setAppearanceReady(true));
  }, []);

  // What the last session saw is on screen before the computer answers.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!ready || restored) return;
    const connection = useSession.getState().connection;
    if (!connection) return setRestored(true);
    void restoreQueries(connection.deviceId).finally(() => setRestored(true));
  }, [ready, restored]);

  useEffect(() => {
    if (restored && fontsReady && appearanceReady) void SplashScreen.hideAsync();
  }, [restored, fontsReady, appearanceReady]);

  useEffect(() => {
    if (!restored) return;
    if (!deviceId) {
      queryClient.clear();
      forgetQueries();
      void Image.clearDiskCache().catch(() => undefined);
      return;
    }
    const stopRealtime = startRealtime();
    const stopSaving = persistQueries(deviceId);
    return () => {
      stopRealtime();
      stopSaving();
    };
  }, [deviceId, restored]);

  if (!ready || !restored || !fontsReady || !appearanceReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={theme}>
            <ThemeSync paired={paired} />
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal", contentStyle: { backgroundColor: c.background } }}>
              <Stack.Protected guard={paired}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="chat/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="agent/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="memory/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Memory" }} />
                <Stack.Screen name="compose" options={{ presentation: "formSheet", sheetAllowedDetents: [0.62, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="task/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="my-tasks" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "My tasks" }} />
                <Stack.Screen name="archived" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Archived chats" }} />
                <Stack.Screen name="archived-tasks" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Archived tasks" }} />
                <Stack.Screen name="automations" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Automations" }} />
                <Stack.Screen name="activity" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Activity" }} />
                <Stack.Screen name="inbox" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Inbox" }} />
                <Stack.Screen name="calls" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "Calls" }} />
                <Stack.Screen name="call/[id]" options={{ headerTransparent: process.env.EXPO_OS === "ios", title: "" }} />
                <Stack.Screen name="human-task/[id]" options={{ presentation: "formSheet", sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="new-task" options={{ presentation: "formSheet", sheetAllowedDetents: [0.8, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="model" options={{ presentation: "formSheet", sheetAllowedDetents: [0.8, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="chat-memory" options={{ presentation: "formSheet", sheetAllowedDetents: [0.62, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="workspaces" options={{ presentation: "formSheet", sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true, headerShown: false }} />
                <Stack.Screen name="settings" options={{ presentation: "modal", headerShown: false }} />
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

/** Follows the computer's theme, also when the desktop, another phone or an agent changes it. */
function ThemeSync({ paired }: { paired: boolean }) {
  const { data } = useQuery({ queryKey: qk.settings, queryFn: api.settings.get, enabled: paired, select: (s) => s.general.theme });
  useEffect(() => {
    if (data) useAppearance.getState().setTheme(data);
  }, [data]);
  return null;
}
