import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ClaudeAccount, ClaudeAccountLogin, ClaudeAccountsState, ClaudeUsageWindow } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, StepperRow, SwitchRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { SignInSteps } from "@/components/program-parts";
import { FormSkeleton, QueryState } from "@/components/settings-state";
import { useMenuSheet } from "@/components/header-actions";
import { SettingsScroll } from "@/components/settings-scroll";
import { Badge, Card, Row, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { intlLocale, t as translate } from "@/lib/i18n";
import { programsApi } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

const THRESHOLDS = [50, 60, 70, 75, 80, 85, 90, 95, 100] as const;

const planLabel = (plan: string | null) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null);

function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(intlLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

const setLogin = (login: ClaudeAccountLogin) => queryClient.setQueryData<ClaudeAccountsState>(sq.claudeAccounts, (s) => (s ? { ...s, login } : s));
const setList = (accounts: ClaudeAccount[]) => queryClient.setQueryData<ClaudeAccountsState>(sq.claudeAccounts, (s) => (s ? { ...s, accounts } : s));

/**
 * Claude subscriptions agents run on: usage, the default, and when work moves to another one. A full-access phone also
 * adds accounts, signs them in again and removes them, like the desktop app; on the others that happens on the computer.
 */
export default function ClaudeAccounts() {
  const { t } = useTranslation(["settings", "common", "programs"]);
  const menu = useMenuSheet();
  const admin = useFullAccess().fullAccess === true;
  const accounts = useQuery({
    queryKey: sq.claudeAccounts,
    queryFn: settingsApi.claudeAccounts.list,
    refetchInterval: (q) => (q.state.data?.login.state === "waiting" ? 1500 : false),
  });
  const settings = useSettings();
  const [refreshing, setRefreshing] = useState(false);
  const makeDefault = useMutation({
    mutationFn: settingsApi.claudeAccounts.setDefault,
    onMutate: (id: string) =>
      queryClient.setQueryData<ClaudeAccountsState>(sq.claudeAccounts, (s) => (s ? { ...s, accounts: s.accounts.map((a) => ({ ...a, isDefault: a.id === id })) } : s)),
    onSuccess: (list) => queryClient.setQueryData<ClaudeAccountsState>(sq.claudeAccounts, (s) => (s ? { ...s, accounts: list } : s)),
    onError: (err) => {
      void queryClient.invalidateQueries({ queryKey: sq.claudeAccounts });
      Alert.alert(t("accounts.defaultFailed"), errorText(err));
    },
  });
  const refresh = async () => {
    setRefreshing(true);
    try {
      queryClient.setQueryData(sq.claudeAccounts, await settingsApi.claudeAccounts.refresh());
      await settings.refetch();
    } catch {
      await accounts.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  const startLogin = useMutation({
    mutationFn: programsApi.accounts.startLogin,
    onSuccess: setLogin,
    onError: (err) => Alert.alert(t("programs:signIn.startFailed"), errorText(err)),
  });
  const cancelLogin = useMutation({ mutationFn: programsApi.accounts.cancelLogin, onSuccess: setLogin });
  const submitCode = useMutation({ mutationFn: programsApi.accounts.submitCode, onSuccess: setLogin });
  const sendCode = (code: string) =>
    submitCode.mutateAsync(code).then(
      () => true,
      (err: unknown) => {
        Alert.alert(t("programs:signIn.codeFailed"), errorText(err));
        return false;
      },
    );
  const remove = useMutation({
    mutationFn: programsApi.accounts.remove,
    onSuccess: setList,
    onError: (err) => Alert.alert(t("programs:accounts.removeFailed"), errorText(err)),
  });
  useLoginOutcome(accounts.data?.login);

  const actions = (a: ClaudeAccount) => {
    const name = a.email ?? t("accounts.unknown");
    const confirmRemove = () =>
      Alert.alert(t("programs:accounts.removeTitle", { email: name }), t("programs:accounts.removeBody"), [
        { text: t("common:actions.cancel"), style: "cancel" },
        { text: t("programs:accounts.remove"), style: "destructive", onPress: () => remove.mutate(a.id) },
      ]);
    const buttons = [
      ...(!a.isDefault && !a.needsSignIn ? [{ text: t("programs:accounts.makeDefault"), icon: "check" as const, onPress: () => makeDefault.mutate(a.id) }] : []),
      ...(!a.system ? [{ text: t("programs:accounts.signInAgain"), icon: "key" as const, onPress: () => startLogin.mutate(a.id) }] : []),
      ...(!a.system ? [{ text: t("programs:accounts.remove"), icon: "trash" as const, style: "destructive" as const, onPress: confirmRemove }] : []),
    ];
    if (!buttons.length) return;
    if (process.env.EXPO_OS === "android") return menu.show(buttons.map((b) => ({ icon: b.icon, title: b.text, destructive: b.style === "destructive", onPress: b.onPress })), name);
    Alert.alert(name, undefined, [...buttons, { text: t("common:actions.cancel"), style: "cancel" }]);
  };

  const r = settings.data?.runner;
  const autoSwitch = r?.accountAutoSwitch ?? true;

  return (
    <SettingsScroll
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Stack.Screen options={{ title: t("accounts.title") }} />
      <CloseButton />
      <QueryState query={accounts} icon="personCircle" errorTitle={t("accounts.loadFailed")} skeleton={<FormSkeleton groups={2} rows={2} />}>
        {(state) => {
          const extra = state.accounts.filter((a) => !a.system).length;
          const login = state.login;
          const waiting = login.state === "waiting";
          const again = waiting && login.accountId ? state.accounts.find((a) => a.id === login.accountId) : undefined;
          return (
            <>
              {state.locked && extra > 0 ? <Locked /> : null}
              <Group title={t("accounts.listTitle")} footer={admin && state.locked ? t("programs:accounts.vaultLocked") : undefined}>
                {state.accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    admin={admin}
                    busy={(makeDefault.isPending && makeDefault.variables === a.id) || (remove.isPending && remove.variables === a.id)}
                    onPress={() => (admin ? actions(a) : makeDefault.mutate(a.id))}
                  />
                ))}
                {admin && waiting ? (
                  <SignInSteps
                    key="sign-in"
                    title={again ? t("programs:accounts.signingInAgain", { email: again.email ?? t("accounts.unknown") }) : t("programs:accounts.adding")}
                    url={login.url}
                    submitting={submitCode.isPending}
                    cancelling={cancelLogin.isPending}
                    onSubmit={sendCode}
                    onCancel={() => cancelLogin.mutate()}
                  />
                ) : null}
                {admin && !waiting ? (
                  <LinkRow
                    key="add"
                    icon="plus"
                    tone="brand"
                    title={t("programs:accounts.add")}
                    value={startLogin.isPending ? t("common:status.loading") : undefined}
                    chevron={false}
                    onPress={() => !startLogin.isPending && !state.locked && startLogin.mutate(null)}
                  />
                ) : null}
              </Group>
              {r ? (
                <Group title={t("accounts.switchTitle")}>
                  <SwitchRow icon="move" title={t("accounts.autoSwitch")} value={autoSwitch} onChange={(accountAutoSwitch) => void patchSettings({ runner: { accountAutoSwitch } })} />
                  {autoSwitch ? (
                    <StepperRow
                      icon="gauge"
                      title={t("accounts.threshold")}
                      value={r.accountSwitchPercent ?? 90}
                      min={50}
                      max={100}
                      steps={THRESHOLDS}
                      format={(n) => `${n}%`}
                      onChange={(accountSwitchPercent) => void patchSettings({ runner: { accountSwitchPercent } })}
                    />
                  ) : null}
                </Group>
              ) : null}
            </>
          );
        }}
      </QueryState>
      {menu.sheet}
    </SettingsScroll>
  );
}

/** Tells how an account's sign-in ended, once it ended. */
function useLoginOutcome(login: ClaudeAccountLogin | undefined) {
  const state = login?.state ?? "idle";
  const prev = useRef(state);
  const message = login?.message ?? null;
  useEffect(() => {
    if (prev.current === "waiting" && state === "done") Alert.alert(translate("programs:accounts.added", { email: message ?? "" }));
    if (prev.current === "waiting" && state === "failed") Alert.alert(translate("programs:signIn.failed"), message ?? undefined);
    prev.current = state;
  }, [state, message]);
}

function Locked() {
  const c = useColors();
  const { t } = useTranslation("settings");
  return (
    <Card style={[styles.locked, { backgroundColor: c.warningSoft }]}>
      <Icon name="lock" size={16} color={c.warning} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }}>
          {t("accounts.lockedTitle")}
        </T>
        <T variant="footnote" muted>
          {t("accounts.lockedBody")}
        </T>
      </View>
    </Card>
  );
}

