import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CameraView, scanFromURLAsync, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { ClipboardPasteButton } from "expo-clipboard";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isOtpUri, isValidBase32, normalizeBase32, parseOtpUri, reviewOtpUris, type TotpAlgorithm, type TotpEntry, type TotpImportResult } from "@godmode/shared";
import { Group, PickerRow, Segmented } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { LinkPickerRow, type LinkPickerItem } from "@/components/link-picker";
import { OtpImportResult, OtpReviewList } from "@/components/otp-review";
import { PickSheet } from "@/components/pick-sheet";
import { RowPressable } from "@/components/row-pressable";
import { confirmDelete, FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { ago, InfoRow } from "@/components/status-rows";
import { Button, Card, LoadingState, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { qk } from "@/lib/query";
import { domainFromUrl, fullVaultApi, issuerDomain, refreshVault, rootDomain, useLogins, useTotp } from "@/lib/vault";
import { fonts, radius, space, useColors } from "@/lib/theme";

const SAME_CODE_MS = 3000;
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
  const [scanned, setScanned] = useState<string[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<TotpImportResult | null>(null);
  const links = useMemo(() => linksIn(pasted), [pasted]);
  const uris = useMemo(() => (mode === "scan" ? scanned : mode === "links" ? links : []).filter((u) => !removed.has(u)), [mode, scanned, links, removed]);
  const review = useMemo(() => reviewOtpUris(uris), [uris]);
  const [issuer, setIssuer] = useState(entry?.issuer ?? "");
  const [account, setAccount] = useState(entry?.accountName ?? "");
  const [secret, setSecret] = useState("");
  const [credentialId, setCredentialId] = useState(entry?.credentialId ?? "");
  const [workspaceId, setWorkspaceId] = useState(entry?.workspaceId ?? "");
  const [algorithm, setAlgorithm] = useState<TotpAlgorithm>("SHA1");
  const [digits, setDigits] = useState("6");
  const [period, setPeriod] = useState("30");
  const [advanced, setAdvanced] = useState(false);

  const loginItems = useMemo((): LinkPickerItem[] => {
    const root = rootDomain(issuerDomain(issuer));
    const fits = (domain: string) => !!domain && rootDomain(domain) === root;
    return [...(logins.data ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ id: l.id, title: l.name, subtitle: l.username || undefined, domain: l.domains[0] ?? domainFromUrl(l.url), suggested: !!root && (l.domains.some(fits) || fits(domainFromUrl(l.url))) }));
  }, [logins.data, issuer]);
  const workspaceOptions = useMemo(
    () => [{ value: "", label: t("loginEdit.allWorkspaces") }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))],
    [workspaces.data, t],
  );

  /** A pasted link fills in the form; what the form can't hold (an export, a counter code) goes to the review. */
  const changeSecret = (value: string) => {
    const text = value.trim();
    if (!isOtpUri(text)) return setSecret(value);
    const parsed = parseOtpUri(text);
    const key = /[?&]secret=([^&]+)/i.exec(text)?.[1];
    if (parsed.kind === "migration" || (parsed.kind === "otpauth" && key && parsed.preview.type !== "totp")) {
      setSecret("");
      setPasted(text);
      setMode("links");
      return;
    }
    if (parsed.kind !== "otpauth" || !key) return setSecret(value);
    const p = parsed.preview;
    setIssuer(p.issuer === "Unknown" ? issuer : p.issuer);
    setAccount(p.account);
    setAlgorithm(p.algorithm === "SHA256" || p.algorithm === "SHA512" ? p.algorithm : "SHA1");
    setDigits(p.digits === 8 ? "8" : "6");
    setPeriod(String(p.period || 30));
    setSecret(key.replace(/%20/g, ""));
    if (p.algorithm !== "SHA1" || p.digits !== 6 || p.period !== 30) setAdvanced(true);
  };

  const addScanned = (found: string[]) => {
    setRemoved((prev) => new Set([...prev].filter((u) => !found.includes(u))));
    setScanned((prev) => [...prev, ...found.filter((u) => !prev.includes(u))]);
  };
  const removeUri = (uri: string) => setRemoved((prev) => new Set(prev).add(uri));

  const close = () => {
    setSecret("");
    setPasted("");
    refreshVault();
    router.back();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (entry) {
        await fullVaultApi.updateTotp(entry.id, { issuer: issuer.trim(), accountName: account.trim(), workspaceId: workspaceId || null, credentialId: credentialId || null });
        return null;
      }
      if (mode !== "key") {
        const res = await fullVaultApi.importTotp(uris, workspaceId || null);
        // The computer links both sides of the login and the code.
        if (res.imported.length === 1 && credentialId) await fullVaultApi.updateTotp(res.imported[0].id, { credentialId });
        return res;
      }
      await fullVaultApi.createTotp({
        issuer: issuer.trim(),
        accountName: account.trim(),
        secret: normalizeBase32(secret),
        algorithm,
        digits: Number(digits),
        period: Number(period),
        workspaceId: workspaceId || null,
        credentialId: credentialId || null,
      });
      return null;
    },
    onSuccess: (res) => {
      if (!res?.skipped.length && (!res || res.imported.length)) return close();
      setResult(res);
      refreshVault();
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

  const ready = entry ? !!issuer.trim() : mode === "key" ? !!issuer.trim() && isValidBase32(secret) : uris.length > 0;
  const scanning = !entry && mode === "scan";
  const pasting = !entry && mode === "links";

  if (result) {
    return (
      <PickSheet title={t("totpEdit.addTitle")}>
        <OtpImportResult result={result} />
      </PickSheet>
    );
  }

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
        action={entry ? t("common:actions.save") : t("common:actions.add")}
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
          <Scanner onUri={(uri) => addScanned([uri])} />
          <PhotoButton onUris={addScanned} />
        </View>
      ) : pasting ? (
        <LinksBox value={pasted} onChange={setPasted} found={links.length} />
      ) : (
        <>
          <FieldCard>
            <InputRow label={t("totpEdit.service")} value={issuer} onChangeText={setIssuer} placeholder="GitHub" autoCapitalize="words" autoFocus={!entry} />
            <InputRow label={t("totpEdit.account")} value={account} onChangeText={setAccount} placeholder={t("loginEdit.usernamePlaceholder")} keyboardType="email-address" />
            {entry ? null : <InputRow label={t("totpEdit.setupKey")} value={secret} onChangeText={changeSecret} placeholder="JBSW Y3DP EHPK 3PXP" secure mono autoCapitalize="characters" />}
          </FieldCard>
          {!entry && secret.trim() && !isValidBase32(secret) ? (
            <T variant="footnote" color={c.danger} style={styles.note}>
              {t("totpEdit.keyInvalid")}
            </T>
          ) : null}
          {entry ? null : (
            <Group>
              <RowPressable
                accessibilityRole="button"
                accessibilityState={{ expanded: advanced }}
                onPress={() => {
                  tap();
                  setAdvanced((v) => !v);
                }}
                style={styles.advanced}
              >
                <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
                  {t("totpEdit.advanced")}
                </T>
                <Icon name="down" size={12} color={c.textFaint} weight="semibold" style={{ transform: [{ rotate: advanced ? "180deg" : "0deg" }] }} />
              </RowPressable>
              {advanced
                ? [
                    <PickerRow
                      key="algorithm"
                      title={t("totpEdit.algorithm")}
                      value={algorithm}
                      options={[
                        { value: "SHA1", label: t("totpEdit.withDefault", { value: "SHA-1" }) },
                        { value: "SHA256", label: "SHA-256" },
                        { value: "SHA512", label: "SHA-512" },
                      ]}
                      onChange={setAlgorithm}
                    />,
                    <PickerRow
                      key="digits"
                      title={t("totpEdit.digits")}
                      value={digits}
                      options={[
                        { value: "6", label: t("totpEdit.withDefault", { value: "6" }) },
                        { value: "8", label: "8" },
                      ]}
                      onChange={setDigits}
                    />,
                    <PickerRow
                      key="period"
                      title={t("totpEdit.period")}
                      value={period}
                      options={[
                        { value: "30", label: t("totpEdit.withDefault", { value: "30 s" }) },
                        { value: "60", label: "60 s" },
                        ...(period !== "30" && period !== "60" ? [{ value: period, label: `${period} s` }] : []),
                      ]}
                      onChange={setPeriod}
                    />,
                  ]
                : null}
            </Group>
          )}
        </>
      )}

      {scanning || pasting ? <OtpReviewList review={review} onRemove={removeUri} /> : null}

      <Group>
        {pasting ? null : (
          <LinkPickerRow icon="key" title={t("totpEdit.login")} value={credentialId} onChange={setCredentialId} items={loginItems} loading={logins.isLoading} noneLabel={t("totpEdit.noLogin")} searchPlaceholder={t("logins.search")} noun="login" />
        )}
        <PickerRow icon="layers" title={t("loginEdit.availableTo")} value={workspaceId} options={workspaceOptions} onChange={setWorkspaceId} />
      </Group>

      {entry ? (
        <Group>
          <InfoRow label={t("totpEdit.algorithm")} value={algorithmName(entry.algorithm)} />
          <InfoRow label={t("totpEdit.digits")} value={String(entry.digits)} />
          <InfoRow label={t("totpEdit.period")} value={`${entry.period} s`} />
          <InfoRow label={t("totpEdit.type")} value={t("totpEdit.typeTotp")} />
          <InfoRow label={t("totpEdit.added")} value={format(new Date(entry.createdAt), "PP", { locale: dateLocale() })} />
          <InfoRow label={t("totpEdit.lastUsed")} value={entry.lastUsedAt ? ago(entry.lastUsedAt) : t("totpEdit.never")} />
        </Group>
      ) : null}

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

