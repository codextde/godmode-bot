import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Credential, CredentialInput, MissingLogin } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Group, PickerRow } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { LinkPickerRow, type LinkPickerItem } from "@/components/link-picker";
import { PasswordGenerator, StrengthBar } from "@/components/password-generator";
import { FieldCard, IconButton, InputRow, SheetHeader } from "@/components/secret-parts";
import { Card, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { isCancelled, reveal } from "@/lib/secrets";
import { domainFromUrl, fullVaultApi, isDomain, issuerDomain, normalizeUrl, prettyName, refreshVault, rootDomain, useLogins, useTotp, withDomains } from "@/lib/vault";
import { fonts, space, useColors } from "@/lib/theme";

const tagsOf = (text: string) => [...new Set(text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];

/**
 * Add a login or change one, like the desktop's login dialog. The password and notes are only sent when typed.
 * `missingLoginId`: a login an agent reported missing, filled in from the report and resolved with the saved login.
 */
export default function LoginEdit() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { id, missingLoginId } = useLocalSearchParams<{ id?: string; missingLoginId?: string }>();
  const { fullAccess } = useFullAccess();
  const logins = useLogins();
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open, enabled: !!missingLoginId });
  const login = id ? logins.data?.find((l) => l.id === id) : undefined;
  const report = missingLoginId ? missing.data?.find((m) => m.id === missingLoginId) : undefined;

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (missingLoginId && missing.isError && !report) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <ErrorState title={t("loginEdit.reportFailed")} error={errorText(missing.error)} onRetry={() => void missing.refetch()} />
      </View>
    );
  }
  if ((id && !login) || (missingLoginId && missing.isLoading)) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {logins.isLoading || missing.isLoading ? <LoadingState /> : <T variant="callout" muted style={{ textAlign: "center" }}>{t("login.gone")}</T>}
      </View>
    );
  }
  return <LoginForm key={login?.id ?? report?.id ?? "new"} login={login ?? null} report={report ?? null} />;
}

function LoginForm({ login, report }: { login: Credential | null; report: MissingLogin | null }) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const totp = useTotp();
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const reportDomain = report ? domainFromUrl(report.url) : "";
  const [name, setName] = useState(login?.name ?? (report ? report.service || prettyName(reportDomain) : ""));
  const [nameTouched, setNameTouched] = useState(!!login || !!report?.service);
  const [url, setUrl] = useState(login?.url ?? (report ? (/^https?:\/\//i.test(report.url) ? report.url : reportDomain ? `https://${reportDomain}` : "") : ""));
  const [domains, setDomains] = useState<string[]>(login?.domains ?? (reportDomain && isDomain(reportDomain) ? [reportDomain] : []));
  // Domains follow the website until they are changed by hand, also on a login whose only domain is its website's.
  const [domainsTouched, setDomainsTouched] = useState(() => !!login && !(login.domains.length === 0 || (login.domains.length === 1 && login.domains[0] === domainFromUrl(login.url))));
  const [domainDraft, setDomainDraft] = useState("");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [generating, setGenerating] = useState(false);
  const [totpId, setTotpId] = useState(login?.totpId ?? "");
  const [workspaceId, setWorkspaceId] = useState(login?.workspaceId ?? report?.workspaceId ?? "");
  const [tags, setTags] = useState(login?.tags.join(", ") ?? "");
  const [notes, setNotes] = useState("");
  const [notesEditable, setNotesEditable] = useState(!login);
  const [revealingNotes, setRevealingNotes] = useState(false);

  const primaryDomain = domains[0] ?? domainFromUrl(url);
  const totpItems = useMemo((): LinkPickerItem[] => {
    const root = primaryDomain ? rootDomain(primaryDomain) : "";
    return [...(totp.data ?? [])]
      .sort((a, b) => a.issuer.localeCompare(b.issuer))
      .map((e) => {
        const domain = issuerDomain(e.issuer);
        return { id: e.id, title: e.issuer || e.accountName || t("totp.unnamed"), subtitle: e.issuer ? e.accountName : undefined, domain, suggested: !!root && !!domain && rootDomain(domain) === root };
      });
  }, [totp.data, primaryDomain, t]);
  const workspaceOptions = useMemo(
    () => [{ value: "", label: t("loginEdit.allWorkspaces") }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))],
    [workspaces.data, t],
  );

  const changeUrl = (next: string) => {
    setUrl(next);
    const d = domainFromUrl(next);
    if (!domainsTouched) setDomains(d && isDomain(d) ? [d] : []);
    if (!nameTouched) setName(prettyName(d));
  };
  const changeDomains = (next: string[]) => {
    setDomains(next);
    setDomainsTouched(true);
  };

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
      const input: CredentialInput = {
        workspaceId: workspaceId || null,
        name: name.trim(),
        url: normalizeUrl(url),
        // A domain still in the field counts too: it's what the human sees when they save.
        domains: withDomains(domains, domainDraft),
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
      let unresolved: unknown = null;
      if (report) await fullVaultApi.resolveMissingLogin(report.id, saved.id).catch((err: unknown) => (unresolved = err));
      return { unresolved };
    },
    onSuccess: ({ unresolved }) => {
      setPassword("");
      setNotes("");
      refreshVault();
      if (report) void queryClient.invalidateQueries({ queryKey: qk.missingLogins });
      if (unresolved) Alert.alert(t("loginEdit.resolveFailed"), errorText(unresolved));
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

      {report ? <ReportNote report={report} /> : null}

      <FieldCard>
        <InputRow
          label={t("loginEdit.name")}
          value={name}
          onChangeText={(next) => {
            setName(next);
            setNameTouched(true);
          }}
          placeholder="GitHub"
          autoCapitalize="words"
          autoFocus={!login && !report}
        />
        <InputRow label={t("login.website")} value={url} onChangeText={changeUrl} placeholder="github.com" keyboardType="url" />
      </FieldCard>

      <DomainList domains={domains} draft={domainDraft} onDraft={setDomainDraft} onChange={changeDomains} />

      <View style={{ gap: space.md }}>
        <FieldCard>
          <InputRow label={t("login.username")} value={username} onChangeText={setUsername} placeholder={t("loginEdit.usernamePlaceholder")} keyboardType="email-address" autoFocus={!!report} />
          <InputRow
            label={t("login.password")}
            value={password}
            onChangeText={setPassword}
            secure
            placeholder={login?.hasPassword ? t("loginEdit.unchanged") : t("loginEdit.optional")}
            trailing={<IconButton icon={generating ? "close" : "wand"} label={generating ? t("common:actions.close") : t("generator.generate")} onPress={() => setGenerating((g) => !g)} />}
          />
        </FieldCard>
        {generating ? (
          <PasswordGenerator
            onUse={(next) => {
              setPassword(next);
              setGenerating(false);
            }}
          />
        ) : password ? (
          <View style={styles.strength}>
            <StrengthBar password={password} userInputs={[name, username, domains[0] ?? domainFromUrl(url)]} />
          </View>
        ) : null}
      </View>

      <Group>
        <LinkPickerRow icon="shield" title={t("login.code")} value={totpId} onChange={setTotpId} items={totpItems} loading={totp.isLoading} noneLabel={t("loginEdit.noCode")} searchPlaceholder={t("totp.search")} noun="code" />
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

/** Who asked for this login and why, like the desktop's note above its form. */
function ReportNote({ report }: { report: MissingLogin }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const { byId } = useAgents();
  const agent = report.agentId ? byId.get(report.agentId) : undefined;
  const service = report.service;
  const title = agent
    ? service
      ? t("loginEdit.agentNeedsFor", { agent: agent.name, service })
      : t("loginEdit.agentNeeds", { agent: agent.name })
    : service
      ? t("loginEdit.someAgentNeedsFor", { service })
      : t("loginEdit.someAgentNeeds");
  return (
    <Card style={[styles.report, { borderColor: c.warning }]}>
      {agent ? <CharacterAvatar agent={agent} size={26} mood="attention" /> : <Icon name="inbox" size={18} color={c.warning} />}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }}>
          {title}
        </T>
        {report.reason ? (
          <T variant="footnote" muted numberOfLines={3}>
            {`“${report.reason}”`}
          </T>
        ) : null}
      </View>
    </Card>
  );
}