function AccountRow({ account: a, admin, busy, onPress }: { account: ClaudeAccount; admin: boolean; busy: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["settings", "programs"]);
  const name = a.email ?? (a.system ? t("accounts.thisComputer") : t("accounts.unknown"));
  const plan = planLabel(a.plan);
  const subtitle = a.needsSignIn ? (
    <T variant="footnote" color={c.danger} numberOfLines={2}>
      {admin ? t("programs:accounts.signedOut") : t("accounts.signedOut")}
    </T>
  ) : a.limitedUntil ? (
    <T variant="footnote" color={c.warning} numberOfLines={1}>
      {t("accounts.limitedUntil", { time: timeOf(a.limitedUntil) })}
    </T>
  ) : (
    <T variant="footnote" muted numberOfLines={1}>
      {a.system ? t("accounts.systemLogin") : a.organization || a.name || t("accounts.addedHere")}
    </T>
  );
  const selectable = admin ? !a.system || !a.isDefault : !a.isDefault && !a.needsSignIn;
  return (
    <Pressable
      accessibilityRole={admin ? "button" : "radio"}
      accessibilityState={{ checked: a.isDefault, disabled: !selectable }}
      accessibilityHint={selectable && !admin ? t("accounts.makeDefaultHint") : undefined}
      disabled={!selectable || busy}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.account, pressed && { backgroundColor: c.sunken }]}
    >
      <Row style={{ gap: space.md }}>
        <View style={[styles.avatar, { backgroundColor: a.isDefault ? c.brandSoft : c.sunken }]}>
          <Icon name={a.system ? "display" : "personCircle"} size={16} color={a.isDefault ? c.brandStrong : c.text} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Row style={{ gap: space.sm }}>
            <T variant="callout" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
              {name}
            </T>
            {plan ? <Badge label={plan} dot={false} /> : null}
          </Row>
          {subtitle}
        </View>
        {busy ? <ActivityIndicator size="small" /> : a.isDefault ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
      </Row>
      <View style={styles.meters}>
        {!(a.usage?.state === "ok" && !a.usage.fiveHour) ? <Meter label={t("accounts.session")} window={a.usage?.fiveHour ?? null} /> : null}
        <Meter label={t("accounts.week")} window={a.usage?.week ?? null} />
      </View>
    </Pressable>
  );
}

function Meter({ label, window }: { label: string; window: ClaudeUsageWindow | null }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const percent = Math.round(window?.percent ?? 0);
  const fill = percent >= 90 ? c.danger : percent >= 75 ? c.warning : c.textMuted;
  return (
    <View style={{ gap: 3 }}>
      <Row style={{ gap: space.sm }}>
        <T variant="caption" muted style={{ width: 64 }}>
          {label}
        </T>
        <View style={[styles.track, { backgroundColor: c.sunken }]}>
          <View style={[styles.fill, { width: `${window ? Math.max(2, Math.min(100, percent)) : 0}%`, backgroundColor: fill }]} />
        </View>
        <T variant="caption" style={styles.percent}>
          {window ? `${percent}%` : "–"}
        </T>
      </Row>
      {window?.resetsAt ? (
        <T variant="caption" muted style={{ marginLeft: 64 + space.sm }}>
          {t("accounts.resets", { time: timeOf(window.resetsAt) })}
        </T>
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
  locked: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
  },
  account: {
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    gap: space.md,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  meters: {
    gap: 6,
    paddingLeft: 30 + space.md,
  },
  track: {
    flex: 1,
    height: 5,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: radius.pill,
  },
  percent: {
    width: 36,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
});