/** "SHA-256" for "SHA256". */
const algorithmName = (algorithm: string) => algorithm.replace(/^SHA/, "SHA-");

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
      {!found && value.trim() ? (
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

/**
 * The camera keeps reading 2FA QR codes (otpauth:// or an authenticator app's export), so all parts of an export go into
 * the review in one go. A code still in view counts once.
 */
function Scanner({ onUri }: { onUri: (uri: string) => void }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const [permission, requestPermission] = useCameraPermissions();
  const seen = useRef({ uri: "", at: 0 });

  const onScanned = ({ data }: BarcodeScanningResult) => {
    const uri = data.trim();
    const now = Date.now();
    const again = seen.current.uri === uri && now - seen.current.at < SAME_CODE_MS;
    seen.current = { uri, at: now };
    if (again || !isOtpUri(uri)) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    onUri(uri);
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
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned} />
    </View>
  );
}

/**
 * QR codes from screenshots in the photo library, read on the phone (several at once for an authenticator's export,
 * like the desktop's screenshot drop).
 */
function PhotoButton({ onUris }: { onUris: (uris: string[]) => void }) {
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
        for (const code of codes) if (isOtpUri(code.data)) found.add(code.data.trim());
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
      onUris([...found]);
    } catch (err) {
      Alert.alert(t("totpEdit.addFailed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return <Button title={t("totpEdit.fromPhotos")} icon="photo" variant="outline" loading={busy} onPress={() => void pick()} />;
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
  advanced: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
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
