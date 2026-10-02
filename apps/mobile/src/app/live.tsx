import { useMutation, useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { browserView, type ComputerInputEvent } from "@godmode/shared";
import { Glass, GlassGroup } from "@/components/glass";
import { Icon } from "@/components/icon";
import { frameUri, vmState } from "@/components/screen-tile";
import { Button, GlassIconButton, SMOKE, LiveDot, T, tap } from "@/components/ui";
import { api, errorText, type BrowserInput } from "@/lib/api";
import { hostOf } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useLive, type Frame } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { useStreamFrame, useVmFrame, type LiveScreen } from "@/lib/screens";

const WHITE = "#FFFFFF";
const DIM = "rgba(255,255,255,0.7)";

/** The type box, key bar and buttons above the keyboard. */
const TOOLS_HEIGHT = 184;

type Key = { label: string; key: string; modifiers?: string[]; a11y: string };

const KEYS: Key[] = [
  { label: "esc", key: "Escape", a11y: "Escape" },
  { label: "tab", key: "Tab", a11y: "Tab" },
  { label: "⌫", key: "Backspace", a11y: "Delete" },
  { label: "←", key: "ArrowLeft", a11y: "Left arrow" },
  { label: "↑", key: "ArrowUp", a11y: "Up arrow" },
  { label: "↓", key: "ArrowDown", a11y: "Down arrow" },
  { label: "→", key: "ArrowRight", a11y: "Right arrow" },
];

const MAC_KEYS: Key[] = [
  { label: "⌘ space", key: "space", modifiers: ["cmd"], a11y: "Spotlight" },
  { label: "⌘ tab", key: "Tab", modifiers: ["cmd"], a11y: "Switch apps" },
  { label: "⌘ W", key: "w", modifiers: ["cmd"], a11y: "Close window" },
  { label: "⌘ Q", key: "q", modifiers: ["cmd"], a11y: "Quit app" },
];

