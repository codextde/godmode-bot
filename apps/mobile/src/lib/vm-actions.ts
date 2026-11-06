import { ActionSheetIOS, Alert } from "react-native";
import type { Vm } from "@godmode/shared";
import { api, errorText } from "./api";
import { t } from "./i18n";
import { qk, queryClient } from "./query";

export type VmAction = "start" | "stop" | "suspend" | "restart";

/** What a VM can do from where it is: a running one suspends, restarts or stops; a stopped or suspended one starts. */
export function vmActions(vm: Pick<Vm, "state">): VmAction[] {
  if (vm.state === "running") return ["suspend", "restart", "stop"];
  if (vm.state === "stopped" || vm.state === "suspended") return ["start"];
  return [];
}

export async function runVmAction(vm: Pick<Vm, "id">, action: VmAction): Promise<void> {
  try {
    const next = await api.vms[action](vm.id);
    queryClient.setQueryData<Vm[]>(qk.vms, (all) => all?.map((v) => (v.id === next.id ? next : v)));
  } catch (err) {
    Alert.alert(t("integrations:vm.failed"), errorText(err));
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.vms });
  }
}

/** The VM's power menu: the system action sheet on iOS, an alert's buttons on Android. */
export function showVmMenu(vm: Pick<Vm, "id" | "name" | "state">, onAction?: (action: VmAction) => void) {
  const actions = vmActions(vm);
  if (!actions.length) return;
  const run = (action: VmAction) => (onAction ? onAction(action) : void runVmAction(vm, action));
  const labels = actions.map((a) => t(`integrations:vm.${a}`));
  if (process.env.EXPO_OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: vm.name,
        message: vm.state === "running" ? t("integrations:vm.interrupts") : undefined,
        options: [...labels, t("common:actions.cancel")],
        cancelButtonIndex: labels.length,
        destructiveButtonIndex: actions.indexOf("stop") >= 0 ? actions.indexOf("stop") : undefined,
      },
      (i) => {
        if (i < actions.length) run(actions[i]!);
      },
    );
    return;
  }
  Alert.alert(vm.name, vm.state === "running" ? t("integrations:vm.interrupts") : undefined, actions.map((a, i) => ({ text: labels[i], style: a === "stop" ? "destructive" : "default", onPress: () => run(a) })), { cancelable: true });
}
