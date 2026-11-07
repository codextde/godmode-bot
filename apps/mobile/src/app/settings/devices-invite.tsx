import { useMutation } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { confirmWithBiometrics, FullAccessGate, isRefused, NeedsFullAccess } from "@/components/admin";
import { CodeBlock } from "@/components/linking-parts";
import { FormSkeleton } from "@/components/settings-state";
import { Button, EmptyState, ErrorState, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { clock, linkingApi } from "@/lib/linking";
import { queryClient } from "@/lib/query";
import { sq } from "@/lib/settings-api";
import { space } from "@/lib/theme";

/** Settings → Devices → Add a computer: an invite to paste in Godmode on the other Mac. */
export default function DevicesInvite() {
  const { t } = useTranslation("linking");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("devices.add") }} />
      <FullAccessGate>
        <Invite />
      </FullAccessGate>
    </ScrollView>
  );
}

function Invite() {
  const { t } = useTranslation(["linking", "common"]);
  const create = useMutation({
    mutationFn: linkingApi.devices.invite,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sq.devices }),
  });
  const started = useRef(false);
  const now = useNow(1000);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  // An invite lets a computer take this one's agents and logins: Face ID first.
  const ask = useCallback(async () => {
    const ok = await confirmWithBiometrics(t("invite.faceId"));
    setAllowed(ok);
    if (ok) create.mutate();
  }, [create, t]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ask();
  }, [ask]);

  if (allowed === false) return <EmptyState icon="faceid" title={t("invite.locked")} action={<Button title={t("invite.confirm")} variant="outline" onPress={() => void ask()} />} />;
  if (create.isError) {
    if (isRefused(create.error)) return <NeedsFullAccess />;
    return <ErrorState title={t("invite.failed")} error={errorText(create.error)} onRetry={() => create.mutate()} />;
  }
  const invite = create.data;
  if (!invite) return <FormSkeleton groups={1} rows={3} />;

  const remaining = Math.max(0, Math.round((new Date(invite.expiresAt).getTime() - now) / 1000));
  const expired = remaining === 0;

  return (
    <>
      <CodeBlock text={invite.code} dimmed={expired || create.isPending} />
      <T variant="footnote" muted style={styles.note}>
        {expired ? t("invite.expired") : t("invite.valid", { time: clock(remaining) })}
      </T>
      <T variant="subhead" muted style={styles.note}>
        {t("invite.how")}
      </T>
      <Button title={t("invite.new")} icon="refresh" variant="outline" loading={create.isPending} onPress={() => create.mutate()} />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.lg,
  },
  note: {
    paddingHorizontal: 4,
  },
});
