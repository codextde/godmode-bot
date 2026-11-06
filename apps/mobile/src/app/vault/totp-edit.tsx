import { useMutation, useQuery } from "@tanstack/react-query";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TotpEntry } from "@godmode/shared";
import { Group, PickerRow, Segmented } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { confirmDelete, FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { Button, LoadingState, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/query";
import { fullVaultApi, refreshVault, useLogins, useTotp } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

const OTP_URI = /^otpauth(-migration)?:\/\//i;
const normalizeBase32 = (s: string) => s.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
const isBase32 = (s: string) => normalizeBase32(s).length >= 16 && /^[A-Z2-7]+$/.test(normalizeBase32(s));

/** Add a 2FA code (its setup key, a pasted otpauth link or the QR code) or change which login and workspace it is for. */
export default function TotpEdit() {
  const c = useColors();
  const { t } = useTranslation("vault");
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { fullAccess } = useFullAccess();
  const list = useTotp();
  const entry = id ? list.data?.find((e) => e.id === id) : undefined;

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (id && !entry) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {list.isLoading ? <LoadingState /> : <T variant="callout" muted style={{ textAlign: "center" }}>{t("totpEdit.gone")}</T>}
      </View>
    );
  }
  return <TotpForm key={entry?.id ?? "new"} entry={entry ?? null} />;
}

function TotpForm({ entry }: { entry: TotpEntry | null }) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const logins = useLogins();
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const [mode, setMode] = useState<"key" | "scan">("key");
  const [issuer, setIssuer] = useState(entry?.issuer ?? "");
  const [account, setAccount] = useState(entry?.accountName ?? "");
  const [secret, setSecret] = useState("");
  const [credentialId, setCredentialId] = useState(entry?.credentialId ?? "");
  const [workspaceId, setWorkspaceId] = useState(entry?.workspaceId ?? "");

  const loginOptions = useMemo(
    () => [
      { value: "", label: t("totpEdit.noLogin") },
      ...[...(logins.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ value: l.id, label: l.name, detail: l.username || undefined })),
    ],
    [logins.data, t],
  );
  const workspaceOptions = useMemo(
    () => [{ value: "", label: t("loginEdit.allWorkspaces") }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))],
    [workspaces.data, t],
  );

  const importUri = async (uri: string) => {
    const res = await fullVaultApi.importTotp([uri], workspaceId || null);
    if (!res.imported.length) throw new Error(res.skipped[0]?.reason || t("totpEdit.nothingImported"));
    // The computer links both sides of the login and the code.
    if (res.imported.length === 1 && credentialId) await fullVaultApi.updateTotp(res.imported[0].id, { credentialId });
    return res.imported.length;
  };

  const save = useMutation({
    mutationFn: async () => {
      if (entry) {
        await fullVaultApi.updateTotp(entry.id, { issuer: issuer.trim(), accountName: account.trim(), workspaceId: workspaceId || null, credentialId: credentialId || null });
        return;
      }
      if (OTP_URI.test(secret.trim())) {
        await importUri(secret.trim());
        return;
      }
      await fullVaultApi.createTotp({ issuer: issuer.trim(), accountName: account.trim(), secret: normalizeBase32(secret), workspaceId: workspaceId || null, credentialId: credentialId || null });
    },
    onSuccess: () => {
      setSecret("");
      refreshVault();
      router.back();
    },
    onError: (err) => Alert.alert(entry ? t("totpEdit.updateFailed") : t("totpEdit.addFailed"), errorText(err)),
  });

  const remove = useMutation({
    mutationFn: () => fullVaultApi.deleteTotp(entry!.id),
    onSuccess: () => {
      refreshVault();
      router.back();
    },
    onError: (err) => Alert.alert(t("totpEdit.deleteFailed"), errorText(err)),
  });

  const uri = OTP_URI.test(secret.trim());
  const ready = entry ? !!issuer.trim() : uri || (!!issuer.trim() && isBase32(secret));
  const scanning = !entry && mode === "scan";

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <SheetHeader
        title={entry ? t("totpEdit.editTitle") : t("totpEdit.addTitle")}
        action={scanning ? undefined : entry ? t("common:actions.save") : t("common:actions.add")}
        ready={ready}
        busy={save.isPending}
        onAction={() => save.mutate()}
      />

      {entry ? null : (
        <Segmented
          options={[
            { value: "key", label: t("totpEdit.enterKey") },
            { value: "scan", label: t("totpEdit.scan") },
          ]}
          value={mode}
          onChange={setMode}
        />
      )}

      {scanning ? (
        <Scanner onUri={(scanned) => importUri(scanned).then(() => (refreshVault(), router.back()))} />
      ) : (
        <>
          <FieldCard>
            <InputRow label={t("totpEdit.service")} value={issuer} onChangeText={setIssuer} placeholder="GitHub" autoCapitalize="words" autoFocus={!entry} />
            <InputRow label={t("totpEdit.account")} value={account} onChangeText={setAccount} placeholder={t("loginEdit.usernamePlaceholder")} keyboardType="email-address" />
            {entry ? null : <InputRow label={t("totpEdit.setupKey")} value={secret} onChangeText={setSecret} placeholder="JBSW Y3DP EHPK 3PXP" secure mono autoCapitalize="characters" />}
          </FieldCard>
          {!entry && secret.trim() && !uri && !isBase32(secret) ? (
            <T variant="footnote" color={c.danger} style={styles.note}>
              {t("totpEdit.keyInvalid")}
            </T>
          ) : null}
        </>
      )}

      <Group>
        <PickerRow icon="key" title={t("totpEdit.login")} value={credentialId} options={loginOptions} onChange={setCredentialId} />
        <PickerRow icon="layers" title={t("loginEdit.availableTo")} value={workspaceId} options={workspaceOptions} onChange={setWorkspaceId} />
      </Group>

      {entry ? (
        <Button
          title={t("totpEdit.delete")}
          icon="trash"
          variant="danger"
          loading={remove.isPending}
          onPress={() => confirmDelete(t("totpEdit.deleteTitle", { name: entry.issuer || entry.accountName }), t("totpEdit.deleteBody"), t("common:actions.delete"), t("common:actions.cancel"), () => remove.mutate())}
        />
      ) : null}
    </ScrollView>
  );
}

