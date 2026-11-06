import { useMutation } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Credential } from "@godmode/shared";
import { Group, Tile } from "@/components/form";
import { confirmWithBiometrics, NeedsFullAccessScreen, useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { confirmDelete, CopyButton, CountdownRing, IconButton, SecretRow, ValueRow } from "@/components/secret-parts";
import { Button, EmptyState, Row, Skeleton, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { copyPlain, copySecret, formatCode, isCancelled, maskedCode, reveal, useLiveCodes, useRevealed } from "@/lib/secrets";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fullVaultApi, isVaultLocked, loginHost, normalizeUrl, refreshVault, useLogins, useTotp, vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

const PASSWORD_MS = 30_000;
const CODE_MS = 60_000;

/** One login, like the desktop's row and its dialog: copy the username, reveal or copy the password and 2FA code. */
export default function LoginDetail() {
  const { t } = useTranslation(["vault", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fullAccess } = useFullAccess();
  const logins = useLogins();
  const pull = usePullRefresh(() => queryClient.invalidateQueries({ queryKey: vk.all }));
  const login = logins.data?.find((l) => l.id === id);

  if (fullAccess === false) {
    return (
      <>
        <Stack.Screen options={{ title: t("logins.title"), headerLargeTitleEnabled: false }} />
        <NeedsFullAccessScreen />
      </>
    );
  }
  if (!login) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: t("logins.title"), headerLargeTitleEnabled: false }} />
        {logins.isLoading || fullAccess === undefined ? <Skeleton height={180} radius={12} /> : <EmptyState icon="key" title={t("login.gone")} />}
      </View>
    );
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: login.name, headerLargeTitleEnabled: false }} />
      <HeaderActions actions={[{ icon: "pencil", label: t("common:actions.edit"), onPress: () => router.push({ pathname: "/vault/login-edit", params: { id: login.id } }) }]} />
      <LoginBody login={login} />
    </ScrollView>
  );
}

function LoginBody({ login }: { login: Credential }) {
  const { t } = useTranslation(["vault", "common"]);
  const totp = useTotp();
  const secret = useRevealed<{ password: string | null; notes: string | null }>(PASSWORD_MS);
  const [revealing, setRevealing] = useState(false);
  const host = loginHost(login);
  const entry = login.totpId ? totp.data?.find((e) => e.id === login.totpId) : undefined;
  // Only web addresses open from here: a login an agent saved could carry any other kind of link.
  const site = normalizeUrl(login.url || host);
  const openable = /^https?:\/\//i.test(site);

  const fetchSecret = () => reveal(t("login.revealReason", { name: login.name }), (grant) => fullVaultApi.revealLogin(login.id, grant));
  const failed = (err: unknown) => {
    if (!isCancelled(err)) Alert.alert(t("login.revealFailed"), errorText(err));
  };
  const showSecret = async () => {
    setRevealing(true);
    try {
      secret.show(await fetchSecret());
    } catch (err) {
      failed(err);
    } finally {
      setRevealing(false);
    }
  };
  const copyPassword = async () => {
    try {
      const password = secret.value ? secret.value.password : (await fetchSecret()).password;
      if (!password) return false;
      await copySecret(password);
      return true;
    } catch (err) {
      failed(err);
      return false;
    }
  };

  const remove = useMutation({
    mutationFn: () => fullVaultApi.deleteLogin(login.id),
    onSuccess: () => {
      refreshVault();
      router.back();
    },
    onError: (err) => Alert.alert(t("login.deleteFailed"), errorText(err)),
  });

  return (
    <>
      <Row style={{ gap: space.md, paddingHorizontal: 4 }}>
        <Tile icon="key" size={44} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="headline" numberOfLines={1}>
            {login.name}
          </T>
          {host ? (
            <T variant="footnote" muted numberOfLines={1}>
              {host}
            </T>
          ) : null}
        </View>
      </Row>

      <Group>
        <ValueRow
          label={t("login.username")}
          value={login.username || t("logins.noUsername")}
          muted={!login.username}
          trailing={login.username ? <CopyButton label={t("login.copyUsername")} copy={() => copyPlain(login.username)} /> : null}
        />
        <SecretRow
          label={t("login.password")}
          value={secret.value ? (secret.value.password ?? "") : null}
          shownAt={secret.shownAt}
          ttlMs={PASSWORD_MS}
          revealing={revealing}
          empty={login.hasPassword ? undefined : t("login.noPassword")}
          onReveal={() => void showSecret()}
          onHide={secret.hide}
          onCopy={copyPassword}
        />
        {login.totpId ? <CodeRow totpId={login.totpId} name={login.name} digits={entry?.digits} /> : null}
        {login.url || host ? (
          <ValueRow
            label={t("login.website")}
            value={host || login.url}
            onPress={openable ? () => void Linking.openURL(site) : undefined}
            trailing={openable ? <IconButton icon="external" label={t("login.openWebsite")} onPress={() => void Linking.openURL(site)} /> : null}
          />
        ) : null}
      </Group>

      <Group>
        <SecretRow
          label={t("login.notes")}
          value={secret.value ? secret.value.notes || t("login.noNotes") : null}
          shownAt={null}
          ttlMs={PASSWORD_MS}
          revealing={revealing}
          multiline
          onReveal={() => void showSecret()}
          onHide={secret.hide}
        />
        {login.tags.length ? <ValueRow label={t("login.tags")} value={login.tags.join(", ")} /> : null}
      </Group>

      <T variant="footnote" muted style={{ textAlign: "center" }}>
        {login.lastUsedAt ? t("login.lastUsed", { when: whenText(login.lastUsedAt) }) : t("login.neverUsed")}
      </T>

      <Button
        title={t("login.delete")}
        icon="trash"
        variant="danger"
        loading={remove.isPending}
        onPress={() => confirmDelete(t("login.deleteTitle", { name: login.name }), t("login.deleteBody"), t("common:actions.delete"), t("common:actions.cancel"), () => remove.mutate())}
      />
    </>
  );
}

