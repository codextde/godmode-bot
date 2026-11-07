import { useState, type ReactNode } from "react";
import { Image } from "expo-image";
import { router } from "expo-router";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Vm, VmAssignment, VmExecResult } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Group } from "./form";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { frameUri, vmState } from "./screen-tile";
import { ActionRow, TestResult, TextRow } from "./tool-form";
import { Badge, LiveDot, SMOKE, T, tap, type Tone } from "./ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { machinesApi, putVm, vmBusy } from "@/lib/machines";
import { qk, queryClient } from "@/lib/query";
import { useVmFrame } from "@/lib/screens";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const WHITE = "#FFFFFF";

const TONE: Record<Vm["state"], Tone> = {
  running: "brand",
  starting: "brand",
  creating: "neutral",
  stopping: "neutral",
  stopped: "neutral",
  suspended: "dream",
  error: "danger",
};

export function VmStateBadge({ state }: { state: Vm["state"] }) {
  return <Badge label={vmState(state)} tone={TONE[state]} live={state === "running"} />;
}

/** The VM's screen while it runs (a tap opens it live), its state while it doesn't. */
export function VmScreen({ vm, action }: { vm: Vm; action?: ReactNode }) {
  const c = useColors();
  const { t } = useTranslation("machines");
  const shot = useVmFrame(vm, vm.state === "running", 4000);
  const uri = frameUri(shot.data);
  const [w, h] = vm.display.split("x").map(Number);
  const aspect = w && h ? w / h : 16 / 10;
  const running = vm.state === "running";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("vm.watch", { name: vm.name })}
      disabled={!running}
      onPress={() => {
        tap();
        router.push({ pathname: "/live", params: { kind: "vm", id: vm.id, title: vm.name } });
      }}
      style={({ pressed }) => [styles.screen, { aspectRatio: aspect, backgroundColor: c.sunken, opacity: pressed ? 0.85 : 1 }]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" transition={0} cachePolicy="none" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          {running || vmBusy(vm.state) ? <ActivityIndicator color={c.textMuted} /> : <Icon name={vm.state === "suspended" ? "moon" : "vm"} size={28} color={c.textFaint} />}
          {!running ? (
            <T variant="subhead" muted>
              {vm.progress?.label ?? vmState(vm.state)}
              {vm.progress?.percent != null ? ` · ${Math.floor(vm.progress.percent)}%` : ""}
            </T>
          ) : null}
          {action}
        </View>
      )}
      {running ? (
        <Glass style={styles.liveLabel} scheme="dark" fallback={SMOKE}>
          <LiveDot size={6} />
          <T variant="caption" color={WHITE} style={{ fontWeight: "600" }}>
            {t("vm.watchLive")}
          </T>
        </Glass>
      ) : null}
    </Pressable>
  );
}

