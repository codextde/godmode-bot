import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { ProfileUseSyncResult } from "@godmode/shared";
import { Group, LinkRow, PickerRow } from "./form";
import { ActionPill, ToolRow } from "./program-parts";
import { ago, InfoRow } from "./status-rows";
import { ActionRow, TestResult } from "./tool-form";
import { ApiError, errorText } from "@/lib/api";
import { lastLines } from "@/lib/programs";
import { machinesApi, mk } from "@/lib/machines";
import { queryClient } from "@/lib/query";

const ALL = "__all__";

/** browser-use `profile-use`: the computer's Chrome cookies synced to a browser-use Cloud profile (full access). */
export function ProfileUseGroup() {
  const { t } = useTranslation(["machines", "common", "programs"]);
  const status = useQuery({ queryKey: mk.profileUse, queryFn: machinesApi.browser.profileUse, retry: false, staleTime: 30_000 });
  const s = status.data;
  const chrome = useQuery({ queryKey: mk.chromeProfiles, queryFn: machinesApi.browser.chromeProfiles, staleTime: 60_000, enabled: !!s?.installed });
  const [source, setSource] = useState(ALL);
  const [log, setLog] = useState<ProfileUseSyncResult | { ok: false; output: string } | null>(null);

  const install = useMutation({
    mutationFn: machinesApi.browser.profileUseInstall,
    onSuccess: (next) => {
      queryClient.setQueryData(mk.profileUse, next);
      if (!next.installed) Alert.alert(t("sync.installUnfinished"), next.detail || undefined);
    },
    onError: (err) => Alert.alert(t("sync.installFailed"), errorText(err)),
  });
  const sync = useMutation({
    mutationFn: () => machinesApi.browser.profileUseSync(source === ALL ? {} : { sourcePath: source }),
    onSuccess: (res) => {
      setLog(res);
      void queryClient.invalidateQueries({ queryKey: mk.profileUse });
    },
    onError: (err) => setLog({ ok: false, output: errorText(err) }),
  });

  // An older Godmode doesn't have it: nothing to show.
  if (status.error instanceof ApiError && (status.error.status === 404 || status.error.status === 501)) return null;
  if (!s) {
    if (status.isLoading) return null;
    return (
      <Group title={t("sync.title")}>
        <TestResult ok={false} title={t("sync.checkFailed")} body={errorText(status.error)} />
        <ActionRow icon="refresh" title={t("common:actions.tryAgain")} onPress={() => void status.refetch()} />
      </Group>
    );
  }

  const ready = s.installed && s.hasApiKey;
  return (
    <Group title={t("sync.title")} footer={sync.isPending ? t("sync.takesMinutes") : t("sync.footer")}>
      <ToolRow
        title="profile-use"
        detail={s.installed ? (s.path ?? undefined) : s.detail || t("programs:notInstalled")}
        ok={s.installed ? true : undefined}
        action={s.installed ? undefined : <ActionPill label={t("programs:install")} busyLabel={t("programs:installing")} busy={install.isPending} onPress={() => install.mutate()} />}
      />
      {s.hasApiKey ? (
        <InfoRow label={t("sync.apiKey")} value={t("sync.apiKeySet")} tone="success" />
      ) : (
        <LinkRow icon="key" title={t("sync.addApiKey")} onPress={() => router.push("/settings/vault/api-keys")} />
      )}
      <InfoRow label={t("sync.lastSync")} value={s.lastSyncAt ? ago(s.lastSyncAt) : t("common:words.never")} />
      {s.installed ? (
        <PickerRow
          title={t("sync.chromeProfile")}
          value={source}
          options={[
            { value: ALL, label: t("sync.allProfiles") },
            ...(chrome.data ?? []).map((p) => ({ value: p.path, label: `${p.browser} · ${p.name}`, detail: p.email ?? undefined })),
          ]}
          onChange={setSource}
        />
      ) : null}
      {ready ? <ActionRow icon="refresh" title={sync.isPending ? t("sync.syncing") : t("sync.sync")} busy={sync.isPending} onPress={() => sync.mutate()} /> : null}
      {log && !sync.isPending ? (
        <TestResult
          ok={log.ok}
          title={log.ok ? ("cloudProfileId" in log && log.cloudProfileId ? t("sync.syncedTo", { id: log.cloudProfileId }) : t("sync.synced")) : t("sync.failed")}
          body={lastLines(log.output, 12) || t("command.noOutput")}
        />
      ) : null}
    </Group>
  );
}
