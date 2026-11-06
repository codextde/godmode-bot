import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ConnectorAccess, ConnectorClient, ConnectorCreated } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { ChoiceRow, Group, Segmented } from "@/components/form";
import { CodeBlock, actionFailed } from "@/components/linking-parts";
import { Button, T, tap } from "@/components/ui";
import { linkingApi } from "@/lib/linking";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { fonts, space, useColors } from "@/lib/theme";

/**
 * Settings → Connected apps → Connect an app: Claude Code on the computer in one go, or any other MCP client with a key.
 * The key is shown here once, right after it was made, and never again.
 */
export default function ConnectApp() {
  const { t } = useTranslation("linking");
  const [created, setCreated] = useState<ConnectorCreated | null>(null);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("connect.title") }} />
      <FullAccessGate>{created ? <Created result={created} /> : <Form onCreated={setCreated} />}</FullAccessGate>
    </ScrollView>
  );
}

function Form({ onCreated }: { onCreated: (result: ConnectorCreated) => void }) {
  const c = useColors();
  const { t } = useTranslation("linking");
  const status = useQuery({ queryKey: sq.connectors, queryFn: settingsApi.connectors.status });
  const claudeCode = status.data?.claudeCode ?? true;
  const [client, setClient] = useState<ConnectorClient>("claude-code");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ConnectorAccess>("manage");
  const install = client === "claude-code" && claudeCode;

  const create = useMutation({
    mutationFn: () => linkingApi.connectors.create({ name: client === "claude-code" ? "Claude Code" : name.trim(), client, access, install }),
    onSuccess: (result) => {
      tap(Haptics.ImpactFeedbackStyle.Medium);
      void queryClient.invalidateQueries({ queryKey: sq.connectors });
      onCreated(result);
    },
    onError: (err) => actionFailed(t("connect.failed"), err),
  });
  const ready = client === "claude-code" || name.trim().length > 0;

  return (
    <>
      <Segmented<ConnectorClient>
        value={client}
        onChange={setClient}
        options={[
          { value: "claude-code", label: "Claude Code" },
          { value: "other", label: t("connect.another") },
        ]}
      />
      {client === "other" ? (
        <Group title={t("connect.name")} footer={t("connect.nameHint")}>
          <TextInput
            accessibilityLabel={t("connect.name")}
            value={name}
            onChangeText={setName}
            maxLength={80}
            placeholder={t("connect.namePlaceholder")}
            placeholderTextColor={c.textFaint}
            autoCorrect={false}
            returnKeyType="done"
            style={[styles.field, { color: c.text }]}
          />
        </Group>
      ) : (
        <T variant="subhead" muted style={styles.note}>
          {claudeCode ? t("connect.claudeBody") : t("connect.claudeMissing")}
        </T>
      )}
      <Group title={t("connect.mayDo")}>
        <ChoiceRow icon="sparkles" title={t("connect.manage")} detail={t("connect.manageDetail")} selected={access === "manage"} onPress={() => setAccess("manage")} />
        <ChoiceRow icon="eye" title={t("connect.read")} detail={t("connect.readDetail")} selected={access === "read"} onPress={() => setAccess("read")} />
      </Group>
      <Button
        title={install ? (create.isPending ? t("connect.adding") : t("connect.add")) : t("connect.createKey")}
        icon={install ? "terminal" : "key"}
        loading={create.isPending}
        disabled={!ready}
        onPress={() => create.mutate()}
      />
    </>
  );
}

type SetupTab = "config" | "claude" | "url" | "terminal";

function Created({ result }: { result: ConnectorCreated }) {
  const { t } = useTranslation(["linking", "common"]);
  const [tab, setTab] = useState<SetupTab>("config");
  const { connector, setup, install } = result;
  const added = install?.ok === true;

  return (
    <>
      <View style={styles.head}>
        <T variant="headline">{added ? t("connect.connected") : t("connect.keyReady", { name: connector.name })}</T>
        <T variant="subhead" muted>
          {added ? t("connect.connectedBody") : t("connect.keyReadyBody")}
        </T>
      </View>

      {added ? (
        <CodeBlock title={t("connect.tryTitle")} text={t("connect.tryPrompt")} />
      ) : connector.client === "claude-code" ? (
        <>
          {install ? (
            <T variant="footnote" muted style={styles.note}>
              {t("connect.installFailed", { detail: install.detail })}
            </T>
          ) : null}
          <CodeBlock title={t("connect.runInTerminal")} text={setup.claudeCommand} />
        </>
      ) : (
        <>
          <Segmented<SetupTab>
            value={tab}
            onChange={setTab}
            options={[
              { value: "config", label: t("connect.configTab") },
              { value: "claude", label: "Claude Code" },
              { value: "url", label: "URL" },
              { value: "terminal", label: "Terminal" },
            ]}
          />
          {tab === "config" ? (
            <CodeBlock text={setup.json} />
          ) : tab === "claude" ? (
            <CodeBlock text={setup.claudeCommand} />
          ) : tab === "url" ? (
            <CodeBlock text={`${setup.url}\nAuthorization: Bearer ${setup.token}`} />
          ) : (
            <CodeBlock text={setup.cli} />
          )}
          <T variant="footnote" muted style={styles.note}>
            {tab === "config" ? t("connect.configHint") : tab === "claude" ? t("connect.claudeHint") : tab === "url" ? t("connect.urlHint") : t("connect.cliHint")}
          </T>
        </>
      )}

      <Button title={t("common:actions.done")} onPress={() => router.back()} />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  field: {
    fontFamily: fonts.regular,
    fontSize: 15,
    paddingHorizontal: space.lg,
    paddingVertical: 15,
  },
  note: {
    paddingHorizontal: 4,
  },
  head: {
    gap: space.xs,
    paddingHorizontal: 4,
  },
});
