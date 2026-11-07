import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import {
  MESSAGING_PROVIDER_LABELS,
  MESSAGING_PROVIDERS,
  type MessagingAccess,
  type MessagingConnection,
  type MessagingProvider,
  type MessagingVerifyResult,
  slackManifest,
} from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { Group, LinkRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { accessRows, useAgentChooserRows, credentialRows, PlatformLogo } from "@/components/messaging-parts";
import { ListRow } from "@/components/readonly-list";
import { ActionRow, TestResult, TextRow } from "@/components/tool-form";
import { Badge, EmptyState } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { ik } from "@/lib/integrations";
import { createBot, credentialsOf, EMPTY_FIELDS, messagingAdmin, refreshMessaging, setupUrl, type CredentialFields } from "@/lib/messaging-admin";
import { queryClient } from "@/lib/query";
import { isCancelled } from "@/lib/secrets";
import { space } from "@/lib/theme";

/** Settings → Messaging → a platform: make the bot there, check its tokens, pick its agents and who may write (full access only). */
export default function MessagingConnect() {
  const { t } = useTranslation("messaging");
  const { provider } = useLocalSearchParams<{ provider?: string }>();
  const p = MESSAGING_PROVIDERS.find((x) => x === provider);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: p ? t("connect.title", { platform: MESSAGING_PROVIDER_LABELS[p] }) : "", headerLargeTitleEnabled: false }} />
      <FullAccessGate>{p ? <ConnectForm provider={p} /> : <EmptyState icon="chats" title={t("connect.unknown")} />}</FullAccessGate>
    </ScrollView>
  );
}

function ConnectForm({ provider }: { provider: MessagingProvider }) {
  const { t } = useTranslation(["messaging", "common", "tools"]);
  const navigation = useNavigation();
  const agents = useAgents();
  const [fields, setFields] = useState<CredentialFields>(EMPTY_FIELDS);
  const [publicUrl, setPublicUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState<MessagingVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [agentIds, setAgentIds] = useState<string[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [access, setAccess] = useState<MessagingAccess>("approved");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const exit = useRef<Parameters<typeof navigation.dispatch>[0] | null>(null);
  const credentials = credentialsOf(provider, fields);
  const typed = Object.values(fields).some((v) => v.trim()) || !!publicUrl.trim();
  const list = (agents.data ?? []).filter((a) => a.enabled || agentIds?.includes(a.id));

  // The default agent is picked once the agents are known; the human changes it from there.
  const first = agents.data?.find((a) => a.isDefault) ?? agents.data?.[0];
  if (agentIds === null && agents.data) {
    setAgentIds(first ? [first.id] : []);
    setDefaultId(first?.id ?? null);
  }

  const agentRows = useAgentChooserRows({
    agents: list,
    value: agentIds ?? [],
    defaultId,
    onChange: (ids, d) => {
      setAgentIds(ids);
      setDefaultId(d);
    },
  });

  useEffect(() => {
    if (done) router.replace({ pathname: "/settings/messaging-bot", params: { id: done } });
  }, [done]);

  // Leaves once the form no longer holds the screen.
  useEffect(() => {
    if (leaving && exit.current) navigation.dispatch(exit.current);
  }, [leaving, navigation]);

  usePreventRemove(typed && !done && !leaving, ({ data }) => {
    Alert.alert(t("tools:discard.title"), undefined, [
      { text: t("tools:discard.keep"), style: "cancel" },
      {
        text: t("tools:discard.discard"),
        style: "destructive",
        onPress: () => {
          exit.current = data.action;
          setLeaving(true);
        },
      },
    ]);
  });

  const set = (key: keyof CredentialFields, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setVerified(null);
    setVerifyError(null);
  };

  const check = async () => {
    if (!credentials || checking) return;
    setChecking(true);
    setVerifyError(null);
    try {
      const result = await messagingAdmin.verify(credentials);
      setVerified(result);
      if (!name.trim()) setName(result.bot.name);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      setVerifyError(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const connect = async () => {
    if (!credentials || !verified || saving) return;
    if (!agentIds?.length) return Alert.alert(t("connect.needsAgent"));
    if (provider === "teams" && !publicUrl.trim()) return Alert.alert(t("connect.needsPublicUrl"));
    setSaving(true);
    try {
      const bot = await createBot({
        credentials,
        name: name.trim() || undefined,
        agentIds,
        defaultAgentId: defaultId,
        access,
        ...(provider === "teams" ? { publicUrl: publicUrl.trim() } : {}),
      });
      queryClient.setQueryData<MessagingConnection[]>(ik.messaging, (list) => (list ? [...list.filter((x) => x.id !== bot.id), bot] : [bot]));
      refreshMessaging();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setDone(bot.id);
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("connect.failed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const handle = verified ? [verified.bot.username && provider === "telegram" ? `@${verified.bot.username}` : null, verified.bot.team].filter(Boolean).join(" · ") : "";

  return (
    <>
      {verified ? <HeaderActions actions={[{ icon: "check", label: t("connect.connect"), prominent: true, onPress: () => void connect() }]} /> : null}

      <Group>
        <LinkRow icon="external" title={t(`connect.open.${provider}`)} chevron={false} onPress={() => void Linking.openURL(setupUrl(provider)).catch(() => undefined)} />
        {provider === "slack" ? (
          <LinkRow
            icon="copy"
            title={t("connect.copyManifest")}
            chevron={false}
            onPress={() => {
              void Clipboard.setStringAsync(JSON.stringify(slackManifest("Godmode"), null, 2));
              Alert.alert(t("connect.manifestCopied"));
            }}
          />
        ) : null}
      </Group>

      <Group title={t("connect.tokens")}>
        {credentialRows(provider, fields, set)}
        {provider === "teams" ? (
          <TextRow label={t("connect.publicUrl")} value={publicUrl} onChange={setPublicUrl} placeholder="https://godmode.example.com" mono stacked keyboardType="url" />
        ) : null}
        {verified ? null : <ActionRow icon="checkCircle" title={checking ? t("connect.checking") : t("connect.check")} busy={checking} onPress={() => (credentials ? void check() : Alert.alert(t("connect.fillEveryField")))} />}
        {verifyError && !checking ? <TestResult ok={false} title={t("connect.checkFailed")} body={verifyError} /> : null}
      </Group>

      {verified ? (
        <>
          <Group footer={verified.warnings.length ? verified.warnings.join("\n") : undefined}>
            <ListRow grouped lead={<PlatformLogo provider={provider} />} title={verified.bot.name} lines={[handle || null]} trailing={<Badge label={t("connect.verified")} tone="success" />} />
          </Group>

          <Group>
            <TextRow label={t("connect.name")} value={name} onChange={setName} placeholder={verified.bot.name} maxLength={100} />
          </Group>

          <Group title={t("agents.title")}>
            {agentRows}
          </Group>

          <Group title={t("access.title")}>{accessRows({ provider, team: verified.bot.team, value: access, onChange: setAccess })}</Group>

          <Group>
            <ActionRow icon="link" title={saving ? t("connect.connecting") : t("connect.title", { platform: MESSAGING_PROVIDER_LABELS[provider] })} busy={saving} onPress={() => void connect()} />
          </Group>
        </>
      ) : null}
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
