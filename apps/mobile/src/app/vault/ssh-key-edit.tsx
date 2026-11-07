import { useMutation } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshManagedKey, SshServer } from "@godmode/shared";
import { Group } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { CopyButton, FieldCard, InputRow, SheetHeader, ValueRow } from "@/components/secret-parts";
import { LoadingState, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { ik, useSshServers } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { copyPlain } from "@/lib/secrets";
import { keyNameProblem } from "@/lib/ssh-keys";
import { fullVaultApi, useSshKeys, vk } from "@/lib/vault";
import { fonts, space, useColors } from "@/lib/theme";

/** One SSH key, like the desktop's open key row: rename it, change its comment, see where it is used, add it to a server. */
export default function SshKeyEdit() {
  const c = useColors();
  const { t } = useTranslation("vault");
  const { name } = useLocalSearchParams<{ name?: string }>();
  const { fullAccess } = useFullAccess();
  const overview = useSshKeys();
  // After a rename the list no longer has this name: the sheet keeps showing the key while it closes.
  const [kept, setKept] = useState<SshManagedKey | null>(null);
  const key = overview.data?.keys.find((k) => k.name === name) ?? kept ?? undefined;

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (!key) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {overview.isLoading ? <LoadingState /> : <T variant="callout" muted style={{ textAlign: "center" }}>{t("sshEdit.gone")}</T>}
      </View>
    );
  }
  return <KeyForm key={key.name} sshKey={key} taken={(overview.data?.keys ?? []).map((k) => k.name).filter((n) => n !== key.name)} onSaved={() => setKept(key)} />;
}

function KeyForm({ sshKey: key, taken, onSaved }: { sshKey: SshManagedKey; taken: string[]; onSaved: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const servers = useSshServers();
  const [name, setName] = useState(key.name);
  const [comment, setComment] = useState(key.comment);
  const [installing, setInstalling] = useState<string | null>(null);
  const nameProblem = keyNameProblem(name, taken);
  const changed = name.trim() !== key.name || (!!key.publicKey && comment.trim() !== key.comment);
  const usable = useMemo(() => (servers.data ?? []).filter((s) => !key.servers.some((u) => u.id === s.id)), [servers.data, key.servers]);

  const save = useMutation({
    mutationFn: () =>
      fullVaultApi.updateSshKey(key.name, {
        name: name.trim() !== key.name ? name.trim() : undefined,
        comment: key.publicKey && comment.trim() !== key.comment ? comment.trim() : undefined,
      }),
    onSuccess: (change) => {
      onSaved();
      router.back();
      void queryClient.invalidateQueries({ queryKey: vk.sshKeys });
      // A rename repoints ~/.ssh/config, which the human should know about.
      if (change.configHosts.length) Alert.alert(t("sshEdit.saved"), t("sshEdit.configUpdated", { hosts: change.configHosts.join(", ") }));
    },
    onError: (err) => Alert.alert(t("sshKeys.changeFailed"), errorText(err)),
  });

  const install = async (server: SshServer) => {
    setInstalling(server.id);
    try {
      const out = await fullVaultApi.installSshKey(key.name, server.id);
      void queryClient.invalidateQueries({ queryKey: vk.sshKeys });
      void queryClient.invalidateQueries({ queryKey: ik.sshServers });
      Alert.alert(out.alreadyThere ? t("sshEdit.alreadyOnServer", { name: key.name, server: out.server }) : t("sshEdit.addedToServer", { name: key.name, server: out.server }));
    } catch (err) {
      Alert.alert(t("sshEdit.addToServerFailed"), errorText(err));
    } finally {
      setInstalling(null);
    }
  };

  const usedBy = [...key.hosts.map((h) => ({ id: `host:${h}`, icon: "terminal" as const, label: h === "*" ? t("sshEdit.allHosts") : h })), ...key.servers.map((s) => ({ id: s.id, icon: "server" as const, label: s.name }))];

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={t("sshEdit.title")} action={t("common:actions.save")} ready={changed && !!name.trim() && !nameProblem} busy={save.isPending} onAction={() => save.mutate()} />

      <View style={{ gap: space.sm }}>
        <FieldCard>
          <InputRow label={t("sshKeys.name")} value={name} onChangeText={setName} mono />
          {key.publicKey ? <InputRow label={t("sshKeys.comment")} value={comment} onChangeText={setComment} placeholder={t("loginEdit.optional")} /> : null}
        </FieldCard>
        {nameProblem ? (
          <T variant="footnote" color={c.danger} style={styles.note}>
            {t(nameProblem)}
          </T>
        ) : null}
      </View>

      {key.publicKey || key.fingerprint || key.randomart ? (
        <FieldCard>
          {key.publicKey ? (
            <ValueRow label={t("sshEdit.publicKey")} value={key.publicKey} trailing={<CopyButton label={t("sshKeys.copyPublicShort")} copy={() => copyPlain(key.publicKey!)} />} />
          ) : null}
          {key.fingerprint ? <ValueRow label={t("sshEdit.fingerprint")} value={key.fingerprint} trailing={<CopyButton label={t("sshEdit.copyFingerprint")} copy={() => copyPlain(key.fingerprint!)} />} /> : null}
          {key.randomart ? (
            // The key's picture, as ssh-keygen draws it, to tell keys apart at a glance (decoration only, like on the desktop).
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.art}>
              <T color={c.textMuted} style={styles.artText}>
                {key.randomart}
              </T>
            </View>
          ) : null}
        </FieldCard>
      ) : null}

      {usedBy.length ? (
        <Group title={t("sshEdit.usedBy")}>
          {usedBy.map((u) => (
            <View key={u.id} style={styles.row}>
              <Icon name={u.icon} size={16} color={c.textMuted} />
              <T variant="callout" numberOfLines={1} style={{ flex: 1 }}>
                {u.label}
              </T>
            </View>
          ))}
        </Group>
      ) : null}

      {key.publicKey && usable.length ? (
        <Group title={t("sshEdit.addToServer")}>
          {usable.map((s) => (
            <Pressable
              key={s.id}
              accessibilityRole="button"
              accessibilityLabel={t("sshEdit.addTo", { server: s.name })}
              disabled={!!installing}
              onPress={() => {
                tap();
                void install(s);
              }}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
            >
              <Icon name="server" size={16} color={c.textMuted} />
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                  {s.name}
                </T>
                <T variant="footnote" muted numberOfLines={1}>
                  {`${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}`}
                </T>
              </View>
              {installing === s.id ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name="plus" size={15} color={c.brandStrong} weight="semibold" />}
            </Pressable>
          ))}
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
  art: {
    alignItems: "center",
    paddingVertical: space.md,
  },
  artText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: 11.5,
    letterSpacing: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 48,
    paddingVertical: 10,
  },
});
