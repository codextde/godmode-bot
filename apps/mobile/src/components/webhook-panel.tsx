import { useIsFetching } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { Routine } from "@godmode/shared";
import { confirmWithBiometrics, isRefused } from "./admin";
import { Group, LinkRow } from "./form";
import { CopyButton, SecretRow } from "./secret-parts";
import { ActionRow } from "./tool-form";
import { Row, T } from "./ui";
import { errorText } from "@/lib/api";
import { automationAdmin, curlFor, patchWebhookPath, webhookUrl } from "@/lib/automation-admin";
import { qk } from "@/lib/query";
import { copySecret, useRevealed } from "@/lib/secrets";
import { useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const SHOW_MS = 30_000;

/**
 * A webhook automation's secret URL (desktop: webhook-panel.tsx): hidden until Face ID, copied only after it, and a new
 * one on request. The path is stored encrypted, so it is missing while the vault is locked.
 */
export function WebhookPanel({ routine }: { routine: Routine }) {
  const { t } = useTranslation(["automations", "common", "components"]);
  const settings = useSettings();
  const revealed = useRevealed<string>(SHOW_MS);
  const [revealing, setRevealing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const path = routine.webhookPath;
  const fetching = useIsFetching({ queryKey: qk.routines }) > 0;

  // A list restored at launch has no secret URLs: wait for the fresh one before saying the vault is locked.
  if (!path && fetching) return null;
  if (!path) {
    return (
      <Group title={t("webhook.title")} footer={t("webhook.lockedHint")}>
        <LinkRow icon="lock" title={t("webhook.locked")} onPress={() => router.push("/vault/passphrase")} />
      </Group>
    );
  }

  const { url, local } = webhookUrl(path, settings.data?.server);
  const reason = t("webhook.faceId", { name: routine.name });
  const show = async () => {
    setRevealing(true);
    try {
      if (await confirmWithBiometrics(reason)) revealed.show(url);
    } finally {
      setRevealing(false);
    }
  };
  const copy = async (text: string) => {
    if (revealed.value === null && !(await confirmWithBiometrics(reason))) return false;
    await copySecret(text);
    return true;
  };
  const rotate = () =>
    Alert.alert(t("webhook.rotateTitle", { name: routine.name }), t("webhook.rotateDescription"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("webhook.rotate"),
        style: "destructive",
        onPress: () => {
          setRotating(true);
          revealed.hide();
          automationAdmin
            .rotateWebhook(routine.id)
            .then(({ webhookPath }) => {
              patchWebhookPath(routine.id, webhookPath);
              Alert.alert(t("webhook.rotated"), t("webhook.rotatedDescription"));
            })
            .catch((err) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("webhook.rotateFailed"), isRefused(err) ? undefined : errorText(err)))
            .finally(() => setRotating(false));
        },
      },
    ]);

  return (
    <Group title={t("webhook.title")} footer={[local ? t("webhook.localOnly") : null, t("webhook.warning")].filter(Boolean).join("\n\n")}>
      <SecretRow
        label={t("webhook.urlLabel")}
        value={revealed.value}
        shownAt={revealed.shownAt}
        ttlMs={SHOW_MS}
        placeholder="http://••••••/hooks/••••••••"
        onReveal={() => void show()}
        onHide={revealed.hide}
        onCopy={() => copy(url)}
        revealing={revealing}
      />
      <CopyRow label={t("webhook.copyCurl")} copy={() => copy(curlFor(url))} />
      <ActionRow icon="refresh" title={t("webhook.rotate")} busy={rotating} onPress={rotate} tone="danger" />
    </Group>
  );
}

/** "Copy curl command" with the copy button's check. */
function CopyRow({ label, copy }: { label: string; copy: () => Promise<boolean> }) {
  return (
    <Row style={{ gap: space.md, paddingHorizontal: space.lg, minHeight: 52 }}>
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
        {label}
      </T>
      <CopyButton label={label} copy={copy} />
    </Row>
  );
}
