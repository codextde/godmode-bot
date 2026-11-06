import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { Hairline, Row, T, tap } from "@/components/ui";
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
 * it on). One row of a Group, two while it is on.
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
    <>
      <Row style={styles.row}>
        <Icon name={full ? "lockOpen" : "lock"} size={18} color={c.textMuted} />
        <T variant="subhead" style={{ flex: 1 }}>
          {t("overview.fullAccess.title")}
        </T>
        {full !== undefined ? (
          <T variant="subhead" muted>
            {full ? t("common:status.on") : t("common:status.off")}
          </T>
        ) : null}
      </Row>
      {full ? (
        <>
          <Hairline inset={space.lg} />
          <Pressable
            accessibilityRole="button"
            disabled={off.isPending}
            onPress={() => {
              tap();
              confirm();
            }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
          >
            <T variant="subhead" style={{ color: c.danger, opacity: off.isPending ? 0.5 : 1 }}>
              {t("overview.fullAccess.turnOff")}
            </T>
          </Pressable>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
});
