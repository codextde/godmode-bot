import { Stack } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { Group, SwitchRow } from "@/components/form";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui";
import { adminApi, withVaultGrant } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** Which agents may read passwords and 2FA codes in plain text; giving one that access asks for the vault password. */
export default function SecretAgents() {
  const { t } = useTranslation("admin");
  const agents = useAgents();
  const pull = usePullRefresh(agents.refetch);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const set = async (agent: Agent, reveal: boolean) => {
    setPending((p) => ({ ...p, [agent.id]: reveal }));
    await withVaultGrant(t("security.saveFailed"), (grant) => adminApi.security.agentAccess(agent.id, reveal ? "reveal" : "fill", reveal ? grant : undefined));
    await queryClient.invalidateQueries({ queryKey: qk.agents });
    setPending(({ [agent.id]: _, ...rest }) => rest);
  };

  const list = agents.data ?? [];
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("security.secrets.agents"), headerLargeTitleEnabled: false }} />
      <FullAccessGate skeleton={<SkeletonRows count={5} avatar={30} />}>
        {agents.isLoading ? (
          <SkeletonRows count={5} avatar={30} />
        ) : agents.isError ? (
          <ErrorState title={t("security.agentsFailed")} error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
        ) : !list.length ? (
          <EmptyState icon="agents" title={t("security.agentsEmpty")} />
        ) : (
          <Group>
            {list.map((a) => (
              <SwitchRow
                key={a.id}
                title={a.name}
                detail={a.role || undefined}
                value={pending[a.id] ?? a.permissions.secretAccess === "reveal"}
                disabled={a.id in pending}
                onChange={(on) => void set(a, on)}
              />
            ))}
          </Group>
        )}
      </FullAccessGate>
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
