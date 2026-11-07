import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { modNameFrom } from "@godmode/shared";
import { FullAccessGate, isRefused } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { InfoRow } from "@/components/status-rows";
import { ActionRow, TextRow } from "@/components/tool-form";
import { tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { pluginsAdmin, putPlugin } from "@/lib/plugins-admin";
import { space } from "@/lib/theme";

const MAX_TITLE = 80;

/** A blank plugin: a title is all it takes, the plugin name follows from it and its code opens next. */
export default function PluginNew() {
  const { t } = useTranslation("tools");
  return (
    <>
      <Stack.Screen options={{ title: t("pluginAdmin.newPlugin.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        <Form />
      </FullAccessGate>
    </>
  );
}

function Form() {
  const { t } = useTranslation(["tools", "components"]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = title.trim();

  const create = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const mod = await pluginsAdmin.create({ title: trimmed });
      putPlugin(mod);
      tap();
      router.replace({ pathname: "/settings/plugin-code", params: { id: mod.id } });
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("pluginAdmin.newPlugin.createFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Group>
        <TextRow label={t("pluginAdmin.titleLabel")} value={title} onChange={setTitle} placeholder={t("pluginAdmin.newPlugin.placeholder")} maxLength={MAX_TITLE} />
        {trimmed ? <InfoRow label={t("pluginAdmin.newPlugin.pluginName")} value={modNameFrom(title)} mono /> : null}
      </Group>
      {trimmed ? (
        <Group>
          <ActionRow icon="plus" title={t("pluginAdmin.newPlugin.create")} busy={busy} onPress={() => void create()} />
        </Group>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 60, gap: space.xl },
});
