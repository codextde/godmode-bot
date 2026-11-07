import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { Vm, VmImagePreset } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { HeaderActions, type HeaderMenuItem } from "@/components/header-actions";
import { InfoRow } from "@/components/status-rows";
import { ActionRow, TestResult } from "@/components/tool-form";
import { ProgressRow, VmCommand, VmScreen, VmUsedBy } from "@/components/vm-parts";
import { Button, EmptyState } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { dropVm, formatDisplay, formatGb, formatMemory, guestFolderLabel, imageName, leave, machinesApi, mk, putVm, vmBusy } from "@/lib/machines";
import { qk } from "@/lib/query";
import { copyPlain } from "@/lib/secrets";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";
import { runVmAction, type VmAction } from "@/lib/vm-actions";

/** One VM, like its card on the desktop: its screen, power, what it is, who uses it, a command, edit, copy, reset, delete. */
export default function VmScreenPage() {
  const { t } = useTranslation("machines");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useQuery({ queryKey: qk.vms, queryFn: api.vms.list });
  const status = useQuery({ queryKey: mk.vmStatus, queryFn: machinesApi.vms.status });
  const pull = usePullRefresh(() => Promise.all([list.refetch(), status.refetch()]));
  const vm = list.data?.find((v) => v.id === id);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: vm?.name ?? "", headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <AdminQueryState query={list} errorTitle={t("vms.loadFailed")}>
          {(vms) => {
            const found = vms.find((v) => v.id === id);
            return found ? <Body key={found.id} vm={found} vms={vms} presets={status.data?.images} /> : <EmptyState style={styles.state} icon="vm" title={t("vm.gone")} />;
          }}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Body({ vm, vms, presets }: { vm: Vm; vms: Vm[]; presets: VmImagePreset[] | undefined }) {
  const { t } = useTranslation(["machines", "common", "integrations"]);
  const [busy, setBusy] = useState<string | null>(null);
  const s = vm.state;
  const running = s === "running";
  const working = vmBusy(s);

  const power = async (action: VmAction) => {
    setBusy(action);
    await runVmAction(vm, action);
    setBusy(null);
  };

  const job = async (name: string, failed: string, call: () => Promise<void>) => {
    setBusy(name);
    try {
      await call();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      Alert.alert(failed, errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const duplicate = () => {
    if (s !== "stopped") return Alert.alert(t("vm.duplicateStopFirst"), s === "suspended" ? t("vm.duplicateShutDown") : undefined);
    void job("duplicate", t("vm.duplicateFailed", { name: vm.name }), async () => {
      const copy = await machinesApi.vms.duplicate(vm.id);
      putVm(copy);
      router.replace({ pathname: "/settings/vm", params: { id: copy.id } });
    });
  };

  const reset = () => {
    const body = [
      t("vm.resetBody", { image: imageName(vm.image, presets) }),
      running || s === "suspended" ? t("vm.resetShutsDown") : null,
      t("vm.resetKeeps", { folder: guestFolderLabel(vm) }),
    ]
      .filter(Boolean)
      .join(" ");
    const go = (start: boolean) => void job("reset", t("vm.resetFailed", { name: vm.name }), async () => putVm(await machinesApi.vms.reset(vm.id, start)));
    Alert.alert(t("vm.resetTitle", { name: vm.name }), body, [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("vm.resetAndStart"), onPress: () => go(true) },
      { text: t("vm.reset"), style: "destructive", onPress: () => go(false) },
    ]);
  };

  const remove = () => {
    const users = vm.assignments.length;
    const body = [
      s === "creating" ? t("vm.deleteCreating") : vm.diskUsageBytes ? t("vm.deleteSize", { size: formatGb(vm.diskUsageBytes) }) : t("vm.deleteBody"),
      users === 1 ? t("vm.deleteOneUser", { name: vm.assignments[0]?.name || t("vm.untitledChat") }) : null,
      users > 1 ? t("vm.deleteManyUsers", { count: users }) : null,
    ]
      .filter(Boolean)
      .join(" ");
    const go = (keepFiles: boolean) =>
      void job("delete", t("vm.deleteFailed", { name: vm.name }), async () => {
        await machinesApi.vms.remove(vm.id, keepFiles);
        dropVm(vm.id);
        leave("/settings/vms");
      });
    Alert.alert(t("vm.deleteTitle", { name: vm.name }), body, [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("vm.deleteKeepFiles"), onPress: () => go(true) },
      { text: t("vm.delete"), style: "destructive", onPress: () => go(false) },
    ]);
  };

  const menu: HeaderMenuItem[] = [
    ...(working ? [] : [{ icon: "pencil" as const, title: t("vm.edit"), onPress: () => router.push({ pathname: "/settings/vm-edit", params: { id: vm.id } }) }]),
    ...(s === "creating" || s === "error" ? [] : [{ icon: "copy" as const, title: t("vm.duplicate"), onPress: duplicate }]),
    ...(working ? [] : [{ icon: "refresh" as const, title: t("vm.resetMenu"), onPress: reset }]),
    { icon: "trash", title: t("vm.delete"), destructive: true, onPress: remove },
  ];

  const startLabel = s === "suspended" ? t("vm.resume") : t("integrations:vm.start");

  return (
    <>
      <HeaderActions menu={menu} />

      <VmScreen
        vm={vm}
        action={
          s === "stopped" || s === "suspended" ? (
            <Button title={startLabel} icon="play" variant="outline" loading={busy === "start"} onPress={() => void power("start")} style={{ marginTop: space.sm }} />
          ) : undefined
        }
      />

      {vm.progress || working ? (
        <Group>
          <ProgressRow label={vm.progress?.label ?? (s === "stopping" ? t("vm.shuttingDown") : s === "starting" ? t("vm.startingMacos") : t("vm.preparing"))} percent={vm.progress?.percent ?? null} />
        </Group>
      ) : null}

      {vm.error && !working ? (
        <Group>
          <TestResult ok={false} title={t("vm.problem")} body={vm.error} />
          {s === "error" ? <ActionRow icon="refresh" title={t("vm.reset")} busy={busy === "reset"} onPress={reset} /> : null}
        </Group>
      ) : null}

      {running || s === "suspended" || s === "starting" ? (
        <Group>
          {s === "suspended" ? <ActionRow icon="play" title={startLabel} busy={busy === "start"} onPress={() => void power("start")} /> : null}
          {running ? <ActionRow icon="moon" title={t("integrations:vm.suspend")} busy={busy === "suspend"} onPress={() => void power("suspend")} /> : null}
          {running ? <ActionRow icon="refresh" title={t("integrations:vm.restart")} busy={busy === "restart"} onPress={() => void power("restart")} /> : null}
          <ActionRow icon="power" title={s === "suspended" ? t("vm.shutDown") : t("integrations:vm.stop")} tone="danger" busy={busy === "stop"} onPress={() => void power("stop")} />
        </Group>
      ) : null}

      <Group title={t("vm.details")}>
        <InfoRow label={t("vm.image")} value={imageName(vm.image, presets)} />
        <InfoRow label={t("vm.cpu")} value={t("vm.cores", { count: vm.cpu })} />
        <InfoRow label={t("vm.memory")} value={formatMemory(vm.memoryMb)} />
        <InfoRow label={t("vm.disk")} value={vm.diskUsageBytes !== null ? t("vm.diskUsed", { size: vm.diskGb, used: formatGb(vm.diskUsageBytes) }) : `${vm.diskGb} GB`} />
        <InfoRow label={t("vm.display")} value={formatDisplay(vm.display)} />
        {running && vm.ip ? (
          <Pressable accessibilityRole="button" accessibilityHint={t("vm.copyIp")} onPress={() => void copyPlain(vm.ip!)}>
            <InfoRow label={t("vm.ip")} value={vm.ip} mono />
          </Pressable>
        ) : null}
        <InfoRow label={t("vm.sharedFolder")} value={guestFolderLabel(vm)} mono />
        <InfoRow label={t("vm.user")} value={vm.guestUser} mono />
      </Group>

      <VmUsedBy vm={vm} vms={vms} />

      {running ? <VmCommand vm={vm} /> : null}
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
});
