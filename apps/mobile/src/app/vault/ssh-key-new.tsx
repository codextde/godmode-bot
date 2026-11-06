import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Group, PickerRow, Segmented } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { fullVaultApi, useSshKeys, vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

type Algorithm = "ed25519" | "rsa" | "ecdsa";
const NAME = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*$/;
const BITS: Record<Exclude<Algorithm, "ed25519">, string[]> = { rsa: ["4096", "3072", "2048"], ecdsa: ["256", "384", "521"] };

function freeName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

/** A new key pair in ~/.ssh of the computer, like the desktop's "New key". Only its public half ever shows. */
export default function SshKeyNew() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const overview = useSshKeys();
  const taken = useMemo(() => (overview.data?.keys ?? []).map((k) => k.name), [overview.data]);
  const [algorithm, setAlgorithm] = useState<Algorithm>("ed25519");
  const [bits, setBits] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const shownName = touched ? name : freeName(`id_${algorithm}`, taken);

  const clean = shownName.trim();
  const nameError = !clean ? null : taken.includes(clean) ? t("sshKeys.nameTaken") : !NAME.test(clean) || /\.pub$/i.test(clean) ? t("sshKeys.nameInvalid") : null;

  const make = useMutation({
    mutationFn: () => fullVaultApi.generateSshKey({ name: clean, algorithm, bits: bits ? Number(bits) : undefined, comment: comment.trim() || undefined, passphrase: passphrase || undefined }),
    onSuccess: () => {
      setPassphrase("");
      void queryClient.invalidateQueries({ queryKey: vk.sshKeys });
      router.back();
    },
    onError: (err) => Alert.alert(t("sshKeys.generateFailed"), errorText(err)),
  });

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={t("sshKeys.newKey")} action={t("sshKeys.generate")} ready={!!clean && !nameError} busy={make.isPending} onAction={() => make.mutate()} />
      <Segmented
        options={[
          { value: "ed25519", label: "Ed25519" },
          { value: "rsa", label: "RSA" },
          { value: "ecdsa", label: "ECDSA" },
        ]}
        value={algorithm}
        onChange={(next) => {
          setAlgorithm(next);
          setBits(next === "ed25519" ? "" : BITS[next][0]!);
        }}
      />
      <View style={{ gap: space.sm }}>
        <FieldCard>
          <InputRow
            label={t("sshKeys.name")}
            value={shownName}
            onChangeText={(v) => {
              setTouched(true);
              setName(v);
            }}
            mono
          />
          <InputRow label={t("sshKeys.comment")} value={comment} onChangeText={setComment} placeholder={t("loginEdit.optional")} />
          <InputRow label={t("sshKeys.passphrase")} value={passphrase} onChangeText={setPassphrase} placeholder={t("loginEdit.optional")} secure />
        </FieldCard>
        {nameError ? (
          <T variant="footnote" color={c.danger} style={styles.note}>
            {nameError}
          </T>
        ) : null}
      </View>
      {algorithm !== "ed25519" ? (
        <Group>
          <PickerRow title={t("sshKeys.bitsTitle")} value={bits} options={BITS[algorithm].map((b) => ({ value: b, label: t("sshKeys.bits", { bits: b }) }))} onChange={setBits} />
        </Group>
      ) : null}
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
  note: {
    paddingHorizontal: 4,
  },
});
