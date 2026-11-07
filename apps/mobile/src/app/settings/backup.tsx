import * as DocumentPicker from "expo-document-picker";
import { Directory, File } from "expo-file-system";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { confirmWithBiometrics, FullAccessGate, isRefused, NeedsFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, SwitchRow } from "@/components/form";
import { InputRow } from "@/components/secret-parts";
import { InfoRow } from "@/components/status-rows";
import { Button, T } from "@/components/ui";
import { adminApi, exportBackup, formatBytes } from "@/lib/admin";
import { ApiError, errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { space, useColors } from "@/lib/theme";

/** Settings → Backup: an encrypted backup of the computer saved from the phone, or one restored from a file on it. */
export default function Backup() {
  const { t } = useTranslation("admin");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("backup.title") }} />
      <CloseButton />
      <FullAccessGate>
        <ExportCard />
        <RestoreCard />
      </FullAccessGate>
    </ScrollView>
  );
}

/** The share sheet with the file on iOS; on Android a folder the human picks. */
async function saveFile(file: File): Promise<boolean> {
  if (process.env.EXPO_OS === "ios") {
    const result = await Share.share({ url: file.uri });
    return result.action !== Share.dismissedAction;
  }
  const dir = await Directory.pickDirectoryAsync();
  const target = dir.createFile(file.name, "application/octet-stream");
  await target.write(await file.bytes());
  return true;
}

function ExportCard() {
  const { t } = useTranslation(["admin", "common"]);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [repos, setRepos] = useState(true);
  const [browser, setBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [saved, setSaved] = useState<File | null>(null);

  // The encrypted backup leaves the phone's cache once a newer one replaces it or the screen closes.
  useEffect(
    () => () => {
      try {
        if (saved?.exists) saved.delete();
      } catch {
        /* already gone */
      }
    },
    [saved],
  );

  const mismatch = confirm.length > 0 && confirm !== pass;
  const valid = pass.length >= 8 && pass === confirm;

  const run = async () => {
    if (!valid || busy) return;
    if (!(await confirmWithBiometrics(t("backup.export.faceId")))) return;
    setBusy(true);
    try {
      const file = await exportBackup({ passphrase: pass, includeAgentRepos: repos, includeBrowserProfiles: browser });
      setPass("");
      setConfirm("");
      setSaved(file);
      setBusy(false);
      await saveFile(file).catch(() => undefined);
    } catch (err) {
      if (isRefused(err)) setRefused(true);
      else Alert.alert(t("backup.export.failed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (refused) return <NeedsFullAccess />;
  return (
    <View style={{ gap: space.md }}>
      <Group
        title={t("backup.export.title")}
        footer={mismatch ? t("backup.export.mismatch") : pass.length > 0 && pass.length < 8 ? t("backup.export.minLength") : t("backup.export.note")}
      >
        <InputRow label={t("backup.password")} value={pass} onChangeText={setPass} secure placeholder={t("backup.export.minLength")} />
        <InputRow label={t("backup.export.confirm")} value={confirm} onChangeText={setConfirm} secure onSubmitEditing={() => void run()} />
        <SwitchRow icon="files" title={t("backup.export.repos")} detail={t("backup.export.reposDetail")} value={repos} onChange={setRepos} />
        <SwitchRow icon="globe" title={t("backup.export.browser")} detail={t("backup.export.browserDetail")} value={browser} onChange={setBrowser} />
      </Group>
      <Button title={busy ? t("backup.export.encrypting") : t("backup.export.button")} icon="archive" loading={busy} disabled={!valid} onPress={() => void run()} />
      {saved ? (
        <Group>
          <InfoRow icon="checkCircle" label={saved.name} value={formatBytes(saved.size ?? 0)} tone="success" />
          <LinkRow icon="share" title={t("backup.export.saveAgain")} onPress={() => void saveFile(saved).catch((err) => Alert.alert(t("backup.export.failed"), errorText(err)))} />
        </Group>
      ) : null}
    </View>
  );
}

interface Picked {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

function RestoreCard() {
  const c = useColors();
  const { t } = useTranslation(["admin", "common"]);
  const [file, setFile] = useState<Picked | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ counts: Record<string, number>; warnings: string[] } | null>(null);

  const choose = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets[0]) return;
    const a = picked.assets[0];
    setFile({ uri: a.uri, name: a.name, mime: a.mimeType ?? "application/octet-stream", size: a.size ?? new File(a.uri).size ?? 0 });
    setError(null);
    setResult(null);
  };

  const restore = async () => {
    if (!file || !pass) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApi.backup.restore(file, pass);
      setResult({ counts: res.counts ?? {}, warnings: res.warnings ?? [] });
      setFile(null);
      setPass("");
      void queryClient.invalidateQueries();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 401 || err.status === 422)) setError(err.message || t("backup.restore.wrong"));
      else Alert.alert(t("backup.restore.failed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // Two steps before anything is replaced: the warning, then Face ID.
  const confirmRestore = () => {
    if (!file || !pass) return;
    Alert.alert(t("backup.restore.confirmTitle"), t("backup.restore.confirmBody", { file: file.name }), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("backup.restore.confirm"),
        style: "destructive",
        onPress: async () => {
          if (await confirmWithBiometrics(t("backup.restore.faceId"))) void restore();
        },
      },
    ]);
  };

  if (result) {
    const counts = Object.entries(result.counts).filter(([, n]) => n > 0);
    return (
      <View style={{ gap: space.md }}>
        <Group title={t("backup.restore.title")} footer={t("backup.restore.doneBody")}>
          <InfoRow icon="checkCircle" label={t("backup.restore.doneTitle")} tone="success" />
          {counts.map(([kind, n]) => (
            <InfoRow key={kind} label={kind} value={String(n)} />
          ))}
        </Group>
        {result.warnings.length ? (
          <Group title={t("backup.restore.warnings")}>
            {result.warnings.map((w, i) => (
              <InfoRow key={i} icon="warning" label={t("backup.restore.warning")} detail={w} />
            ))}
          </Group>
        ) : null}
        <Button title={t("backup.restore.another")} variant="outline" onPress={() => setResult(null)} />
      </View>
    );
  }

  return (
    <View style={{ gap: space.md }}>
      <Group
        title={t("backup.restore.title")}
        footer={
          error ? (
            <T variant="footnote" color={c.danger}>
              {error}
            </T>
          ) : (
            t("backup.restore.note")
          )
        }
      >
        <LinkRow
          icon="archiveFile"
          title={file ? file.name : t("backup.restore.choose")}
          detail={file ? formatBytes(file.size) : undefined}
          onPress={() => void choose()}
        />
        <InputRow
          label={t("backup.password")}
          value={pass}
          onChangeText={(next) => {
            setPass(next);
            setError(null);
          }}
          secure
        />
      </Group>
      <Button
        title={busy ? t("backup.restore.restoring") : t("backup.restore.button")}
        icon="refresh"
        variant="danger"
        loading={busy}
        disabled={!file || !pass}
        onPress={confirmRestore}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xxl,
  },
});