/** Agents and workspaces that work in the VM (a chat's own VM is picked in the chat); taken off and added here. */
export function VmUsedBy({ vm, vms }: { vm: Vm; vms: Vm[] }) {
  const { t } = useTranslation("machines");
  const c = useColors();
  const agents = useAgents();
  const { workspaces } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const nameOf = (id: string | null | undefined) => (id ? (vms.find((v) => v.id === id)?.name ?? null) : null);
  const sorted = [...(agents.data ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const others = [
    ...sorted.filter((a) => a.vmId !== vm.id).map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, other: nameOf(a.vmId), agent: a })),
    ...workspaces.filter((w) => w.vmId !== vm.id).map((w) => ({ kind: "workspace" as const, id: w.id, name: w.name, other: nameOf(w.vmId), agent: undefined })),
  ];

  const set = async (a: Pick<VmAssignment, "kind" | "id">, assigned: boolean) => {
    setBusy(a.id);
    try {
      putVm(await machinesApi.vms.assign(vm.id, { kind: a.kind, id: a.id, assigned }));
      void queryClient.invalidateQueries({ queryKey: a.kind === "agent" ? qk.agents : a.kind === "workspace" ? qk.workspaces : qk.conversation(a.id) });
      if (assigned) setAdding(false);
    } catch (err) {
      Alert.alert(t("vm.assignFailed"), errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const icon = (kind: VmAssignment["kind"]): IconName => (kind === "workspace" ? "layers" : kind === "conversation" ? "chats" : "agents");

  return (
    <Group title={t("vm.usedBy")}>
      {vm.assignments.length ? null : (
        <View style={styles.row}>
          <T variant="subhead" muted>
            {t("vm.noOne")}
          </T>
        </View>
      )}
      {vm.assignments.map((a) => {
        const agent = a.kind === "agent" ? agents.byId.get(a.id) : undefined;
        return (
          <View key={`${a.kind}-${a.id}`} style={[styles.row, busy === a.id && { opacity: 0.5 }]}>
            {agent ? <CharacterAvatar agent={agent} size={26} /> : <Icon name={icon(a.kind)} size={18} color={c.textMuted} />}
            <View style={{ flex: 1, minWidth: 0 }}>
              <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                {a.name || t("vm.untitledChat")}
              </T>
              <T variant="footnote" muted>
                {t(`vm.kind.${a.kind}`)}
              </T>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("vm.stopUsing", { name: a.name || t("vm.untitledChat") })}
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
        ? others.map((o) => (
            <Pressable
              key={`${o.kind}-${o.id}`}
              accessibilityRole="button"
              disabled={busy === o.id}
              onPress={() => {
                tap();
                void set(o, true);
              }}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.sunken : c.surfaceAlt, opacity: busy === o.id ? 0.5 : 1 }]}
            >
              {o.agent ? <CharacterAvatar agent={o.agent} size={26} /> : <Icon name="layers" size={18} color={c.textMuted} />}
              <View style={{ flex: 1, minWidth: 0 }}>
                <T variant="callout" numberOfLines={1}>
                  {o.name}
                </T>
                <T variant="footnote" muted numberOfLines={1}>
                  {o.other ? t("vm.usesOther", { name: o.other }) : t(`vm.kind.${o.kind}`)}
                </T>
              </View>
              {busy === o.id ? <ActivityIndicator size="small" /> : <Icon name="plus" size={14} color={c.brandStrong} />}
            </Pressable>
          ))
        : null}
    </Group>
  );
}

/** One command in the running VM as its user, with what it printed (like the desktop's command box). */
export function VmCommand({ vm }: { vm: Vm }) {
  const { t } = useTranslation("machines");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ command: string; result: VmExecResult } | { command: string; error: string } | null>(null);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    try {
      setResult({ command: cmd, result: await machinesApi.vms.exec(vm.id, cmd) });
    } catch (err) {
      setResult({ command: cmd, error: errorText(err) });
    } finally {
      setRunning(false);
    }
  };

  const outcome = result && "result" in result ? result.result : null;
  return (
    <Group title={t("command.title")} footer={t("command.runsAs", { user: vm.guestUser })}>
      <TextRow label={t("command.label")} value={command} onChange={setCommand} placeholder="sw_vers && brew --version" mono stacked />
      <ActionRow icon="play" title={running ? t("command.running") : t("command.run")} busy={running} onPress={() => void run()} />
      {result && !running ? (
        "error" in result ? (
          <TestResult ok={false} title={t("command.failed")} body={result.error} />
        ) : (
          <TestResult
            ok={outcome!.exitCode === 0 && !outcome!.timedOut}
            title={[`exit ${outcome!.exitCode ?? "–"}`, outcome!.timedOut ? t("command.timedOut") : null].filter(Boolean).join(" · ")}
            body={[outcome!.stdout, outcome!.stderr].filter(Boolean).join("\n").trim() || t("command.noOutput")}
          />
        )
      ) : null}
    </Group>
  );
}

/** A determinate bar with a percentage, else a quiet spinner with the step. */
export function ProgressRow({ label, percent }: { label: string; percent: number | null }) {
  const c = useColors();
  return (
    <View style={[styles.row, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {percent === null ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
        <T variant="callout" style={{ flex: 1, fontWeight: "500" }} numberOfLines={2}>
          {label}
        </T>
        {percent !== null ? (
          <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
            {Math.floor(percent)}%
          </T>
        ) : null}
      </View>
      {percent !== null ? (
        <View style={[styles.track, { backgroundColor: c.sunken }]}>
          <View style={[styles.fill, { width: `${Math.max(2, Math.min(100, percent))}%`, backgroundColor: c.brand }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    width: "100%",
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
  track: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  fill: {
    height: 4,
    borderRadius: 2,
  },
});