/** The sites agents use this login on: each removable, and a field to add another (a domain or a pasted address). */
function DomainList({ domains, draft, onDraft, onChange }: { domains: string[]; draft: string; onDraft: (next: string) => void; onChange: (next: string[]) => void }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const parts = draft.split(/[,\s]+/).filter(Boolean);
  const invalid = parts.some((part) => !isDomain(domainFromUrl(part)));

  const add = () => {
    if (invalid || !parts.length) return;
    onChange(withDomains(domains, draft));
    onDraft("");
  };

  return (
    <View style={{ gap: space.sm }}>
      <Group title={t("loginEdit.domains")}>
        {domains.map((d) => (
          <Row key={d} style={styles.domain}>
            <T variant="callout" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 14 }}>
              {d}
            </T>
            <IconButton icon="minus" label={t("loginEdit.removeDomain", { domain: d })} onPress={() => onChange(domains.filter((x) => x !== d))} />
          </Row>
        ))}
        <Row style={styles.domain}>
          <TextInput
            accessibilityLabel={t("loginEdit.addDomain")}
            value={draft}
            onChangeText={onDraft}
            placeholder={domains.length ? t("loginEdit.addDomain") : "github.com"}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            keyboardType="url"
            returnKeyType="done"
            submitBehavior="submit"
            onSubmitEditing={add}
            style={[styles.domainInput, { color: c.text, fontFamily: fonts.mono }]}
          />
          <IconButton icon="plus" label={t("loginEdit.addDomain")} disabled={!parts.length || invalid} onPress={add} />
        </Row>
      </Group>
      {invalid ? (
        <T variant="footnote" color={c.danger} style={styles.note}>
          {t("loginEdit.domainInvalid")}
        </T>
      ) : null}
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
  strength: {
    paddingHorizontal: 4,
  },
  hiddenNotes: {
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 48,
  },
  report: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  domain: {
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
    minHeight: 48,
  },
  domainInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 13,
  },
  note: {
    paddingHorizontal: 4,
  },
});
