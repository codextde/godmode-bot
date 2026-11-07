import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, StyleSheet, Switch } from "react-native";
import { useTranslation } from "react-i18next";
import { useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { Row, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/query";
import { space, useColors } from "@/lib/theme";

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
  const c = useColors();
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

  return (
    <Row style={styles.row}>
      <Icon name={full ? "lockOpen" : "lock"} size={18} color={c.textMuted} />
      <T variant="subhead" style={{ flex: 1 }}>
        {t("overview.fullAccess.title")}
      </T>
      {full ? (
        <Switch
          accessibilityLabel={t("overview.fullAccess.title")}
          value={!off.isPending}
          disabled={off.isPending}
          onValueChange={(next) => {
            if (next) return;
            tap();
            confirm();
          }}
          trackColor={{ true: c.brand, false: c.sunken }}
          style={{ alignSelf: "center" }}
        />
      ) : full === false ? (
        <T variant="subhead" muted>
          {t("common:status.off")}
        </T>
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: 8,
  },
});