export default function Live() {
  const params = useLocalSearchParams<{ kind: LiveScreen["kind"]; id: string; title?: string; chat?: string }>();
  const chat = params.chat || null;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const now = useNow(1000);
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list, enabled: params.kind === "vm" });
  const vm = params.kind === "vm" ? (vms.data?.find((v) => v.id === params.id) ?? null) : null;
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles, enabled: params.kind === "browser" });
  const profile = params.kind === "browser" ? profiles.data?.find((p) => p.id === params.id) : undefined;
  // Subscribed even while it's off: the core starts streaming as soon as the browser runs.
  const screen: LiveScreen | null =
    params.kind === "browser"
      ? { kind: "browser", key: `browser:${browserView(params.id, chat)}`, id: params.id, conversationId: chat, title: params.title ?? "Browser", running: profile?.running ?? true }
      : params.kind === "share"
        ? { kind: "share", key: `computer:${params.id}`, view: params.id, title: params.title ?? "Shared screen", conversationId: "" }
        : null;
  const stream = useStreamFrame(screen);
  const shot = useVmFrame(vm, true, 1500);
  // A browser that stopped leaves its last frame behind; don't show it as live.
  const frame: Frame | undefined = params.kind === "vm" ? shot.data : profile?.running === false ? undefined : stream;
  const uri = frameUri(frame);
  const online = useLive((s) => s.status === "online");
  const fresh = !!frame && (params.kind === "browser" ? online : now - frame.at < 8000);
  const [control, setControl] = useState(false);
  const [typing, setTyping] = useState(false);
  const keyboard = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  const [text, setText] = useState("");
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number; secondary: boolean } | null>(null);
  const canControl = params.kind !== "vm" || vm?.state === "running";
  // Shared screens and VMs are whole Macs: they take right clicks and shortcuts; a browser tab doesn't.
  const mac = params.kind !== "browser";

  const input = useMutation({
    mutationFn: async (event: BrowserInput & ComputerInputEvent) => {
      if (!frame) return;
      const size = { width: frame.width, height: frame.height };
      if (params.kind === "browser") await api.browser.input(params.id, event, chat);
      else if (params.kind === "vm") await api.vms.input(params.id, event, size);
      else await api.computer.input(params.id, event, size);
    },
    // VMs have no stream: show what the input did right away instead of at the next poll.
    onSuccess: () => {
      if (params.kind === "vm") setTimeout(() => queryClient.refetchQueries({ queryKey: qk.vmScreen(params.id) }), 250);
    },
    onError: (err) => Alert.alert("Couldn't reach the screen", errorText(err)),
  });

  const vmAction = useMutation({
    mutationFn: (action: "start" | "stop") => (action === "start" ? api.vms.start(params.id) : api.vms.stop(params.id)),
    onError: (err) => Alert.alert("Couldn't change the VM", errorText(err)),
  });

  const launch = useMutation({
    mutationFn: () => api.browser.launch(params.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.browserProfiles }),
    onError: (err) => Alert.alert("Couldn't start the browser", errorText(err)),
  });

  // With the keyboard up, the picture moves into the space between the title and the controls above the keyboard.
  const top = keyboard ? insets.top + 60 : 0;
  const box = { width, height: keyboard ? Math.max(120, height - keyboard - TOOLS_HEIGHT - top) : height };
  const fit = frame ? Math.min(box.width / frame.width, box.height / frame.height) : 1;
  const shown = frame ? { width: frame.width * fit, height: frame.height * fit } : box;

  const press = (e: GestureResponderEvent, button: "left" | "right") => {
    if (!control || !frame) return;
    const { locationX, locationY } = e.nativeEvent;
    const x = Math.round(locationX / fit);
    const y = Math.round(locationY / fit);
    if (x < 0 || y < 0 || x > frame.width || y > frame.height) return;
    tap();
    const id = Date.now();
    setRipple({ x: locationX, y: locationY, id, secondary: button === "right" });
    setTimeout(() => setRipple((r) => (r?.id === id ? null : r)), 450);
    input.mutate(button === "right" ? { type: "click", x, y, button } : { type: "click", x, y });
  };

  const scroll = (deltaY: number) => frame && input.mutate({ type: "scroll", x: Math.round(frame.width / 2), y: Math.round(frame.height / 2), deltaY });

  const sendKey = (k: Key) => {
    tap();
    input.mutate(k.modifiers ? { type: "key", key: k.key, modifiers: k.modifiers } : { type: "key", key: k.key });
  };

  const sendText = () => {
    const value = text;
    if (!value) return;
    setText("");
    input.mutate({ type: "text", text: value });
  };

  // Text still in the box goes in first, then Return: what "Enter" means while typing.
  const enter = async () => {
    const value = text;
    setText("");
    if (value && !(await input.mutateAsync({ type: "text", text: value }).then(() => true, () => false))) return;
    sendKey({ label: "Enter", key: "Enter", a11y: "Enter" });
  };

  const subtitle =
    params.kind === "vm"
      ? vm
        ? vmState(vm.state)
        : "Virtual machine"
      : frame?.error
        ? frame.error
        : params.kind === "browser"
          ? profile?.running === false
            ? "Not running"
            : hostOf(frame?.url) || "Browser"
          : frame?.title || "Shared screen";

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ width, height: box.height + top, paddingTop: top, alignItems: "center", justifyContent: "center" }}
        maximumZoomScale={control ? 1 : 4}
        minimumZoomScale={1}
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        bouncesZoom
      >
        {uri ? (
          <Pressable
            onPress={(e) => press(e, "left")}
            onLongPress={mac ? (e) => press(e, "right") : null}
            delayLongPress={380}
            disabled={!control}
            accessibilityHint={mac ? "In control: tap to click, hold to right-click" : "In control: tap to click"}
            style={shown}
          >
            <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" transition={0} />
            {ripple && (
              <Animated.View
                key={ripple.id}
                entering={ZoomIn.duration(220)}
                exiting={FadeOut}
                style={[styles.ripple, ripple.secondary && styles.rippleSecondary, { left: ripple.x - 22, top: ripple.y - 22 }]}
              />
            )}
          </Pressable>
        ) : (
          <View style={{ alignItems: "center", gap: 14, paddingHorizontal: 40 }}>
            {params.kind === "vm" && vm && vm.state !== "running" ? (
              <>
                <Icon name="vm" size={34} color={DIM} />
                <T variant="headline" color={WHITE}>
                  {vm.name} is {vmState(vm.state).toLowerCase()}
                </T>
                {vm.state === "stopped" || vm.state === "suspended" ? (
                  <Button title="Start VM" icon="play" variant="glass" dark loading={vmAction.isPending} onPress={() => vmAction.mutate("start")} />
                ) : (
                  <ActivityIndicator color={WHITE} />
                )}
              </>
            ) : profile && !profile.running ? (
              <>
                <Icon name="globe" size={34} color={DIM} />
                <T variant="headline" color={WHITE}>
                  {`${profile.name} isn't running`}
                </T>
                <T variant="subhead" color={DIM} style={{ textAlign: "center" }}>
                  {chat ? "It starts when the agent needs the web." : "Agents start it when they need the web. Start it now to watch it here."}
                </T>
                {!chat && <Button title="Start browser" icon="play" variant="glass" dark loading={launch.isPending} onPress={() => launch.mutate()} />}
              </>
            ) : (
              <>
                <ActivityIndicator color={WHITE} />
                <T variant="subhead" color={DIM} style={{ textAlign: "center" }}>
                  {params.kind === "browser" && chat ? "Waiting for the browser. It shows up here as soon as an agent uses it." : "Waiting for the picture…"}
                </T>
                {params.kind === "vm" && shot.error ? (
                  <T variant="caption" color={DIM} style={{ textAlign: "center" }}>
                    {errorText(shot.error)}
                  </T>
                ) : null}
              </>
            )}
          </View>
        )}
      </ScrollView>

      <View style={[styles.top, { paddingTop: insets.top + 8, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
        <GlassIconButton icon="close" label="Close" onPress={() => router.back()} dark />
        <Glass style={styles.title} scheme="dark" fallback={SMOKE}>
          {fresh ? <LiveDot size={7} /> : <View style={[styles.idleDot]} />}
          <View style={{ flexShrink: 1 }}>
            <T variant="footnote" color={WHITE} numberOfLines={1} style={{ fontWeight: "600" }}>
              {params.title ?? vm?.name ?? "Screen"}
            </T>
            <T variant="caption" color={DIM} numberOfLines={1}>
              {subtitle}
            </T>
          </View>
        </Glass>
        {params.kind === "vm" && vm?.state === "running" ? (
          <GlassIconButton icon="power" label="Stop VM" onPress={() => confirmStop(() => vmAction.mutate("stop"))} dark />
        ) : (
          <View style={{ width: 44 }} />
        )}
      </View>

      {canControl && uri ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }} style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
          {typing && (
            <Animated.View entering={FadeIn} style={{ width: "100%", maxWidth: 520, gap: 8 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.keys}>
                {[...KEYS, ...(params.kind === "vm" ? MAC_KEYS : [])].map((k) => (
                  <Pressable key={k.a11y} accessibilityRole="button" accessibilityLabel={k.a11y} onPress={() => sendKey(k)}>
                    {({ pressed }) => (
                      <Glass style={[styles.key, pressed && styles.keyPressed]} scheme="dark" fallback={SMOKE}>
                        <T variant="footnote" color={WHITE} style={{ fontWeight: "600" }}>
                          {k.label}
                        </T>
                      </Glass>
                    )}
                  </Pressable>
                ))}
              </ScrollView>
              <Glass style={styles.typeBox} scheme="dark" fallback={SMOKE}>
                <TextInput
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={text}
                  onChangeText={setText}
                  onSubmitEditing={sendText}
                  placeholder="Type into the screen"
                  placeholderTextColor={DIM}
                  returnKeyType="send"
                  style={styles.typeInput}
                />
                <Pressable onPress={enter} style={styles.enter}>
                  <T variant="caption" color={WHITE} style={{ fontWeight: "600" }}>
                    Enter
                  </T>
                </Pressable>
              </Glass>
            </Animated.View>
          )}
          <GlassGroup style={styles.tools} spacing={14}>
            <Pressable
              onPress={() => {
                tap();
                setControl((v) => !v);
                setTyping(false);
              }}
            >
              <Glass interactive tint={control ? "rgba(14,202,123,0.55)" : undefined} scheme="dark" fallback={SMOKE} style={styles.controlPill}>
                <Icon name="hand" size={16} color={WHITE} />
                <T variant="subhead" color={WHITE} style={{ fontWeight: "600" }}>
                  {control ? "You're in control" : "Take control"}
                </T>
              </Glass>
            </Pressable>
            {control && (
              <>
                <GlassIconButton icon="keyboard" label="Type" onPress={() => setTyping((v) => !v)} dark />
                <GlassIconButton icon="up" label="Scroll up" onPress={() => scroll(-500)} dark />
                <GlassIconButton icon="down" label="Scroll down" onPress={() => scroll(500)} dark />
              </>
            )}
          </GlassGroup>
          {control && !typing && (
            <T variant="caption" color={DIM}>
              {mac ? "Tap to click, hold to right-click" : "Tap the picture to click there"}
            </T>
          )}
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

function confirmStop(stop: () => void) {
  Alert.alert("Stop this VM?", "macOS shuts down; agents working in it are interrupted.", [
    { text: "Cancel", style: "cancel" },
    { text: "Stop", style: "destructive", onPress: stop },
  ]);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  top: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  title: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  idleDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.45)" },
  bottom: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 0,
    alignItems: "center",
    gap: 10,
  },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
  },
  typeBox: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 22,
    paddingLeft: 16,
    paddingRight: 6,
    height: 48,
  },
  typeInput: { flex: 1, color: WHITE, fontSize: 16 },
  enter: {
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  keys: { gap: 8, paddingHorizontal: 2 },
  key: {
    minWidth: 44,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  keyPressed: { opacity: 0.6 },
  ripple: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: "#2FD690",
    backgroundColor: "rgba(47,214,144,0.25)",
  },
  rippleSecondary: { borderColor: "#7DB8FF", backgroundColor: "rgba(125,184,255,0.25)" },
});
