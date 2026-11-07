import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Image } from "expo-image";
import { router } from "expo-router";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AndroidAssignment, AndroidDevice, AndroidExecResult, AndroidKey } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Group } from "./form";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { frameUri, phoneState } from "./screen-tile";
import { ActionRow, TestResult, TextRow } from "./tool-form";
import { LiveDot, SMOKE, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { machinesApi, putPhone } from "@/lib/machines";
import { qk, queryClient } from "@/lib/query";
import { useAndroidFrame } from "@/lib/screens";
import { radius, space, useColors } from "@/lib/theme";

const WHITE = "#FFFFFF";

/** A phone's tile in lists: busy phones carry a live dot. */
export function PhoneTile({ device }: { device: AndroidDevice }) {
  const c = useColors();
  const connected = device.state === "connected";
  return (
    <View style={[styles.tile, { backgroundColor: c.sunken }]}>
      <Icon name="phone" size={17} color={connected ? c.text : c.textMuted} />
      {connected ? (
        <View style={[styles.dot, { backgroundColor: c.surface }]}>
          <LiveDot size={7} live={device.busy} color={device.busy ? undefined : c.success} />
        </View>
      ) : null}
    </View>
  );
}

/** The phone's screen while it is connected (a tap opens it live), its state while it isn't. */
export function PhoneScreen({ device }: { device: AndroidDevice }) {
  const c = useColors();
  const { t } = useTranslation("machines");
  const connected = device.state === "connected";
  const shot = useAndroidFrame(device, connected, device.busy ? 3000 : 6000);
  const uri = frameUri(shot.data);
  const ratio = device.width && device.height ? device.width / device.height : 9 / 19.5;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("phone.watch", { name: device.name })}
      disabled={!connected}
      onPress={() => {
        tap();
        router.push({ pathname: "/live", params: { kind: "android", id: device.id, title: device.name } });
      }}
      style={({ pressed }) => [styles.screen, connected ? { height: 440, aspectRatio: ratio } : { width: "100%", aspectRatio: 16 / 9 }, { backgroundColor: c.sunken, opacity: pressed ? 0.85 : 1 }]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" transition={0} cachePolicy="none" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          {connected ? <ActivityIndicator color={c.textMuted} /> : <Icon name="phone" size={28} color={c.textFaint} />}
          <T variant="subhead" muted>
            {phoneState(device)}
          </T>
        </View>
      )}
      {connected && uri ? (
        <Glass style={styles.liveLabel} scheme="dark" fallback={SMOKE}>
          <LiveDot size={6} live={device.busy} />
          <T variant="caption" color={WHITE} style={{ fontWeight: "600" }}>
            {t("phone.watchLive")}
          </T>
        </Glass>
      ) : null}
    </Pressable>
  );
}

/** The phone's own buttons, like the desktop's device page. */
export const PHONE_BUTTONS = [
  { key: "power", icon: "power", label: "phone.buttons.power" },
  { key: "volume_down", icon: "volumeDown", label: "phone.buttons.volumeDown" },
  { key: "volume_up", icon: "volumeUp", label: "phone.buttons.volumeUp" },
  { key: "mute", icon: "mute", label: "phone.buttons.mute" },
  { key: "wake", icon: "sun", label: "phone.buttons.wake" },
  { key: "sleep", icon: "moon", label: "phone.buttons.sleep" },
  { key: "notifications", icon: "bell", label: "phone.buttons.notifications" },
  { key: "quick_settings", icon: "slider", label: "phone.buttons.quickSettings" },
] as const satisfies readonly { key: AndroidKey; icon: IconName; label: string }[];

const NAV_BUTTONS = [
  { key: "back", icon: "back", label: "phone.buttons.back" },
  { key: "home", icon: "navHome", label: "phone.buttons.home" },
  { key: "recents", icon: "navRecents", label: "phone.buttons.recents" },
] as const satisfies readonly { key: AndroidKey; icon: IconName; label: string }[];

