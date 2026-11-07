import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import { SwitchRow } from "@/components/form";
import { useFullAccess } from "@/components/full-access";
import { InfoRow } from "@/components/status-rows";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/query";

/** A phone without full access reads, but doesn't change, what an agent that reads raw secrets is told and remembers. */
export function useRevealLocked(agent: { permissions: { secretAccess: string } } | undefined): boolean {
  const { fullAccess } = useFullAccess();
  return fullAccess === false && agent?.permissions.secretAccess === "reveal";
}

/**
 * Settings: whether the computer gave this phone full access, and switching it off from here (only the computer turns
 * it on). One row of a Group.
 */
export function ThisPhoneAccess() {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const off = useMutation({
    mutationFn: () => api.setFullAccess(false),
    onSuccess: (session) => {
      qc.setQueryData(qk.me, session);
      // What the phone read with full access goes: lists come back without their secrets.
      void qc.invalidateQueries();
    },
    onError: (err) => Alert.alert(t("overview.fullAccess.offFailed"), errorText(err)),
  });
  const full = me.data?.fullAccess;

  const confirm = () =>
    Alert.alert(t("overview.fullAccess.offTitle"), t("overview.fullAccess.offBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("overview.fullAccess.offConfirm"), style: "destructive", onPress: () => off.mutate() },
    ]);

  if (full) {
    return <SwitchRow icon="lockOpen" title={t("overview.fullAccess.title")} value={!off.isPending} disabled={off.isPending} onChange={(next) => !next && confirm()} />;
  }
  return <InfoRow icon="lock" label={t("overview.fullAccess.title")} value={full === false ? t("common:status.off") : undefined} />;
}
