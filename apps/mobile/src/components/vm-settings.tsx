import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { VmSettings } from "@godmode/shared";
import { FieldRow, Group, LinkRow, SwitchRow } from "./form";
import { ActionPill, ToolRow } from "./program-parts";
import { InfoRow } from "./status-rows";
import { T } from "./ui";
import { adminApi, patchAnySettings, withVaultGrant } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { formatGb, machinesApi, mk } from "@/lib/machines";
import { qk, queryClient } from "@/lib/query";
import { space } from "@/lib/theme";

/** What the desktop's VM settings add for a full-access phone: the VMs, the host shell, fills into VMs. Rows for a Group. */
export function useVmAccessRows(vm: VmSettings | undefined) {
  const { t } = useTranslation("machines");
  if (!vm) return [];
  const setVaultFill = (on: boolean) => {
    if (!on) return void patchAnySettings({ vm: { vaultFill: false } });
    void withVaultGrant(t("vmSettings.fillFailed"), async (grant) => queryClient.setQueryData(qk.settings, await adminApi.security.settings({ vm: { vaultFill: true } }, grant)));
  };
  return [
    <SwitchRow key="isolate" icon="shield" title={t("vmSettings.isolate")} detail={t("vmSettings.isolateDetail")} disabled={!vm.enabled} value={vm.isolateHostShell} onChange={(isolateHostShell) => void patchAnySettings({ vm: { isolateHostShell } })} />,
    <SwitchRow key="fill" icon="key" title={t("vmSettings.fill")} disabled={!vm.enabled} value={vm.vaultFill} onChange={setVaultFill} />,
    <LinkRow key="manage" icon="vm" title={t("vms.title")} onPress={() => router.push("/settings/vms")} />,
  ];
}

/** Tart, which runs the VMs: its state, its path, and the downloaded images that take space. */
export function TartGroup({ vm }: { vm: VmSettings }) {
  const { t } = useTranslation(["machines", "common", "programs"]);
  const status = useQuery({ queryKey: mk.vmStatus, queryFn: machinesApi.vms.status });
  const [removing, setRemoving] = useState<string | null>(null);
  const s = status.data;
  if (!s) return null;
  const tart = s.tart;
  const downloaded = s.images.filter((i) => i.downloaded);

  const remove = (id: string, name: string, size: number | null) =>
    Alert.alert(t("vmSettings.removeImageTitle", { name }), size ? t("vmSettings.removeImageBody", { size: formatGb(size) }) : t("vmSettings.removeImageBodyPlain"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.remove"),
        style: "destructive",
        onPress: async () => {
          setRemoving(id);
          try {
            await machinesApi.vms.removeImage(id);
            await queryClient.invalidateQueries({ queryKey: mk.vmStatus });
          } catch (err) {
            Alert.alert(t("vmSettings.removeImageFailed"), errorText(err));
          } finally {
            setRemoving(null);
          }
        },
      },
    ]);

  const saveTartPath = (tartPath: string) =>
    void patchAnySettings({ vm: { tartPath: tartPath.trim() } }).then((ok) => {
      if (ok) void queryClient.invalidateQueries({ queryKey: qk.vms });
    });

  return (
    <Group title="Tart" footer={t("vmSettings.tartPathFooter")}>
      <InfoRow
        label={t("android.adbState")}
        value={
          tart.installed
            ? [tart.version ? `Tart ${tart.version}` : t("android.installed"), tart.managed ? t("android.ownCopy") : t("android.found")].join(" · ")
            : s.supported
              ? t("programs:notInstalled")
              : t("vms.unsupported")
        }
        tone={tart.installed ? "success" : "warning"}
      />
      {tart.path ? (
        <View style={styles.path}>
          <T variant="mono" muted selectable numberOfLines={2}>
            {tart.path}
          </T>
        </View>
      ) : null}
      {downloaded.map((img) => (
        <ToolRow
          key={img.id}
          title={img.name}
          detail={img.sizeBytes ? t("vmSettings.imageSize", { size: formatGb(img.sizeBytes) }) : t("vmSettings.image")}
          action={<ActionPill tone="danger" label={t("common:actions.remove")} busy={removing === img.id} onPress={() => remove(img.id, img.name, img.sizeBytes)} />}
        />
      ))}
      <FieldRow label={t("vmSettings.tartPath")} value={vm.tartPath} placeholder={t("android.automatic")} stacked maxLength={4096} onCommit={saveTartPath} />
    </Group>
  );
}

const styles = StyleSheet.create({
  path: {
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
