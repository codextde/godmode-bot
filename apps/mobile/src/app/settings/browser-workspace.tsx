import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { BrowserProfile, Workspace } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, Group, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { EmptyState } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { leave, machinesApi } from "@/lib/machines";
import { qk, queryClient } from "@/lib/query";
import { space } from "@/lib/theme";
import { useWorkspace, scopeLabel } from "@/lib/workspace";

/**
 * Which workspace a browser profile belongs to, like the desktop's Assign dialog: its cookies and sessions stay with
 * the profile; made the workspace's default, its agents browse with it (full access).
 */
export default function BrowserWorkspace() {
  const { t } = useTranslation("machines");
  const { id } = useLocalSearchParams<{ id: string }>();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const profile = profiles.data?.find((p) => p.id === id);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: profile?.name ?? t("assign.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <AdminQueryState query={profiles} errorTitle={t("browser.loadFailed")}>
          {(list) => {
            const found = list.find((p) => p.id === id);
            return found ? <Assign key={found.id} profile={found} profiles={list} /> : <EmptyState style={styles.state} icon="globe" title={t("assign.gone")} />;
          }}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Assign({ profile, profiles }: { profile: BrowserProfile; profiles: BrowserProfile[] }) {
  const { t } = useTranslation(["machines", "common"]);
  const { workspaces } = useWorkspace();
  const [target, setTarget] = useState<string | null>(profile.workspaceId);
  const [makeDefault, setMakeDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  const defaultOf = (scope: string | null) => profiles.find((p) => p.workspaceId === scope && p.isDefault);
  const globalDefault = defaultOf(null);
  const workspace: Workspace | undefined = workspaces.find((w) => w.id === target);
  const targetDefault = target ? defaultOf(target) : undefined;
  const unchanged = target === profile.workspaceId;
  const leaving = profile.workspaceId && profile.isDefault && !unchanged ? workspaces.find((w) => w.id === profile.workspaceId) : undefined;
  const fallback = globalDefault?.name ?? t("assign.theGlobalDefault");

  const save = async () => {
    if (unchanged || saving) return;
    setSaving(true);
    try {
      const isDefault = target ? makeDefault || !targetDefault || targetDefault.id === profile.id : undefined;
      await machinesApi.browser.assign(profile.id, target, isDefault);
      void queryClient.invalidateQueries({ queryKey: qk.browserProfiles });
      void queryClient.invalidateQueries({ queryKey: qk.workspaces });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      leave("/settings/browser");
    } catch (err) {
      Alert.alert(t("assign.failed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const footer = [
    t("assign.cookiesStay"),
    leaving ? t("assign.leaving", { workspace: leaving.name, profile: fallback }) : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <>
      {!unchanged ? (
        <HeaderActions actions={[{ icon: "check", label: target ? t("assign.assign") : t("assign.makeGlobal"), prominent: true, onPress: () => void save() }]} />
      ) : null}

      <Group title={t("assign.workspace")} footer={footer}>
        <ChoiceRow
          icon="globe"
          title={profile.workspaceId === null ? `${t("assign.global")} · ${t("assign.current")}` : t("assign.global")}
          detail={t("assign.globalHint")}
          selected={target === null}
          onPress={() => setTarget(null)}
        />
        {workspaces.map((w) => {
          const browser = defaultOf(w.id);
          return (
            <ChoiceRow
              key={w.id}
              icon="layers"
              title={`${scopeLabel(w)}${profile.workspaceId === w.id ? ` · ${t("assign.current")}` : ""}`}
              detail={browser ? t("assign.browsesWith", { name: browser.name }) : t("assign.noProfile", { name: fallback })}
              selected={target === w.id}
              onPress={() => setTarget(w.id)}
            />
          );
        })}
      </Group>

      {!workspaces.length ? <EmptyState icon="layers" title={t("assign.noWorkspaces")} /> : null}

      {workspace && !unchanged ? (
        <Group
          footer={
            !targetDefault
              ? t("assign.noProfileYet", { name: workspace.name })
              : makeDefault
                ? t("assign.replaces", { name: targetDefault.name })
                : t("assign.keeps", { name: targetDefault.name })
          }
        >
          <SwitchRow icon="check" title={t("assign.useFor", { name: workspace.name })} value={makeDefault || !targetDefault} disabled={!targetDefault} onChange={setMakeDefault} />
        </Group>
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
  state: {
    paddingTop: 60,
  },
});
