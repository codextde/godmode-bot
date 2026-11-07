import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Switch } from "react-native";
import { useTranslation } from "react-i18next";
import { modState, type Mod } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { Group, LinkRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { pluginIcon, pluginOrigin } from "@/components/plugin-parts";
import { Badge, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { ik, integrationsApi, usePlugins } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { toolsAdmin } from "@/lib/tools-admin";
import { useColors } from "@/lib/theme";

const hasUpdate = (m: Mod) => !!m.source?.latestCommit && m.source.latestCommit !== m.source.commit;

/**
 * Plugins and whether they run. One that runs can be switched off here; a full-access phone also switches them on,
 * deletes them and updates the ones from a repository, like the desktop.
 */
export default function Plugins() {
  const { t } = useTranslation(["integrations", "tools", "common"]);
  const c = useColors();
  const admin = !!useFullAccess().fullAccess;
  const list = usePlugins();
  const agents = useAgents();
  const settings = useSettings();
  const off = settings.data?.plugins.enabled === false;
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ik.plugins });
  const switchOff = useMutation({
    mutationFn: (mod: Mod) => integrationsApi.switchOff(mod.id),
    onMutate: (mod) => queryClient.setQueryData<Mod[]>(ik.plugins, (all) => all?.map((m) => (m.id === mod.id ? { ...m, enabled: false } : m))),
    onError: (err) => Alert.alert(t("plugins.switchFailed"), errorText(err)),
    onSettled: refresh,
  });

  /** Runs one change at a time, with the row showing it works. */
  const run = async (id: string, work: () => Promise<unknown>, failed: string) => {
    setBusy(id);
    try {
      await work();
    } catch (err) {
      Alert.alert(failed, errorText(err));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const switchOn = (m: Mod) =>
    Alert.alert(t("tools:plugins.onTitle", { name: m.title || m.name }), t("tools:plugins.onBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("tools:plugins.on"), onPress: () => void run(m.id, () => toolsAdmin.plugins.setEnabled(m, true), t("tools:plugins.onFailed")) },
    ]);

  const remove = (m: Mod) =>
    Alert.alert(t("tools:plugins.deleteTitle", { name: m.title || m.name }), t("tools:plugins.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("common:actions.delete"), style: "destructive", onPress: () => void run(m.id, () => toolsAdmin.plugins.remove(m.id), t("tools:plugins.deleteFailed")) },
    ]);

  /** A long press: update or delete right from the list. */
  const actions = (m: Mod) => {
    const name = m.title || m.name;
    Alert.alert(name, m.source ? [m.source.repo, m.source.version].filter(Boolean).join(" · ") : undefined, [
      ...(hasUpdate(m)
        ? [{ text: t("tools:plugins.update", { version: m.source?.latestVersion ?? m.source?.latestCommit?.slice(0, 7) }), onPress: () => void run(m.id, () => toolsAdmin.plugins.update(m.id), t("tools:plugins.updateFailed")) }]
        : []),
      { text: t("common:actions.delete"), style: "destructive" as const, onPress: () => remove(m) },
      { text: t("common:actions.cancel"), style: "cancel" as const },
    ]);
  };
  const openPlugin = (m: Mod) => router.push({ pathname: "/settings/plugin", params: { id: m.id } });

  const checkUpdates = () => void run("updates", () => toolsAdmin.plugins.checkUpdates().then((mods) => queryClient.setQueryData(ik.plugins, mods)), t("tools:plugins.checkFailed"));
  const fromRepos = (list.data ?? []).some((m) => m.source);

  return (
    <ReadonlyList<Mod>
      title={t("plugins.title")}
      query={list}
      items={list.data ?? []}
      keyOf={(m) => m.id}
      icon="puzzle"
      emptyTitle={t("plugins.emptyTitle")}
      emptyBody={admin ? t("tools:pluginAdmin.emptyBody") : t("plugins.emptyBody")}
      failedTitle={t("plugins.loadFailed")}
      extraData={`${admin}-${busy}-${agents.data?.length}`}
      header={
        <>
          {admin ? (
            <HeaderActions
              actions={[
                ...(fromRepos ? [{ icon: "refresh" as const, label: t("tools:plugins.checkUpdates"), onPress: checkUpdates }] : []),
                { icon: "plus" as const, label: t("tools:pluginAdmin.add"), onPress: () => router.push("/settings/plugin-install") },
              ]}
            />
          ) : null}
          {off ? (
            <Group>
              <LinkRow icon="power" title={t("plugins.allOff")} onPress={() => router.push("/settings/features")} />
            </Group>
          ) : null}
        </>
      }
      renderRow={(m) => {
        const name = m.title || m.name;
        const broken = modState(m) === "broken";
        const fixing = <Badge label={t("tools:pluginAdmin.state.broken")} tone="danger" />;
        const trailing =
          busy === m.id || (busy === "updates" && m.source) ? (
            <ActivityIndicator size="small" color={c.textMuted} />
          ) : admin ? (
            <>
              {broken ? fixing : hasUpdate(m) ? <Badge label={t("tools:plugins.updateBadge")} tone="warning" /> : m.needsReview ? <Badge label={t("plugins.draft")} tone="warning" /> : null}
              <Switch
                accessibilityLabel={t("tools:list.switch", { name })}
                value={m.enabled && !off}
                disabled={off}
                onValueChange={(next) => {
                  tap();
                  if (next) switchOn(m);
                  else switchOff.mutate(m);
                }}
                trackColor={{ true: c.brand, false: c.sunken }}
              />
            </>
          ) : m.enabled && !off ? (
            <>
              {broken ? fixing : null}
              <Switch
                accessibilityLabel={t("plugins.switchOff", { name })}
                value
                onValueChange={(next) => {
                  if (next) return;
                  tap();
                  switchOff.mutate(m);
                }}
                trackColor={{ true: c.brand, false: c.sunken }}
              />
            </>
          ) : broken ? (
            fixing
          ) : (
            <Badge label={m.needsReview ? t("plugins.draft") : t("off")} tone={m.needsReview ? "warning" : "neutral"} />
          );
        return (
          <ListRow
            icon={pluginIcon(m.icon)}
            tint={m.enabled ? c.brandStrong : undefined}
            title={name}
            lines={[m.description, m.source ? [m.source.repo, m.source.version].filter(Boolean).join(" · ") : pluginOrigin(m, agents.data)]}
            lineLimit={2}
            chevron={false}
            trailing={trailing}
            onPress={admin ? () => openPlugin(m) : undefined}
            onLongPress={admin ? () => actions(m) : undefined}
          />
        );
      }}
    />
  );
}
