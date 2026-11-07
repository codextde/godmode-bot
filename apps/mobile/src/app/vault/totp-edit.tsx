import { useMutation, useQuery } from "@tanstack/react-query";
import { CameraView, scanFromURLAsync, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { ClipboardPasteButton } from "expo-clipboard";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TotpEntry, TotpImportResult } from "@godmode/shared";
import { Group, PickerRow, Segmented } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { confirmDelete, FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { Button, Card, LoadingState, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/query";
import { fullVaultApi, refreshVault, useLogins, useTotp } from "@/lib/vault";
import { fonts, radius, space, useColors } from "@/lib/theme";

const OTP_URI = /^otpauth(-migration)?:\/\//i;
const normalizeBase32 = (s: string) => s.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
const isBase32 = (s: string) => normalizeBase32(s).length >= 16 && /^[A-Z2-7]+$/.test(normalizeBase32(s));
/** Every otpauth:// (or an authenticator's export) link in pasted text, once each. */
const linksIn = (text: string) => [...new Set(text.match(/otpauth(?:-migration)?:\/\/[^\s"'<>]+/gi) ?? [])];

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
  const [mode, setMode] = useState<"key" | "scan" | "links">("key");
  const [pasted, setPasted] = useState("");
  const links = useMemo(() => linksIn(pasted), [pasted]);
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

  const importUris = async (uris: string[]) => {
    const res = await fullVaultApi.importTotp(uris, workspaceId || null);
    if (!res.imported.length) throw new Error(res.skipped[0]?.reason || t("totpEdit.nothingImported"));
    // The computer links both sides of the login and the code.
    if (res.imported.length === 1 && credentialId) await fullVaultApi.updateTotp(res.imported[0].id, { credentialId });
    return res.imported.length;
  };

  /** Several links at once: what was added, and a note on what the computer skipped and why. */
  const importLinks = async () => {
    const res = await fullVaultApi.importTotp(links, workspaceId || null);
    if (!res.imported.length) throw new Error(skippedText(res) || t("totpEdit.nothingImported"));
    if (res.skipped.length) Alert.alert(t("totpLinks.added", { count: res.imported.length }), `${t("totpLinks.skipped", { count: res.skipped.length })}\n\n${skippedText(res)}`);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!entry && mode === "links") {
        await importLinks();
        return;
      }
      if (entry) {
        await fullVaultApi.updateTotp(entry.id, { issuer: issuer.trim(), accountName: account.trim(), workspaceId: workspaceId || null, credentialId: credentialId || null });
        return;
      }
      if (OTP_URI.test(secret.trim())) {
        await importUris([secret.trim()]);
        return;
      }
      await fullVaultApi.createTotp({ issuer: issuer.trim(), accountName: account.trim(), secret: normalizeBase32(secret), workspaceId: workspaceId || null, credentialId: credentialId || null });
    },
    onSuccess: () => {
      setSecret("");
      setPasted("");
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
  const ready = entry ? !!issuer.trim() : mode === "links" ? links.length > 0 : uri || (!!issuer.trim() && isBase32(secret));
  const scanning = !entry && mode === "scan";
  const pasting = !entry && mode === "links";

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
            { value: "key", label: t("totpLinks.key") },
            { value: "scan", label: t("totpLinks.qr") },
            { value: "links", label: t("totpLinks.links") },
          ]}
          value={mode}
          onChange={setMode}
        />
      )}

      {scanning ? (
        <View style={{ gap: space.md }}>
          <Scanner onUri={(scanned) => importUris([scanned]).then(() => (refreshVault(), router.back()))} />
          <PhotoButton onUris={(uris) => importUris(uris).then(() => (refreshVault(), router.back()))} />
        </View>
      ) : pasting ? (
        <LinksBox value={pasted} onChange={setPasted} found={links.length} />
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
        {pasting ? null : <PickerRow icon="key" title={t("totpEdit.login")} value={credentialId} options={loginOptions} onChange={setCredentialId} />}
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

/** "GitHub · dan@x.de: already in the vault", one per line. */
function skippedText(res: TotpImportResult): string {
  return res.skipped.map((s) => [s.label || labelOf(s.uri), s.reason].filter(Boolean).join(": ")).join("\n");
}

/** "otpauth://totp/GitHub:dan@x.de?…" → "GitHub · dan@x.de". */
function labelOf(uri: string): string {
  const m = /^otpauth:\/\/[^/]+\/([^?]*)/i.exec(uri.trim());
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]!).split(":").map((part) => part.trim()).filter(Boolean).join(" · ");
  } catch {
    return m[1]!;
  }
}

/**
 * Several otpauth:// links pasted at once (one per line, or an export of them): the desktop takes them one paste at a
 * time, the phone all together.
 */
function LinksBox({ value, onChange, found }: { value: string; onChange: (next: string) => void; found: number }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const add = (text: string) => {
    if (!text.trim()) return;
    onChange(value.trim() ? `${value.trim()}\n${text.trim()}` : text.trim());
  };
  return (
    <View style={{ gap: space.sm }}>
      <Card style={styles.links}>
        <TextInput
          accessibilityLabel={t("totpLinks.links")}
          value={value}
          onChangeText={onChange}
          placeholder={"otpauth://totp/GitHub:you@example.com?secret=…\notpauth://totp/…"}
          placeholderTextColor={c.textFaint}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          textContentType="oneTimeCode"
          style={[styles.linksInput, { color: c.text, fontFamily: fonts.mono }]}
        />
      </Card>
      {found ? (
        <T variant="footnote" muted style={styles.count}>
          {t("totpLinks.found", { count: found })}
        </T>
      ) : value.trim() ? (
        <T variant="footnote" color={c.danger} style={styles.count}>
          {t("totpLinks.none")}
        </T>
      ) : null}
      {Clipboard.isPasteButtonAvailable ? (
        // The system's Paste control reads the clipboard without asking each time.
        <ClipboardPasteButton
          acceptedContentTypes={["plain-text"]}
          onPress={(data) => data.type === "text" && add(data.text)}
          backgroundColor={c.sunken}
          foregroundColor={c.text}
          cornerStyle="medium"
          displayMode="iconAndLabel"
          style={styles.paste}
        />
      ) : (
        <Button title={t("totpLinks.paste")} icon="copy" variant="outline" onPress={() => void Clipboard.getStringAsync().then(add, () => undefined)} />
      )}
    </View>
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

/**
 * QR codes from screenshots in the photo library, read on the phone (several at once for an authenticator's export,
 * like the desktop's screenshot drop).
 */
function PhotoButton({ onUris }: { onUris: (uris: string[]) => Promise<unknown> }) {
  const { t } = useTranslation("vault");
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, orderedSelection: true, quality: 1 });
    if (picked.canceled || !picked.assets.length) return;
    setBusy(true);
    try {
      const found = new Set<string>();
      let qr = 0;
      for (const asset of picked.assets) {
        const codes = await scanFromURLAsync(asset.uri, ["qr"]).catch(() => []);
        qr += codes.length;
        for (const code of codes) if (OTP_URI.test(code.data.trim())) found.add(code.data.trim());
        // The picker's copy shows a 2FA secret: it goes once it is read.
        try {
          new File(asset.uri).delete();
        } catch {
          // Already gone.
        }
      }
      if (!found.size) {
        Alert.alert(qr ? t("totpEdit.notOtp") : t("totpEdit.noQr"));
        return;
      }
      await onUris([...found]);
    } catch (err) {
      Alert.alert(t("totpEdit.addFailed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return <Button title={busy ? t("totpEdit.adding") : t("totpEdit.fromPhotos")} icon="photo" variant="outline" loading={busy} onPress={() => void pick()} />;
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
  links: {
    padding: space.md,
  },
  linksInput: {
    minHeight: 140,
    maxHeight: 280,
    fontSize: 12,
    lineHeight: 17,
    textAlignVertical: "top",
  },
  count: {
    paddingHorizontal: 4,
  },
  paste: {
    height: 44,
    width: "100%",
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
