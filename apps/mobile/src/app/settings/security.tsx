import { router, Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SecretAccessMode, Settings } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, FieldRow, Group, LinkRow, StepperRow, SwitchRow, TextEditor } from "@/components/form";
import { FormSkeleton } from "@/components/settings-state";
import { ErrorState, SectionTitle } from "@/components/ui";
import { adminApi, patchAnySettings, withVaultGrant } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useVaultStatus, vk } from "@/lib/vault";
import { space } from "@/lib/theme";

const AUTO_LOCK = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440, 10080] as const;
const RETENTION = [7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650] as const;

function minutes(n: number): string {
  if (n === 0) return translate("common:words.never");
  if (n < 60) return `${n} min`;
  if (n < 1440) return `${n / 60} h`;
  return translate("admin:security.days", { count: n / 1440 });
}

const days = (n: number) => translate("admin:security.days", { count: n });

/** Settings → Security, like the desktop: the vault, how agents use secrets, the web dashboard and the audit log. */
export default function Security() {
  const { t } = useTranslation("admin");
  const settings = useSettings();
  const vault = useVaultStatus();
  const pull = usePullRefresh(() => Promise.all([settings.refetch(), vault.refetch()]));
  const s = settings.data;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("security.title") }} />
      <CloseButton />
      <FullAccessGate skeleton={<FormSkeleton groups={3} rows={4} />}>
        {!s ? (
          settings.isError ? (
            <ErrorState title={t("security.loadFailed")} error={errorText(settings.error)} onRetry={() => void settings.refetch()} />
          ) : (
            <FormSkeleton groups={3} rows={4} />
          )
        ) : (
          <Sections settings={s} remember={vault.data?.rememberDevice} unlocked={vault.data?.unlocked} />
        )}
      </FullAccessGate>
    </ScrollView>
  );
}

function Sections({ settings: s, remember, unlocked }: { settings: Settings; remember?: boolean; unlocked?: boolean }) {
  const { t } = useTranslation(["admin", "common"]);
  const sec = s.security;
  const srv = s.server;

  const setAccess = (defaultSecretAccess: SecretAccessMode) => {
    if (defaultSecretAccess !== "reveal") return void patchAnySettings({ security: { defaultSecretAccess } });
    void withVaultGrant(t("security.saveFailed"), async (grant) => queryClient.setQueryData(qk.settings, await adminApi.security.settings({ security: { defaultSecretAccess } }, grant)));
  };

  const setRemember = (on: boolean) =>
    void withVaultGrant(t("security.saveFailed"), async (grant) => queryClient.setQueryData(vk.status, await adminApi.security.remember(on, grant)));

  const setRemote = (on: boolean) => {
    if (!on) return void patchAnySettings({ server: { remoteAccess: false } });
    Alert.alert(t("security.web.remoteTitle"), t("security.web.remoteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("security.web.remote"), style: "destructive", onPress: () => void patchAnySettings({ server: { remoteAccess: true } }) },
    ]);
  };

  return (
    <>
      <Group title={t("security.vault.title")}>
        <LinkRow
          icon={unlocked ? "lockOpen" : "lock"}
          title={t("security.vault.open")}
          value={unlocked === undefined ? undefined : unlocked ? t("security.vault.unlocked") : t("security.vault.locked")}
          onPress={() => router.push("/settings/vault")}
        />
        <LinkRow icon="key" title={t("security.vault.passphrase")} onPress={() => router.push("/settings/vault-passphrase")} />
        <SwitchRow
          icon="display"
          title={t("security.vault.remember")}
          value={!!remember}
          disabled={remember === undefined}
          onChange={setRemember}
        />
        <StepperRow
          icon="clock"
          title={t("security.vault.autoLock")}
          value={sec.autoLockMinutes}
          min={0}
          max={10080}
          steps={AUTO_LOCK}
          format={minutes}
          onChange={(autoLockMinutes) => void patchAnySettings({ security: { autoLockMinutes } })}
        />
      </Group>

      <Group title={t("security.secrets.title")} footer={sec.defaultSecretAccess === "reveal" ? t("security.secrets.revealDetail") : t("security.secrets.fillDetail")}>
        <ChoiceRow icon="sparkles" title={t("security.secrets.fill")} selected={sec.defaultSecretAccess === "fill"} onPress={() => setAccess("fill")} />
        <ChoiceRow icon="eye" title={t("security.secrets.reveal")} selected={sec.defaultSecretAccess === "reveal"} onPress={() => setAccess("reveal")} />
      </Group>

      <Group>
        <LinkRow icon="agents" title={t("security.secrets.agents")} onPress={() => router.push("/settings/secret-agents")} />
        <SwitchRow icon="incognito" title={t("security.secrets.redact")} value={sec.redactSecrets} onChange={(redactSecrets) => void patchAnySettings({ security: { redactSecrets } })} />
        <SwitchRow icon="globe" title={t("security.secrets.icons")} detail={t("security.secrets.iconsDetail")} value={sec.fetchSiteIcons} onChange={(fetchSiteIcons) => void patchAnySettings({ security: { fetchSiteIcons } })} />
        <StepperRow
          icon="history"
          title={t("security.secrets.retention")}
          value={sec.auditRetentionDays}
          min={1}
          max={3650}
          steps={RETENTION}
          format={days}
          onChange={(auditRetentionDays) => void patchAnySettings({ security: { auditRetentionDays } })}
        />
        <LinkRow icon="list" title={t("security.audit.title")} onPress={() => router.push("/settings/audit")} />
      </Group>

      <Group title={t("security.web.title")} footer={srv.remoteAccess ? `${t("security.web.exposeBody")}${srv.hasDashboardPassword ? "" : ` ${t("security.web.noPassword")}`}` : t("security.web.footer")}>
        <LinkRow
          icon="key"
          title={t("security.web.password")}
          value={srv.hasDashboardPassword ? t("security.web.passwordSet") : t("security.web.passwordNotSet")}
          onPress={() => router.push({ pathname: "/settings/dashboard-password", params: { set: srv.hasDashboardPassword ? "1" : "0" } })}
        />
        <SwitchRow icon="network" title={t("security.web.remote")} value={srv.remoteAccess} onChange={setRemote} />
        <FieldRow label={t("security.web.host")} value={srv.host} placeholder="127.0.0.1" onCommit={(host) => void patchAnySettings({ server: { host } })} />
        <FieldRow
          label={t("security.web.port")}
          value={String(srv.port)}
          keyboardType="number-pad"
          maxLength={5}
          onCommit={(next) => {
            const port = Number(next);
            if (Number.isInteger(port) && port >= 1 && port <= 65535) void patchAnySettings({ server: { port } });
            else Alert.alert(t("security.web.portInvalid"));
          }}
        />
      </Group>

      <View>
        <SectionTitle title={t("security.web.origins")} />
        <TextEditor
          label={t("security.web.origins")}
          value={srv.allowedOrigins.join("\n")}
          placeholder="https://godmode.example.com"
          minHeight={88}
          hint={t("security.web.originsHint")}
          onSave={(text) =>
            patchAnySettings(
              {
                server: {
                  allowedOrigins: text
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean),
                },
              },
              { quiet: true },
            )
          }
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
