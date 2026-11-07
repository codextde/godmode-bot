import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Vm, VmPatch, VmStatus } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, Group, PickerRow, StepperRow, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { InfoRow } from "@/components/status-rows";
import { TextRow } from "@/components/tool-form";
import { Icon } from "@/components/icon";
import { EmptyState, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { defaultSpecs, diskValid, displayOptions, formatDisplay, formatMemory, leave, machinesApi, MAX_DISK_GB, MAX_VM_NAME, memoryOptions, mk, nextVmName, putVm } from "@/lib/machines";
import { qk } from "@/lib/query";
import { space, useColors } from "@/lib/theme";

/** A new VM, or a VM's name and hardware, like the desktop's New VM and Edit dialogs (full access). */
export default function VmEdit() {
  const { t } = useTranslation("machines");
  const { id } = useLocalSearchParams<{ id?: string }>();
  const status = useQuery({ queryKey: mk.vmStatus, queryFn: machinesApi.vms.status });
  const list = useQuery({ queryKey: qk.vms, queryFn: api.vms.list });
  const vm = id ? list.data?.find((v) => v.id === id) : undefined;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: id ? (vm ? t("edit.title", { name: vm.name }) : "") : t("edit.newTitle"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <AdminQueryState query={status} errorTitle={t("vms.checkFailed")}>
          {(s) => (
            <AdminQueryState query={list} errorTitle={t("vms.loadFailed")}>
              {(vms) => {
                if (!id) return <Form status={s} vms={vms} vm={null} />;
                const found = vms.find((v) => v.id === id);
                return found ? <Form key={found.id} status={s} vms={vms} vm={found} /> : <EmptyState style={styles.state} icon="vm" title={t("vm.gone")} />;
              }}
            </AdminQueryState>
          )}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Form({ status, vms, vm }: { status: VmStatus; vms: Vm[]; vm: Vm | null }) {
  const { t } = useTranslation(["machines", "common", "tools"]);
  const c = useColors();
  const navigation = useNavigation();
  const presets = status.images;
  const recommended = presets.find((p) => p.recommended) ?? presets[0];
  const defaults = useMemo(() => defaultSpecs(status.host), [status.host]);
  const [name, setName] = useState(vm?.name ?? nextVmName(vms));
  const [imageId, setImageId] = useState(recommended?.id ?? "");
  const [cpu, setCpu] = useState(vm?.cpu ?? defaults.cpu);
  const [memoryMb, setMemoryMb] = useState(vm?.memoryMb ?? defaults.memoryMb);
  const [display, setDisplay] = useState(vm?.display ?? "1440x900");
  const [disk, setDisk] = useState(String(vm?.diskGb ?? recommended?.diskGb ?? 50));
  const [diskTouched, setDiskTouched] = useState(false);
  const [start, setStart] = useState(true);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const exit = useRef<Parameters<typeof navigation.dispatch>[0] | null>(null);

  const preset = presets.find((p) => p.id === imageId) ?? recommended;
  const host = status.host;
  const minDisk = vm ? vm.diskGb : (preset?.diskGb ?? 20);
  const suspended = vm?.state === "suspended";
  const canResize = !vm || vm.state === "stopped";
  const bootsLater = vm?.state === "running" || vm?.state === "starting";
  const cpus = Math.max(host.cpus, cpu);

  const patch: VmPatch = {};
  if (vm) {
    if (name.trim() !== vm.name) patch.name = name.trim();
    if (!suspended) {
      if (cpu !== vm.cpu) patch.cpu = cpu;
      if (memoryMb !== vm.memoryMb) patch.memoryMb = memoryMb;
      if (display !== vm.display) patch.display = display;
    }
    if (canResize && Number(disk) !== vm.diskGb) patch.diskGb = Number(disk);
  }
  const dirty = !leaving && (vm ? Object.keys(patch).length > 0 : true);
  const diskGb = Number(disk);
  const needGb = (preset && !preset.downloaded ? preset.downloadGb : 0) + (Number.isFinite(diskGb) ? diskGb : minDisk);
  const free = host.freeDiskGb;
  const tight = !vm && free !== null && free < needGb;

  useEffect(() => {
    if (!leaving) return;
    if (exit.current) navigation.dispatch(exit.current);
    else leave("/settings/vms");
  }, [leaving, navigation]);

  usePreventRemove(dirty && !!vm, ({ data }) => {
    Alert.alert(t("tools:discard.title"), undefined, [
      { text: t("tools:discard.keep"), style: "cancel" },
      {
        text: t("tools:discard.discard"),
        style: "destructive",
        onPress: () => {
          exit.current = data.action;
          setLeaving(true);
        },
      },
    ]);
  });

  const pickImage = (next: string) => {
    setImageId(next);
    const p = presets.find((x) => x.id === next);
    if (p && (!diskTouched || Number(disk) < p.diskGb)) setDisk(String(p.diskGb));
  };

  const problem = (): string | null => {
    if (!name.trim()) return t("edit.nameMissing");
    if (canResize && !diskValid(disk, minDisk)) return t("edit.diskInvalid", { min: minDisk, max: MAX_DISK_GB });
    if (!vm && !preset) return t("edit.imageMissing");
    return null;
  };

  const save = async () => {
    if (saving) return;
    const wrong = problem();
    if (wrong) return Alert.alert(t("edit.checkTitle"), wrong);
    if (vm && !Object.keys(patch).length) return setLeaving(true);
    setSaving(true);
    try {
      if (vm) {
        putVm(await machinesApi.vms.update(vm.id, patch));
      } else {
        const created = await machinesApi.vms.create({ name: name.trim(), image: preset!.image, cpu, memoryMb, diskGb, display, start });
        putVm(created);
        Alert.alert(
          t("edit.creating", { name: created.name }),
          preset!.downloaded ? (start ? t("edit.readyBooting") : t("edit.ready")) : t("edit.downloading", { image: preset!.name, size: Math.round(preset!.downloadGb) }),
        );
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setLeaving(true);
    } catch (err) {
      Alert.alert(vm ? t("edit.saveFailed") : t("edit.createFailed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const diskRow = canResize ? (
    <TextRow
      label={t("edit.disk")}
      value={disk}
      onChange={(v) => {
        setDisk(v.replace(/\D/g, "").slice(0, 4));
        setDiskTouched(true);
      }}
      placeholder={String(minDisk)}
      keyboardType="number-pad"
      mono
    />
  ) : (
    <InfoRow label={t("edit.disk")} detail={t("edit.diskStop")} value={`${vm?.diskGb ?? minDisk} GB`} />
  );

  const hardwareFooter = vm
    ? suspended
      ? t("edit.suspended")
      : bootsLater
        ? t("edit.bootsLater")
        : canResize
          ? t("edit.diskGrow")
          : undefined
    : t("edit.diskMin", { n: minDisk });

  const spaceNote =
    free === null
      ? t("edit.freeUnknown")
      : tight
        ? preset && !preset.downloaded
          ? t("edit.tightDownload", { free, download: Math.round(preset.downloadGb), disk: diskGb || minDisk })
          : t("edit.tightDisk", { free, disk: diskGb || minDisk })
        : t("edit.free", { n: free });

  return (
    <>
      <HeaderActions actions={dirty || !vm ? [{ icon: "check", label: vm ? t("common:actions.save") : t("edit.create"), prominent: true, onPress: () => void save() }] : []} />

      <Group>
        <TextRow label={t("edit.name")} value={name} onChange={setName} placeholder={t("edit.namePlaceholder")} maxLength={MAX_VM_NAME} />
      </Group>

      {!vm ? (
        <Group title={t("edit.image")}>
          {presets.map((p) => (
            <ChoiceRow
              key={p.id}
              icon={p.downloaded ? "checkCircle" : "vm"}
              title={p.recommended ? `${p.name} · ${t("edit.recommended")}` : p.name}
              detail={[
                status.downloads[p.image] !== undefined
                  ? status.downloads[p.image] !== null
                    ? t("edit.downloadingNow", { percent: Math.floor(status.downloads[p.image]!) })
                    : t("edit.downloadingUnknown")
                  : p.downloaded
                    ? t("edit.downloaded")
                    : t("edit.downloadSize", { n: Math.round(p.downloadGb) }),
                t("edit.diskSize", { n: p.diskGb }),
              ].join(" · ")}
              selected={p.id === preset?.id}
              onPress={() => pickImage(p.id)}
            />
          ))}
        </Group>
      ) : null}

      <Group title={t("edit.hardware")} footer={hardwareFooter}>
        {!suspended ? (
          <StepperRow icon="cpu" title={t("vm.cpu")} value={cpu} min={1} max={cpus} format={(n) => t("vm.cores", { count: n })} onChange={setCpu} />
        ) : null}
        {!suspended ? (
          <PickerRow
            icon="gauge"
            title={t("vm.memory")}
            value={String(memoryMb)}
            options={memoryOptions(host.memoryMb, memoryMb).map((mb) => ({ value: String(mb), label: formatMemory(mb) }))}
            onChange={(v) => setMemoryMb(Number(v))}
          />
        ) : null}
        {!suspended ? (
          <PickerRow
            icon="display"
            title={t("vm.display")}
            value={display}
            options={displayOptions(display).map((d) => ({ value: d, label: formatDisplay(d) }))}
            onChange={setDisplay}
          />
        ) : null}
        {diskRow}
      </Group>

      {!vm ? (
        <Group footer={tight ? undefined : spaceNote}>
          <SwitchRow icon="play" title={t("edit.startWhenReady")} value={start} onChange={setStart} />
          {tight ? (
            <View style={styles.warning}>
              <Icon name="warning" size={15} color={c.warning} />
              <T variant="footnote" color={c.warning} style={{ flex: 1 }}>
                {spaceNote}
              </T>
            </View>
          ) : null}
        </Group>
      ) : null}

      {saving ? (
        <View style={styles.saving}>
          <ActivityIndicator color={c.textMuted} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  state: {
    paddingTop: 60,
  },
  saving: {
    alignItems: "center",
  },
  warning: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
