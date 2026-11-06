import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Credential, CredentialInput } from "@godmode/shared";
import { Group, PickerRow } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { LoadingState, Row, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/query";
import { isCancelled, reveal } from "@/lib/secrets";
import { domainFromUrl, fullVaultApi, normalizeUrl, refreshVault, useLogins, useTotp } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

const tagsOf = (text: string) => [...new Set(text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];

/** Add a login or change one, like the desktop's login dialog. The password and notes are only sent when typed. */
export default function LoginEdit() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { fullAccess } = useFullAccess();
  const logins = useLogins();
  const login = id ? logins.data?.find((l) => l.id === id) : undefined;

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (id && !login) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {logins.isLoading ? <LoadingState /> : <T variant="callout" muted style={{ textAlign: "center" }}>{t("login.gone")}</T>}
      </View>
    );
  }
  return <LoginForm key={login?.id ?? "new"} login={login ?? null} />;
}

function LoginForm({ login }: { login: Credential | null }) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const totp = useTotp();
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const [name, setName] = useState(login?.name ?? "");
  const [url, setUrl] = useState(login?.url ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [totpId, setTotpId] = useState(login?.totpId ?? "");
  const [workspaceId, setWorkspaceId] = useState(login?.workspaceId ?? "");
  const [tags, setTags] = useState(login?.tags.join(", ") ?? "");
  const [notes, setNotes] = useState("");
  const [notesEditable, setNotesEditable] = useState(!login);
  const [revealingNotes, setRevealingNotes] = useState(false);

  const totpOptions = useMemo(
    () => [
      { value: "", label: t("loginEdit.noCode") },
      ...[...(totp.data ?? [])]
        .sort((a, b) => a.issuer.localeCompare(b.issuer))
        .map((e) => ({ value: e.id, label: e.issuer || e.accountName || t("totp.unnamed"), detail: e.issuer ? e.accountName : undefined })),
    ],
    [totp.data, t],
  );
  const workspaceOptions = useMemo(
    () => [{ value: "", label: t("loginEdit.allWorkspaces") }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))],
    [workspaces.data, t],
  );

  const showNotes = async () => {
    if (!login) return;
    setRevealingNotes(true);
    try {
      const res = await reveal(t("login.revealReason", { name: login.name }), (grant) => fullVaultApi.revealLogin(login.id, grant));
      setNotes(res.notes ?? "");
      setNotesEditable(true);
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("login.revealFailed"), errorText(err));
    } finally {
      setRevealingNotes(false);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      const domain = domainFromUrl(url);
      let domains = login?.domains ?? (domain ? [domain] : []);
      if (login && url.trim() !== login.url) {
        const before = domainFromUrl(login.url);
        if (!login.domains.length || (login.domains.length === 1 && login.domains[0] === before)) domains = domain ? [domain] : [];
      }
      const input: CredentialInput = {
        workspaceId: workspaceId || null,
        name: name.trim(),
        url: normalizeUrl(url),
        domains,
        username: username.trim(),
        totpId: totpId || null,
        tags: tagsOf(tags),
      };
      if (password) input.password = password;
      if (notesEditable) input.notes = notes;
      const saved = login ? await fullVaultApi.updateLogin(login.id, input) : await fullVaultApi.createLogin(input);
      // Both sides of the login and 2FA link stay in step, like on the desktop.
      const previous = login?.totpId ?? null;
      if ((totpId || null) !== previous) {
        if (totpId) await fullVaultApi.updateTotp(totpId, { credentialId: saved.id }).catch(() => undefined);
        const prev = previous ? totp.data?.find((e) => e.id === previous) : undefined;
        if (prev && prev.credentialId === saved.id) await fullVaultApi.updateTotp(prev.id, { credentialId: null }).catch(() => undefined);
      }
      return saved;
    },
    onSuccess: () => {
      setPassword("");
      setNotes("");
      refreshVault();
      router.back();
    },
    onError: (err) => Alert.alert(login ? t("loginEdit.updateFailed") : t("loginEdit.saveFailed"), errorText(err)),
  });

  const ready = !!name.trim();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <SheetHeader title={login ? t("loginEdit.editTitle") : t("loginEdit.addTitle")} action={login ? t("common:actions.save") : t("common:actions.add")} ready={ready} busy={save.isPending} onAction={() => save.mutate()} />

      <FieldCard>
        <InputRow label={t("loginEdit.name")} value={name} onChangeText={setName} placeholder="GitHub" autoCapitalize="words" autoFocus={!login} />
        <InputRow label={t("login.website")} value={url} onChangeText={setUrl} placeholder="github.com" keyboardType="url" />
      </FieldCard>

      <FieldCard>
        <InputRow label={t("login.username")} value={username} onChangeText={setUsername} placeholder={t("loginEdit.usernamePlaceholder")} keyboardType="email-address" />
        <InputRow
          label={t("login.password")}
          value={password}
          onChangeText={setPassword}
          secure
          placeholder={login?.hasPassword ? t("loginEdit.unchanged") : t("loginEdit.optional")}
        />
      </FieldCard>

      <Group>
        <PickerRow icon="shield" title={t("login.code")} value={totpId} options={totpOptions} onChange={setTotpId} />
        <PickerRow icon="layers" title={t("loginEdit.availableTo")} value={workspaceId} options={workspaceOptions} onChange={setWorkspaceId} />
      </Group>

      <FieldCard>
        <InputRow label={t("login.tags")} value={tags} onChangeText={setTags} placeholder={t("loginEdit.tagsPlaceholder")} />
        {notesEditable ? (
          <InputRow label={t("login.notes")} value={notes} onChangeText={setNotes} placeholder={t("loginEdit.optional")} autoCapitalize="sentences" multiline />
        ) : (
          <Row style={styles.hiddenNotes}>
            <T variant="callout" style={{ width: 112, fontWeight: "500" }}>
              {t("login.notes")}
            </T>
            <T variant="callout" muted style={{ flex: 1 }}>
              {t("loginEdit.notesHidden")}
            </T>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              disabled={revealingNotes}
              onPress={() => {
                tap();
                void showNotes();
              }}
            >
              {revealingNotes ? (
                <ActivityIndicator size="small" color={c.textMuted} />
              ) : (
                <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
                  {t("loginEdit.showNotes")}
                </T>
              )}
            </Pressable>
          </Row>
        )}
      </FieldCard>
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
  hiddenNotes: {
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 48,
  },
});
