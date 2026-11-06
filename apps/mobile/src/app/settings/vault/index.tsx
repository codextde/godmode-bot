import { useMutation } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Group, LinkRow, Tile } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon, type IconName } from "@/components/icon";
import { Button, Card, EmptyState, ErrorState, Row, Skeleton, T } from "@/components/ui";
import { ApiError, errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { isOutdated, useCards, useLogins, useMacPassword, usePasskeys, useSshKeys, useTotp, useVaultStatus, vaultApi, vk } from "@/lib/vault";
import { alpha, space, useColors } from "@/lib/theme";

/**
 * The vault at a glance: locked or not, what's in it. A limited phone can only lock it; with full access it unlocks it
 * with the Godmode password too and reaches the API keys and this Mac's password.
 */
export default function Passwords() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const status = useVaultStatus();
  const logins = useLogins();
  const totp = useTotp();
  const passkeys = usePasskeys();
  const cards = useCards();
  const mac = useMacPassword();
  const sshKeys = useSshKeys();
  const settings = useSettings();
  const pull = usePullRefresh(() => Promise.all([queryClient.invalidateQueries({ queryKey: vk.all }), queryClient.invalidateQueries({ queryKey: qk.me })]));

  const lock = useMutation({
    mutationFn: vaultApi.lock,
    onSuccess: (next) => {
      queryClient.setQueryData(vk.status, next);
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (err) => Alert.alert(t("index.lockFailed"), errorText(err)),
  });
  const confirmLock = () =>
    Alert.alert(t("index.lockTitle"), t("index.lockBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("index.lockNow"), style: "destructive", onPress: () => lock.mutate() },
    ]);

  if (isOutdated(status.error)) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: t("index.title") }} />
        <EmptyState icon="key" title={t("list.outdatedTitle")} body={t("list.outdatedBody")} />
      </View>
    );
  }

  const vault = status.data;
  const count = (q: { data?: unknown[] }) => (q.data ? String(q.data.length) : undefined);
  const sshOff = sshKeys.error instanceof ApiError && sshKeys.error.code === "ssh_keys_off";
  const showCards = settings.data?.cards.enabled || !!cards.data?.length;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("index.title") }} />

      {status.isError && !vault ? (
        <ErrorState title={t("index.loadFailed")} error={errorText(status.error)} onRetry={() => void status.refetch()} />
      ) : (
        <Card style={styles.status}>
          <Row style={{ gap: space.md }}>
            <View style={[styles.lockTile, { backgroundColor: vault ? (vault.unlocked ? alpha(c.success, 0.12) : c.warningSoft) : c.sunken }]}>
              {vault ? <Icon name={vault.unlocked ? "lockOpen" : "lock"} size={20} color={vault.unlocked ? c.success : c.warning} /> : null}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              {vault ? (
                <>
                  <T variant="headline">{!vault.initialized ? t("index.notSetUp") : vault.unlocked ? t("index.unlocked") : t("index.locked")}</T>
                  <T variant="footnote" muted>
                    {!vault.initialized ? t("index.notSetUpDetail") : vault.unlocked ? t("index.unlockedDetail") : fullAccess ? t("index.lockedDetailFull") : t("index.lockedDetail")}
                  </T>
                </>
              ) : (
                <>
                  <Skeleton width="45%" height={16} />
                  <Skeleton width="70%" height={12} />
                </>
              )}
            </View>
          </Row>
          {vault?.unlocked ? <Button title={t("index.lockNow")} icon="lock" variant="outline" loading={lock.isPending} onPress={confirmLock} /> : null}
          {vault?.initialized && !vault.unlocked && fullAccess ? (
            <Button title={t("index.unlock")} icon="lockOpen" onPress={() => router.push({ pathname: "/vault/passphrase", params: { mode: "unlock" } })} />
          ) : null}
        </Card>
      )}

      <Group>
        <LinkRow icon="key" title={t("index.logins")} value={count(logins)} onPress={() => router.push("/settings/vault/logins")} />
        <LinkRow icon="shield" title={t("index.codes")} value={count(totp)} onPress={() => router.push("/settings/vault/totp")} />
        <LinkRow icon="passkey" title={t("index.passkeys")} value={count(passkeys)} onPress={() => router.push("/settings/vault/passkeys")} />
        {showCards ? <LinkRow icon="creditCard" title={t("index.cards")} value={count(cards)} onPress={() => router.push("/settings/vault/cards")} /> : null}
      </Group>

      <Group>
        {mac.data?.supported ? (
          fullAccess ? (
            <LinkRow
              icon="laptop"
              title={t("index.macPassword")}
              value={mac.data.saved ? t("index.saved") : t("index.notSaved")}
              onPress={() => router.push({ pathname: "/vault/key-edit", params: { kind: "mac" } })}
            />
          ) : (
            <InfoRow icon="laptop" label={t("index.macPassword")} value={mac.data.saved ? t("index.saved") : t("index.notSaved")} />
          )
        ) : null}
        {fullAccess ? <LinkRow icon="code" title={t("index.apiKeys")} onPress={() => router.push("/settings/vault/api-keys")} /> : null}
        {sshOff ? (
          <InfoRow icon="sshKey" label={t("index.sshKeys")} value={t("common:status.off")} />
        ) : (
          <LinkRow icon="sshKey" title={t("index.sshKeys")} value={sshKeys.data ? String(sshKeys.data.keys.length) : undefined} onPress={() => router.push("/settings/vault/ssh-keys")} />
        )}
      </Group>

      {fullAccess === false ? <NeedsFullAccess /> : null}
    </ScrollView>
  );
}

function InfoRow({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <Row style={styles.info}>
      <Tile icon={icon} />
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
        {label}
      </T>
      <T variant="subhead" muted numberOfLines={1}>
        {value}
      </T>
    </Row>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  status: {
    padding: space.lg,
    gap: space.lg,
  },
  lockTile: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  info: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