/** The camera, until it reads a 2FA QR code (otpauth:// or an authenticator app's export). */
function Scanner({ onUri }: { onUri: (uri: string) => Promise<unknown> }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  const onScanned = ({ data }: BarcodeScanningResult) => {
    if (handled.current || !OTP_URI.test(data.trim())) return;
    handled.current = true;
    setBusy(true);
    onUri(data.trim()).catch((err: unknown) => {
      Alert.alert(t("totpEdit.addFailed"), errorText(err));
      handled.current = false;
      setBusy(false);
    });
  };

  if (!permission) return <View style={[styles.camera, { backgroundColor: c.sunken }]} />;
  if (!permission.granted) {
    return (
      <View style={[styles.camera, styles.cameraAsk, { backgroundColor: c.sunken }]}>
        <T variant="callout" muted style={{ textAlign: "center" }}>
          {t("totpEdit.cameraNeeded")}
        </T>
        <Button title={t("totpEdit.allowCamera")} icon="camera" variant="outline" onPress={() => void requestPermission()} />
      </View>
    );
  }
  return (
    <View style={[styles.camera, { backgroundColor: "#000" }]}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={busy ? undefined : onScanned} />
      {busy ? <LoadingState style={StyleSheet.absoluteFill} label={t("totpEdit.adding")} /> : null}
    </View>
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
    marginTop: -space.md,
    paddingHorizontal: 4,
  },
  camera: {
    height: 300,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  cameraAsk: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    padding: space.xl,
  },
});
