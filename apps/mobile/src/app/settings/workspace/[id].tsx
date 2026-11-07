import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { confirmWithBiometrics, useFullAccess } from "@/components/full-access";
import { Group, LinkRow, PickerRow, SwitchRow, TextEditor } from "@/components/form";
import { PickRow } from "@/components/pick-sheet";
import { Identity, Sources } from "@/components/setup";
import { EmptyState, SectionTitle } from "@/components/ui";
import { WorkspaceColors } from "@/components/workspace-color";
import { t as translate } from "@/lib/i18n";
import { api, ApiError, errorText } from "@/lib/api";
import { useArchive } from "@/lib/archive";
import { useAgents } from "@/lib/hooks";
import { manageApi, patchWorkspaceSetup } from "@/lib/manage";
import { qk, queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { firstLine, patchWorkspace, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";
import { useWorkspace, ownEmoji } from "@/lib/workspace";

const DEFAULT = "default";
const NONE = "none";

export default function WorkspaceScreen() {
  const { t } = useTranslation(["settings", "common", "archive", "manage"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspaces, loading } = useWorkspace();
  const { data: agents } = useAgents();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const { archive } = useArchive(() => router.back());
  const w = workspaces.find((x) => x.id === id);
  // Every agent working here follows its context: a phone without full access reads it.
  const locked = useFullAccess().fullAccess === false;
  const admin = useFullAccess().fullAccess === true;
  const { t: tc } = useTranslation("components");
  const vmOn = !!useSettings().data?.vm.enabled;
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list, retry: false, enabled: vmOn && admin });
  const accounts = useQuery({ queryKey: sq.claudeAccounts, queryFn: settingsApi.claudeAccounts.list, enabled: admin });

  if (!w) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: t("workspace.title") }} />
        <CloseButton />
        {loading ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="layers" title={t("workspace.notFound")} body={t("agent.notFound.body")} />}
      </ScrollView>
    );
  }

  const team = agents?.filter((a) => a.workspaceId === w.id) ?? [];
  const usable = (profiles.data ?? []).filter((p) => !p.workspaceId || p.workspaceId === w.id);

  const removed = () => {
    void queryClient.invalidateQueries({ queryKey: qk.workspaces });
    void queryClient.invalidateQueries({ queryKey: qk.agents });
    void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    router.back();
  };
  // Like the desktop: a workspace with something in it goes only with everything in it, after a second, stronger yes.
  const forceRemove = (details: unknown) =>
    Alert.alert(
      t("manage:workspace.forceTitle", { name: w.name }),
      [
        t("manage:workspace.forceBody"),
        heldBy(details) ?? t("manage:workspace.forceCounts", { agents: t("manage:workspace.agents", { count: team.length }), projects: t("manage:workspace.projects", { count: w.projects.length }) }),
        t("manage:workspace.forceTip"),
      ].join("\n\n"),
      [
        { text: t("manage:workspace.keep"), style: "cancel" },
        {
          text: t("manage:workspace.deleteAll"),
          style: "destructive",
          onPress: async () => {
            if (!(await confirmWithBiometrics(t("manage:workspace.confirmReason", { name: w.name })))) return;
            try {
              await manageApi.deleteWorkspace(w.id, true);
              removed();
            } catch (err) {
              Alert.alert(t("workspace.deleteFailed"), errorText(err));
            }
          },
        },
      ],
    );
  const remove = () =>
    Alert.alert(t("workspace.deleteDialog.title", { name: w.name }), t("workspace.deleteDialog.body"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await api.workspace.delete(w.id);
            removed();
          } catch (err) {
            const full = err instanceof ApiError && err.status === 409;
            if (full && admin) forceRemove(err.details);
            else Alert.alert(t("workspace.deleteFailed"), full ? t("workspace.notEmpty", { name: w.name }) : errorText(err));
          }
        },
      },
    ]);
  const lockedAlert = () => Alert.alert(tc("fullAccess.title"));
  const own = w.claudeAccounts;
  const list = accounts.data?.accounts ?? [];
  const globalDefault = list.find((a) => a.isDefault) ?? list[0];
  const accountName = (a: (typeof list)[number]) => a.email ?? t("manage:workspace.thisComputer");
  const toggleAccount = (accountId: string) => {
    if (!own) return;
    const ids = own.ids.includes(accountId) ? own.ids.filter((x) => x !== accountId) : [...own.ids, accountId];
    if (!ids.length) return;
    void patchWorkspaceSetup(w.id, { claudeAccounts: { ids, defaultId: ids.includes(own.defaultId) ? own.defaultId : ids[0]! } });
  };
  const workspaceVm = vms.data?.find((v) => v.id === w.vmId);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: w.name, headerLargeTitleEnabled: false }} />
      <CloseButton />

      <Identity icon={w.icon} name={w.name} description={w.description} fallbackIcon="layers" onChange={(patch) => void patchWorkspace(w.id, patch)} />
      <WorkspaceColors value={w.color} onChange={(color) => void patchWorkspace(w.id, { color })} />

      <View>
        <SectionTitle title={t("workspace.context")} />
        <TextEditor
          label={t("workspace.contextLabel", { name: w.name })}
          value={w.instructions}
          placeholder={t("workspace.contextPlaceholder")}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          readOnly={locked}
          hint={locked ? tc("fullAccess.title") : undefined}
          onSave={(instructions) => patchWorkspace(w.id, { instructions }, { quiet: true })}
        />
      </View>

      <Group title={t("workspace.projects")}>
        {w.projects.map((p) => (
          <LinkRow
            key={p.id}
            emoji={ownEmoji(p.icon)}
            icon="folder"
            title={p.name}
            detail={firstLine(p.instructions) || p.description || t("instructions.workspaces.noProjectContext")}
            onPress={() => router.push({ pathname: "/settings/project/[id]", params: { id: p.id } })}
          />
        ))}
        <LinkRow icon="plus" title={t("workspace.newProject")} tone="brand" chevron={false} onPress={() => router.push({ pathname: "/settings/new", params: { kind: "project", workspaceId: w.id } })} />
      </Group>

      <Group title={t("common:words.agents")}>
        {team.map((a) => (
          <LinkRow
            key={a.id}
            lead={<CharacterAvatar agent={a} size={30} />}
            title={a.name}
            detail={a.role || a.description || undefined}
            value={a.enabled ? undefined : t("common:status.off")}
            onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: a.id } })}
          />
        ))}
        <LinkRow icon="plus" title={t("agents.new")} tone="brand" chevron={false} onPress={() => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: w.id } })} />
      </Group>

      <Sources
        sources={w.sources}
        onSave={(sources) => patchWorkspace(w.id, { sources })}
        onSync={(sourceId) => api.workspace.sync(w.id, sourceId)}
      />

      <Group title={t("workspace.behavior")}>
        <SwitchRow
          icon="branch"
          title={t("workspace.autoMerge")}
          detail={t("workspace.autoMergeDetail")}
          value={w.autoMerge}
          onChange={(autoMerge) => void patchWorkspace(w.id, { autoMerge })}
        />
        <PickerRow
          icon="globe"
          title={t("workspace.browserProfile")}
          value={w.browserProfileId ?? DEFAULT}
          options={[{ value: DEFAULT, label: t("agent.thinking.default") }, ...usable.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => void patchWorkspace(w.id, { browserProfileId: v === DEFAULT ? null : v })}
        />
        {vmOn && vms.data ? (
          <PickerRow
            icon="vm"
            title={t("manage:workspace.vm")}
            value={w.vmId ?? NONE}
            options={[
              { value: NONE, label: t("manage:workspace.vmNone") },
              ...(w.vmId && !workspaceVm ? [{ value: w.vmId, label: w.vmId }] : []),
              ...vms.data.map((v) => ({ value: v.id, label: v.name })),
            ]}
            onChange={(v) => void patchWorkspaceSetup(w.id, { vmId: v === NONE ? null : v })}
          />
        ) : null}
      </Group>

      {admin && (list.length > 1 || own) ? (
        <Group title={t("manage:workspace.accounts")} footer={own ? t("manage:workspace.ownAccountsOn") : t("manage:workspace.ownAccountsOff")}>
          <SwitchRow
            icon="personCircle"
            title={t("manage:workspace.ownAccounts")}
            value={!!own}
            onChange={(on) => {
              const first = globalDefault?.id ?? "system";
              void patchWorkspaceSetup(w.id, { claudeAccounts: on ? { ids: [first], defaultId: first } : null });
            }}
          />
          {own
            ? list.map((a) => (
                <PickRow
                  key={a.id}
                  multi
                  icon="personCircle"
                  title={accountName(a)}
                  detail={[a.plan, a.id === own.defaultId ? t("manage:workspace.defaultAccount") : ""].filter(Boolean).join(" · ") || undefined}
                  selected={own.ids.includes(a.id)}
                  disabled={own.ids.length === 1 && own.ids.includes(a.id)}
                  onPress={() => toggleAccount(a.id)}
                />
              ))
            : null}
          {own && own.ids.length > 1 ? (
            <PickerRow
              icon="check"
              title={t("manage:workspace.defaultAccount")}
              value={own.defaultId}
              options={list.filter((a) => own.ids.includes(a.id)).map((a) => ({ value: a.id, label: accountName(a) }))}
              onChange={(defaultId) => void patchWorkspaceSetup(w.id, { claudeAccounts: { ids: own.ids, defaultId } })}
            />
          ) : null}
        </Group>
      ) : null}

      <Group footer={admin ? undefined : t("workspace.deleteFooter")}>
        <LinkRow icon="move" title={t("manage:workspace.move")} onPress={() => (admin ? router.push({ pathname: "/scope-move", params: { kind: "workspace", id: w.id } }) : lockedAlert())} />
        <LinkRow icon="archive" title={t("archive:archive")} chevron={false} onPress={() => archive({ kind: "workspace", id: w.id, name: w.name })} />
        <LinkRow icon="trash" title={t("workspace.delete")} tone="danger" chevron={false} onPress={remove} />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});

const HELD = ["projects", "agents", "credentials", "totp", "cards", "mcpServers", "apiTools", "browserProfiles", "composioConnections", "tasks"] as const;

/** What the computer says a workspace still holds, kind by kind ("3 agents\n12 tasks"), or null when it doesn't say. */
function heldBy(details: unknown): string | null {
  const raw = details && typeof details === "object" ? ((details as { counts?: unknown }).counts ?? details) : null;
  if (!raw || typeof raw !== "object") return null;
  const counts = raw as Record<string, unknown>;
  const lines = HELD.flatMap((kind) => {
    const n = counts[kind];
    return typeof n === "number" && n > 0 ? [`${n} ${translate(`manage:workspace.held.${kind}`)}`] : [];
  });
  return lines.length ? lines.join("\n") : null;
}