/** The login's 2FA code: dots until Face ID, then the live code with the time it has left. */
function CodeRow({ totpId, name, digits }: { totpId: string; name: string; digits?: number }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const shown = useRevealed<true>(CODE_MS);
  const [asking, setAsking] = useState(false);
  const live = useLiveCodes(!!shown.value, [totpId]);
  const now = useNow(500);
  const code = live.codes.get(totpId);
  const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;

  const ask = async () => {
    setAsking(true);
    const ok = await confirmWithBiometrics(t("totp.revealReason", { name }));
    setAsking(false);
    if (ok) shown.show(true);
  };
  const copy = async () => {
    if (code && remaining > 0) {
      await copySecret(code.code);
      return true;
    }
    if (!(await confirmWithBiometrics(t("totp.revealReason", { name })))) return false;
    const [fresh] = await fullVaultApi.totpCodes([totpId]).catch(() => []);
    if (!fresh) return false;
    await copySecret(fresh.code);
    return true;
  };

  return (
    <View style={styles.codeRow}>
      <Row style={{ gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="footnote" muted>
            {t("login.code")}
          </T>
          <Row style={{ gap: space.sm }}>
            {shown.value && live.error && !code ? (
              <T variant="callout" color={c.danger}>
                {isVaultLocked(live.error) ? t("totp.locked") : t("totp.codesFailed")}
              </T>
            ) : (
              <T variant="headline" color={shown.value && code ? c.text : c.textMuted} style={{ fontVariant: ["tabular-nums"], letterSpacing: shown.value && code ? 1 : 2 }}>
                {shown.value && code ? formatCode(code.code) : maskedCode(digits)}
              </T>
            )}
            {shown.value && code ? <CountdownRing remaining={remaining} period={code.period} /> : null}
          </Row>
        </View>
        <IconButton icon={shown.value ? "incognito" : "eye"} label={shown.value ? t("secret.hide") : t("secret.show")} busy={asking} onPress={shown.value ? shown.hide : () => void ask()} />
        <CopyButton label={t("totp.copy", { name })} copy={copy} />
      </Row>
    </View>
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
    padding: space.lg,
    justifyContent: "center",
  },
  codeRow: {
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
