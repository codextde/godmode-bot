import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { Button, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAppActive } from "@/lib/app-active";
import { clearPickerLeftovers, FileTooBig, pickSecretFile } from "@/lib/picked-file";
import { queryClient } from "@/lib/query";
import { freeKeyName, keyNameProblem, SSH_KEY_NAME } from "@/lib/ssh-keys";
import { fullVaultApi, useSshKeys, vk } from "@/lib/vault";
import { fonts, radius, space, useColors } from "@/lib/theme";

const MAX_FILE = 256 * 1024;

/** An existing key into ~/.ssh of the computer, like the desktop's "Import key": pasted, or a file from the phone. */
export default function SshKeyImport() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const overview = useSshKeys();
  const taken = useMemo(() => (overview.data?.keys ?? []).map((k) => k.name), [overview.data]);
  const [text, setText] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const shownName = name ?? freeKeyName("imported_key", taken);
  const nameProblem = keyNameProblem(shownName, taken);
  const nameError = nameProblem ? t(nameProblem) : null;
  const active = useAppActive();

  // A private key lives in this screen's memory only; copies an interrupted pick left go.
  useEffect(clearPickerLeftovers, []);

  const add = useMutation({
    mutationFn: () => fullVaultApi.importSshKey({ name: shownName.trim(), key: text }),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: vk.sshKeys });
      router.back();
    },
    onError: (err) => Alert.alert(t("sshImport.failed"), errorText(err)),
  });

  const choose = async () => {
    try {
      const picked = await pickSecretFile(MAX_FILE, (f) => f.text());
      if (!picked) return;
      setText(picked.data);
      setFileError(null);
      const stem = picked.name.replace(/\.(pub|pem|key)$/i, "");
      if (SSH_KEY_NAME.test(stem)) setName(freeKeyName(stem, taken));
    } catch (err) {
      setFileError(err instanceof FileTooBig ? t("sshImport.fileTooBig") : errorText(err));
    }
  };

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }

  const problem = fileError ?? nameError;
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={t("sshImport.title")} action={t("sshImport.import")} ready={!!text.trim() && !!shownName.trim() && !nameError} busy={add.isPending} onAction={() => add.mutate()} />
      <View style={{ gap: space.md }}>
        <View style={[styles.paste, { backgroundColor: c.surface, borderColor: c.border }]}>
          {active || !text ? (
            <TextInput
              accessibilityLabel={t("sshImport.paste")}
              value={text}
              onChangeText={setText}
              placeholder={t("sshImport.paste")}
              placeholderTextColor={c.textFaint}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              textContentType="none"
              style={[styles.pasteInput, { color: c.text }]}
            />
          ) : (
            // Out of the app switcher's snapshot.
            <View style={styles.pasteInput} />
          )}
        </View>
        <Button title={t("sshImport.chooseFile")} icon="doc" variant="outline" onPress={() => void choose()} />
      </View>
      <View style={{ gap: space.sm }}>
        <FieldCard>
          <InputRow label={t("sshKeys.name")} value={shownName} onChangeText={setName} mono />
        </FieldCard>
        {problem ? (
          <T variant="footnote" color={c.danger} style={styles.note}>
            {problem}
          </T>
        ) : null}
      </View>
    </ScrollView>
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
  paste: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  pasteInput: {
    minHeight: 160,
    maxHeight: 280,
    padding: space.lg,
    paddingTop: space.lg,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 17,
    textAlignVertical: "top",
  },
  note: {
    paddingHorizontal: 4,
  },
});
