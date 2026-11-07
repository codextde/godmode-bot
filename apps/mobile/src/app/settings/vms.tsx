import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Vm, VmStatus } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { ActionPill, reportInstall, ToolRow } from "@/components/program-parts";
import { ListRow } from "@/components/readonly-list";
import { FormSkeleton } from "@/components/settings-state";
import { VmStateBadge } from "@/components/vm-parts";
import { Button, EmptyState, ErrorState, LiveDot, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { formatMemory, imageName, machinesApi, mk } from "@/lib/machines";
import { programsApi } from "@/lib/programs";
import { qk, queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

/** macOS VMs agents work in, like the desktop's VMs page: made, started, opened and managed here (full access). */
export default function Vms() {
  const { t } = useTranslation("machines");
  const status = useQuery({ queryKey: mk.vmStatus, queryFn: machinesApi.vms.status });
  const pull = usePullRefresh(() => Promise.all([status.refetch(), queryClient.invalidateQueries({ queryKey: qk.vms })]));
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("vms.title") }} />
      <CloseButton />
      <FullAccessGate skeleton={<FormSkeleton groups={2} rows={3} />}>
        <AdminQueryState query={status} errorTitle={t("vms.checkFailed")} skeleton={<FormSkeleton groups={2} rows={3} />}>
          {(s) => (s.supported ? <List status={s} /> : <EmptyState style={styles.state} icon="vm" title={t("vms.unsupported")} body={s.reason ?? t("vms.unsupportedBody")} />)}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function List({ status: s }: { status: VmStatus }) {
  const { t } = useTranslation(["machines", "programs"]);
  const c = useColors();
  const settings = useSettings();
  const list = useQuery({ queryKey: qk.vms, queryFn: api.vms.list });
  const install = useMutation({
    mutationFn: programsApi.installVmTools,
    onSettled: (result, err) => {
      reportInstall(err ?? result, { done: t("vms.tartReady"), failed: t("vms.tartFailed") });
      void queryClient.invalidateQueries({ queryKey: qk.vms });
    },
  });
  const vms = list.data ?? [];
  const create = () => router.push("/settings/vm-edit");
  const specs = (vm: Vm) => t("vms.specs", { count: vm.cpu, memory: formatMemory(vm.memoryMb), disk: vm.diskGb });
  const turnedOff = settings.data?.vm.enabled === false;
  const footer = [
    t("vms.running", { running: s.running, max: s.maxRunning }),
    s.host.freeDiskGb !== null ? t("vms.free", { n: s.host.freeDiskGb }) : null,
    s.tart.version ? `Tart ${s.tart.version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <HeaderActions actions={[{ icon: "plus", label: t("vms.new"), onPress: create }]} />

      {turnedOff ? (
        <Group>
          <LinkRow icon="power" title={t("vms.turnedOff")} detail={t("vms.turnedOffBody")} onPress={() => router.push("/settings/computer")} />
        </Group>
      ) : null}

      {!s.tart.installed ? (
        <Group footer={t("vms.setupBody")}>
          <ToolRow
            title={t("vms.setupTitle")}
            detail={t("programs:notInstalled")}
            action={<ActionPill label={t("vms.setUp")} busyLabel={t("vms.settingUp")} busy={install.isPending} onPress={() => install.mutate()} />}
          />
        </Group>
      ) : null}

      {list.isLoading ? (
        <FormSkeleton groups={1} rows={2} />
      ) : list.isError ? (
        <ErrorState title={t("vms.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : vms.length === 0 ? (
        <EmptyState style={styles.state} icon="vm" title={t("vms.emptyTitle")} body={t("vms.emptyBody")} action={<Button title={t("vms.new")} icon="plus" onPress={create} />} />
      ) : (
        <Group footer={footer}>
          {vms.map((vm) => (
            <ListRow
              key={vm.id}
              grouped
              lead={<VmTile vm={vm} />}
              title={vm.name}
              lines={[vm.error && vm.state === "error" ? vm.error : (vm.progress?.label ?? imageName(vm.image, s.images)), specs(vm)]}
              trailing={<VmStateBadge state={vm.state} />}
              onPress={() => router.push({ pathname: "/settings/vm", params: { id: vm.id } })}
            />
          ))}
        </Group>
      )}

      <View style={styles.storage}>
        <Icon name="folder" size={12} color={c.textFaint} />
        <T variant="footnote" muted numberOfLines={1} style={{ flexShrink: 1 }}>
          {t("vms.storedIn", { path: s.storageDir })}
        </T>
      </View>
    </>
  );
}

function VmTile({ vm }: { vm: Vm }) {
  const c = useColors();
  const running = vm.state === "running";
  return (
    <View style={[styles.tile, { backgroundColor: c.sunken }]}>
      <Icon name={vm.state === "suspended" ? "moon" : "vm"} size={17} color={running ? c.text : c.textMuted} />
      {running ? (
        <View style={[styles.dot, { backgroundColor: c.surface }]}>
          <LiveDot size={7} />
        </View>
      ) : null}
    </View>
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
  storage: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.xs,
    marginTop: -space.md,
  },
});
