import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshServer, SshTestResult } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { HeaderActions } from "@/components/header-actions";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { Badge, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { ik, integrationsApi, useSshServers } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/**
 * Servers agents sign in to: who, where, and whether signing in works. A full-access phone also adds, edits and deletes
 * them like the desktop; passwords and keys stay write-only.
 */
export default function SshServers() {
  const { t } = useTranslation(["integrations", "ssh"]);
  const admin = !!useFullAccess().fullAccess;
  const list = useSshServers();
  const [results, setResults] = useState<Record<string, SshTestResult>>({});
  const test = useMutation({
    mutationFn: (server: SshServer) => integrationsApi.testSsh(server.id),
    onSuccess: (result, server) => {
      setResults((r) => ({ ...r, [server.id]: result }));
      if (!result.ok) Alert.alert(t("ssh.failedTitle", { name: server.name }), result.error ?? t("ssh.failedBody"));
      void queryClient.invalidateQueries({ queryKey: ik.sshServers });
    },
    onError: (err, server) => Alert.alert(t("ssh.failedTitle", { name: server.name }), errorText(err)),
  });

  return (
    <>
      {admin ? <HeaderActions actions={[{ icon: "plus", label: t("ssh:form.addTitle"), onPress: () => router.push("/settings/ssh-server") }]} /> : null}
      <ReadonlyList<SshServer>
        title={t("ssh.title")}
        query={list}
        items={list.data ?? []}
        keyOf={(s) => s.id}
        extraData={[results, test.isPending ? test.variables?.id : null]}
        icon="server"
        emptyTitle={t("ssh.emptyTitle")}
        emptyBody={t("ssh.emptyBody")}
        failedTitle={t("ssh.loadFailed")}
        renderRow={(s) => {
          const result = results[s.id];
          const testing = test.isPending && test.variables?.id === s.id;
          return (
            <ListRow
              icon="server"
              title={s.name}
              lines={[
                `${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}`,
                s.lastError && !result?.ok ? s.lastError : s.os,
              ]}
              trailing={
                <>
                  {result?.ok ? <Badge label={result.latencyMs !== null ? t("ssh.okMs", { ms: result.latencyMs }) : t("ssh.ok")} tone="success" /> : null}
                  <TestButton testing={testing} disabled={test.isPending} label={t("ssh.test")} onPress={() => test.mutate(s)} a11y={t("ssh.testA11y", { name: s.name })} />
                </>
              }
              onPress={admin ? () => router.push({ pathname: "/settings/ssh-server", params: { id: s.id } }) : undefined}
            />
          );
        }}
      />
    </>
  );
}

function TestButton({ testing, disabled, label, a11y, onPress }: { testing: boolean; disabled: boolean; label: string; a11y: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.test, { backgroundColor: c.sunken, opacity: disabled && !testing ? 0.5 : pressed ? 0.7 : 1 }]}
    >
      {testing ? (
        <ActivityIndicator size="small" />
      ) : (
        <T variant="footnote" style={{ fontWeight: "600" }}>
          {label}
        </T>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  test: {
    minWidth: 56,
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
