import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { keepGrant, settleGrant } from "@/lib/secrets";
import { fullVaultApi, vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

/**
 * The vault password, typed on the phone: `mode=unlock` opens the vault for agents; `mode=grant` (asked by a reveal)
 * confirms it's the human, for 10 minutes. Closing the sheet cancels the reveal that asked.
 */
export default function Passphrase() {
  const c = useColors();
  const { t } = useTranslation("vault");
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const unlock = mode === "unlock";
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);
  const open = useRef(true);

  useEffect(
    () => () => {
      open.current = false;
      if (!unlock && !settled.current) settleGrant(null);
    },
    [unlock],
  );

  const submit = async () => {
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (unlock) {
        const status = await fullVaultApi.unlock(passphrase);
        queryClient.setQueryData(vk.status, status);
        void queryClient.invalidateQueries({ queryKey: vk.all });
        void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      } else {
        const res = await fullVaultApi.grant(passphrase);
        keepGrant(res);
        if (!open.current) return;
        settled.current = true;
        settleGrant(res.grant);
      }
      // Swiped away while it was checking: the screen below stays.
      if (!open.current) return;
      setPassphrase("");
      router.back();
    } catch (err) {
      if (!open.current) return;
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <SheetHeader title={unlock ? t("passphrase.unlockTitle") : t("passphrase.title")} action={unlock ? t("passphrase.unlock") : t("passphrase.confirm")} ready={!!passphrase} busy={busy} onAction={() => void submit()} />
      <View style={{ gap: space.sm }}>
        <FieldCard>
          <InputRow label={t("passphrase.label")} value={passphrase} onChangeText={(v) => (setPassphrase(v), setError(null))} secure autoFocus onSubmitEditing={() => void submit()} />
        </FieldCard>
        {error || !unlock ? (
          <T variant="footnote" color={error ? c.danger : c.textMuted} style={styles.note}>
            {error ?? t("passphrase.note")}
          </T>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