/** Back, home, recents and the hardware buttons of a connected phone. */
export function PhoneButtons({ device }: { device: AndroidDevice }) {
  const c = useColors();
  const { t } = useTranslation("machines");
  const press = useMutation({
    mutationFn: (key: AndroidKey) => machinesApi.android.input(device.id, { event: { type: "key", key } }),
    onError: (err) => Alert.alert(t("phone.buttons.failed"), errorText(err)),
  });
  return (
    <Group title={t("phone.buttons.title")}>
      <View style={styles.buttons}>
        {[...NAV_BUTTONS, ...PHONE_BUTTONS].map((b) => (
          <Pressable
            key={b.key}
            accessibilityRole="button"
            accessibilityLabel={t(b.label)}
            onPress={() => {
              tap();
              press.mutate(b.key);
            }}
            style={({ pressed }) => [styles.button, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon name={b.icon} size={18} color={c.text} />
          </Pressable>
        ))}
      </View>
    </Group>
  );
}

/** Agents and chats that use the phone: taken off with a tap, agents added from the list. */
export function PhoneUsedBy({ device }: { device: AndroidDevice }) {
  const { t } = useTranslation("machines");
  const c = useColors();
  const agents = useAgents();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const assigned = new Set(device.assignments.filter((a) => a.kind === "agent").map((a) => a.id));
  const others = [...(agents.data ?? [])].filter((a) => !assigned.has(a.id)).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  const set = async (a: Pick<AndroidAssignment, "kind" | "id">, on: boolean) => {
    setBusy(a.id);
    try {
      putPhone(await machinesApi.android.assign(device.id, { kind: a.kind, id: a.id, assigned: on }));
      void queryClient.invalidateQueries({ queryKey: a.kind === "agent" ? qk.agents : qk.conversation(a.id) });
      if (on) setAdding(false);
    } catch (err) {
      Alert.alert(t("phone.assignFailed"), errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group title={t("vm.usedBy")}>
      {device.assignments.length ? null : (
        <View style={styles.row}>
          <T variant="subhead" muted>
            {t("vm.noOne")}
          </T>
        </View>
      )}
      {device.assignments.map((a) => {
        const agent = a.kind === "agent" ? agents.byId.get(a.id) : undefined;
        const label = a.name || (a.kind === "agent" ? t("vm.kind.agent") : t("vm.untitledChat"));
        return (
          <View key={`${a.kind}-${a.id}`} style={[styles.row, busy === a.id && { opacity: 0.5 }]}>
            {agent ? <CharacterAvatar agent={agent} size={26} /> : <Icon name="chats" size={18} color={c.textMuted} />}
            <View style={{ flex: 1, minWidth: 0 }}>
              <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                {label}
              </T>
              <T variant="footnote" muted>
                {t(`vm.kind.${a.kind}`)}
              </T>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("vm.stopUsing", { name: label })}
              hitSlop={8}
              disabled={busy === a.id}
              onPress={() => {
                tap();
                void set(a, false);
              }}
            >
              <Icon name="closeCircle" size={18} color={c.textFaint} />
            </Pressable>
          </View>
        );
      })}
      {others.length ? <ActionRow icon={adding ? "up" : "plus"} title={t("vm.assign")} onPress={() => setAdding((v) => !v)} /> : null}
      {adding
        ? others.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              disabled={busy === a.id}
              onPress={() => {
                tap();
                void set({ kind: "agent", id: a.id }, true);
              }}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.sunken : c.surfaceAlt, opacity: busy === a.id ? 0.5 : 1 }]}
            >
              <CharacterAvatar agent={a} size={26} />
              <T variant="callout" numberOfLines={1} style={{ flex: 1 }}>
                {a.name}
              </T>
              {busy === a.id ? <ActivityIndicator size="small" /> : <Icon name="plus" size={14} color={c.brandStrong} />}
            </Pressable>
          ))
        : null}
    </Group>
  );
}

/** One adb shell command on the phone, with what it printed. */
export function PhoneCommand({ device }: { device: AndroidDevice }) {
  const { t } = useTranslation("machines");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ command: string; result: AndroidExecResult } | { command: string; error: string } | null>(null);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    try {
      setResult({ command: cmd, result: await machinesApi.android.exec(device.id, cmd) });
    } catch (err) {
      setResult({ command: cmd, error: errorText(err) });
    } finally {
      setRunning(false);
    }
  };

  const outcome = result && "result" in result ? result.result : null;
  const took = outcome ? (outcome.durationMs < 1000 ? `${outcome.durationMs} ms` : `${(outcome.durationMs / 1000).toFixed(1)} s`) : "";
  return (
    <Group title={t("command.title")} footer={t("phone.shellHint")}>
      <TextRow label={t("command.label")} value={command} onChange={setCommand} placeholder="pm list packages -3" mono stacked />
      <ActionRow icon="play" title={running ? t("command.running") : t("command.run")} busy={running} onPress={() => void run()} />
      {result && !running ? (
        "error" in result ? (
          <TestResult ok={false} title={t("command.failed")} body={result.error} />
        ) : (
          <TestResult
            ok={outcome!.exitCode === 0 && !outcome!.timedOut}
            title={[`exit ${outcome!.exitCode ?? "–"}`, outcome!.timedOut ? t("command.timedOut") : null, took].filter(Boolean).join(" · ")}
            body={[outcome!.stdout, outcome!.stderr].filter(Boolean).join("\n").trim() || t("command.noOutput")}
          />
        )
      ) : null}
    </Group>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, padding: space.md },
  button: { width: "22.5%", flexGrow: 1, height: 44, borderRadius: radius.md, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    position: "absolute",
    right: -3,
    bottom: -3,
    padding: 2,
    borderRadius: radius.pill,
  },
  screen: {
    alignSelf: "center",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  liveLabel: {
    position: "absolute",
    left: space.sm,
    bottom: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 50,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
