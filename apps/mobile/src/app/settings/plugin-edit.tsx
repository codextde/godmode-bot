import { usePreventRemove } from "expo-router/react-navigation";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { MOD_ICONS, type Mod, type ModIcon } from "@godmode/shared";
import { FullAccessGate, isRefused } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { PluginIconGrid } from "@/components/plugin-parts";
import { TextRow } from "@/components/tool-form";
import { ErrorState, LoadingState, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { usePlugins } from "@/lib/integrations";
import { pluginsAdmin, putPlugin } from "@/lib/plugins-admin";
import { space } from "@/lib/theme";

const MAX_TITLE = 80;
const MAX_DESCRIPTION = 600;

/** A plugin's title, description and icon, which the desktop changes in place in its sheet. */
export default function PluginEdit() {
  const { t } = useTranslation("tools");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = usePlugins();
  const mod = list.data?.find((m) => m.id === id);
  return (
    <>
      <Stack.Screen options={{ title: t("pluginAdmin.edit"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        {mod ? (
          <Form key={mod.id} mod={mod} />
        ) : list.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState title={list.isError ? t("pluginAdmin.loadFailed") : t("pluginAdmin.notFound")} error={list.isError ? errorText(list.error) : t("pluginAdmin.maybeDeleted")} onRetry={() => void list.refetch()} />
        )}
      </FullAccessGate>
    </>
  );
}

function Form({ mod }: { mod: Mod }) {
  const { t } = useTranslation(["tools", "components", "common"]);
  const [title, setTitle] = useState(mod.title);
  const [description, setDescription] = useState(mod.description);
  const [icon, setIcon] = useState<ModIcon>(mod.icon);
  const [saving, setSaving] = useState(false);
  const navigation = useNavigation();
  const dirty = title.trim() !== mod.title || description.trim() !== mod.description || icon !== mod.icon;

  usePreventRemove(dirty && !saving, ({ data }) => {
    Alert.alert(t("pluginAdmin.codeFiles.discardTitle"), t("pluginAdmin.codeFiles.discardDescription", { title: mod.title }), [
      { text: t("pluginAdmin.codeFiles.keepEditing"), style: "cancel" },
      { text: t("pluginAdmin.codeFiles.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      putPlugin(await pluginsAdmin.update(mod.id, { title: title.trim(), description: description.trim(), icon }));
      tap();
      router.back();
    } catch (err) {
      setSaving(false);
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("pluginAdmin.editFailed"), isRefused(err) ? undefined : errorText(err));
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <HeaderActions actions={dirty && title.trim() && !saving ? [{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => void save() }] : []} />
      <Group>
        <TextRow label={t("pluginAdmin.titleLabel")} value={title} onChange={setTitle} maxLength={MAX_TITLE} />
        <TextRow label={t("pluginAdmin.descriptionLabel")} value={description} onChange={setDescription} placeholder={t("pluginAdmin.descriptionPlaceholder")} maxLength={MAX_DESCRIPTION} multiline />
      </Group>
      <Group title={t("pluginAdmin.iconLabel")}>
        <PluginIconGrid icons={MOD_ICONS} value={icon} onPick={setIcon} />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 60, gap: space.xl },
});
