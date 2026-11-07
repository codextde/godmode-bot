import { useMutation } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { CaptchaSolver, MacPasswordStatus } from "@godmode/shared";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Group } from "@/components/form";
import { Icon } from "@/components/icon";
import { confirmDelete, FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { ago, InfoRow } from "@/components/status-rows";
import { Button, Row, T } from "@/components/ui";
import { api, errorText, request } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { fullVaultApi, secretLabel, useAppSecrets, useMacPassword, useVaultApiTools, vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

type Kind = "secret" | "tool" | "mac";

const SOLVERS: Record<string, CaptchaSolver> = { twocaptcha_api_key: "2captcha", capsolver_api_key: "capsolver", anticaptcha_api_key: "anticaptcha" };

/** A CAPTCHA key saved while solving is off turns that solver on, like on the desktop: a key alone would do nothing. */
async function selectSolverFor(key: string) {
  const solver = SOLVERS[key];
  if (!solver) return;
  const settings = await api.settings.get();
  if (settings.browser.captchaSolver === "off") await request("PUT", "/api/settings", { browser: { captchaSolver: solver } });
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: vk.all });
  void queryClient.invalidateQueries({ queryKey: ["integrations"] });
  void queryClient.invalidateQueries({ queryKey: qk.settings });
}

/**
 * Set, replace or remove one write-only secret: an app key (`kind=secret`, `id` = its name), the key of an agent API
 * (`kind=tool`, `id` = the tool) or this Mac's password (`kind=mac`). What is typed goes to the vault and never back.
 */
export default function KeyEdit() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { kind = "secret", id = "" } = useLocalSearchParams<{ kind?: Kind; id?: string }>();
  const { fullAccess } = useFullAccess();
  const tools = useVaultApiTools(kind === "tool");
  const mac = useMacPassword();
  const secrets = useAppSecrets(kind === "secret");
  const [value, setValue] = useState("");

  const tool = kind === "tool" ? tools.data?.find((x) => x.id === id) : undefined;
  const title = kind === "mac" ? t("index.macPassword") : kind === "tool" ? (tool?.name ?? t("apiKeys.title")) : secretLabel(id);
  const isSet = kind === "mac" ? !!mac.data?.saved : kind === "tool" ? !!tool?.hasKey : !!secrets.data?.find((s) => s.key === id)?.set;

  const save = useMutation({
    // `remove`, not the typed value: what was typed stays out of the mutation cache.
    mutationFn: async (remove: boolean) => {
      const next = remove ? null : kind === "mac" ? value : value.trim();
      if (kind === "mac") return next ? fullVaultApi.saveMacPassword(next) : fullVaultApi.removeMacPassword();
      if (kind === "tool") return fullVaultApi.updateApiTool(id, { apiKey: next ?? "" });
      if (id === "composio_api_key") return fullVaultApi.setComposioKey(next);
      if (!next) return fullVaultApi.deleteSecret(id);
      await fullVaultApi.setSecret(id, next);
      await selectSolverFor(id).catch(() => undefined);
    },
    onSuccess: () => {
      setValue("");
      refresh();
      router.back();
    },
    onError: (err) => Alert.alert(t("keyEdit.saveFailed", { name: title }), errorText(err)),
  });

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }

  const trimmed = value.trim();
  const tooShort = kind === "tool" && !!trimmed && (trimmed.length < 8 || /\s/.test(trimmed));
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={title} action={t("common:actions.save")} ready={!!trimmed && !tooShort} busy={save.isPending} onAction={() => save.mutate(false)} />
      <View style={{ gap: space.sm }}>
        <FieldCard>
          <InputRow
            label={kind === "mac" ? t("keyEdit.password") : t("keyEdit.key")}
            value={value}
            onChangeText={setValue}
            placeholder={isSet ? t("keyEdit.replacePlaceholder") : t("keyEdit.pastePlaceholder")}
            secure
            mono={kind !== "mac"}
            autoFocus
          />
        </FieldCard>
        <T variant="footnote" color={tooShort ? c.danger : c.textMuted} style={styles.note}>
          {tooShort ? t("keyEdit.tooShort") : kind === "mac" ? t("keyEdit.macNote") : t("keyEdit.note")}
        </T>
      </View>
      {kind === "mac" && mac.data?.saved ? <MacUses status={mac.data} /> : null}
      {isSet ? (
        <Button
          title={kind === "mac" ? t("keyEdit.removePassword") : t("keyEdit.removeKey")}
          icon="trash"
          variant="danger"
          disabled={save.isPending}
          onPress={() => confirmDelete(t("apiKeys.removeTitle", { name: title }), kind === "mac" ? t("keyEdit.macRemoveBody") : t("apiKeys.removeBody"), t("common:actions.remove"), t("common:actions.cancel"), () => save.mutate(true))}
        />
      ) : null}
    </ScrollView>
  );
}

/** When agents last used the Mac password and for what. A computer reached through the cloud may not say what for. */
function MacUses({ status }: { status: MacPasswordStatus }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  return (
    <>
      <Group>
        <InfoRow label={t("totpEdit.lastUsed")} value={status.lastUsedAt ? ago(status.lastUsedAt) : t("macPassword.neverUsed")} />
      </Group>
      {status.recent.length ? (
        <Group title={t("macPassword.recent")}>
          {status.recent.map((use) => (
            <Row key={`${use.at}${use.what}`} style={styles.use}>
              <Icon name={use.kind === "run" ? "terminal" : "screens"} size={16} color={c.textMuted} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant={use.kind === "run" ? "mono" : "subhead"} numberOfLines={1}>
                  {use.kind === "run" ? use.what : t("macPassword.filledDialog", { what: use.what })}
                </T>
                <T variant="footnote" color={use.ok ? c.textMuted : c.danger} numberOfLines={1}>
                  {[use.agent, ago(use.at), use.ok ? null : t("macPassword.failed")].filter(Boolean).join(" · ")}
                </T>
              </View>
            </Row>
          ))}
        </Group>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  content: {
    paddingTop: 20,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.xl,
  },
  note: {
    paddingHorizontal: 4,
  },
  use: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
