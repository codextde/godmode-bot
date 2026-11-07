import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Credential, MissingLogin, MissingLoginTotpChoices, TotpEntry } from "@godmode/shared";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { SheetHeader } from "@/components/secret-parts";
import { Button, Card, ErrorState, Hairline, LoadingState, Row, SectionTitle, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { domainFromUrl, fullVaultApi, refreshVault, useLogins, useTotp, vk } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

type SiteLogin = MissingLoginTotpChoices["logins"][number];

const LIMIT = 60;

/**
 * A missing-2FA report from the inbox: pick the 2FA code that is already in the vault for its site, and the computer
 * links it to the right login and resolves the report, like the desktop's "Use a saved 2FA code".
 */
export default function LinkTotp() {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fullAccess } = useFullAccess();
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const item = missing.data?.find((m) => m.id === id);

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (!item) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {missing.isLoading ? (
          <LoadingState />
        ) : missing.isError ? (
          <ErrorState title={t("linkTotp.loadFailed")} error={errorText(missing.error)} onRetry={() => void missing.refetch()} />
        ) : (
          <T variant="callout" muted style={{ textAlign: "center" }}>
            {t("linkTotp.gone")}
          </T>
        )}
      </View>
    );
  }
  return <LinkForm item={item} />;
}

function LinkForm({ item }: { item: MissingLogin }) {
  const c = useColors();
  const { t } = useTranslation(["inbox", "common"]);
  const [query, setQuery] = useState("");
  const [totpId, setTotpId] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const choices = useQuery({ queryKey: vk.totpChoices(item.id), queryFn: () => fullVaultApi.totpChoices(item.id) });
  const totp = useTotp();
  const creds = useLogins();

  const host = choices.data?.host || domainFromUrl(item.url) || item.service;
  const logins = choices.data?.logins ?? [];
  const credById = useMemo(() => new Map((creds.data ?? []).map((l) => [l.id, l])), [creds.data]);
  const entries = useMemo(() => totp.data ?? [], [totp.data]);
  const selectedEntry = entries.find((e) => e.id === (totpId ?? choices.data?.suggestedTotpIds[0])) ?? null;
  const login = pickLogin(logins, selectedEntry, loginId);

  const { top, rest, hidden } = useMemo(() => {
    const order = choices.data?.suggestedTotpIds ?? [];
    const suggested = new Set(order);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = entries.filter((e) => {
      if (!tokens.length) return true;
      const linked = e.credentialId ? credById.get(e.credentialId) : undefined;
      const hay = `${e.issuer} ${e.accountName} ${linked?.name ?? ""} ${linked?.domains.join(" ") ?? ""}`.toLowerCase();
      return tokens.every((k) => hay.includes(k));
    });
    const top = hits.filter((e) => suggested.has(e.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const others = hits.filter((e) => !suggested.has(e.id));
    const room = Math.max(0, LIMIT - top.length);
    return { top, rest: others.slice(0, room), hidden: Math.max(0, others.length - room) };
  }, [entries, query, credById, choices.data]);

  const link = useMutation({
    mutationFn: () => fullVaultApi.linkMissingTotp(item.id, { totpId: selectedEntry!.id, credentialId: login?.id }),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      refreshVault();
      void queryClient.invalidateQueries({ queryKey: qk.missingLogins });
      router.back();
    },
    onError: (err) => Alert.alert(t("linkTotp.linkFailed"), errorText(err)),
  });

  const loading = choices.isLoading || totp.isLoading;
  const failed = choices.error ?? totp.error;
  const preview = selectedEntry && login ? outcomeText(t, selectedEntry, login, host, credById) : null;
  const row = (e: TotpEntry) => (
    <CodeRow key={e.id} entry={e} linked={e.credentialId ? credById.get(e.credentialId) : undefined} selected={e.id === selectedEntry?.id} onSelect={() => setTotpId(e.id)} />
  );

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={t("linkTotp.title")} action={t("linkTotp.link")} ready={!!selectedEntry && !!login} busy={link.isPending} onAction={() => link.mutate()} />

      <T variant="subhead" muted style={{ textAlign: "center", paddingHorizontal: space.md }}>
        {host}
      </T>

      {logins.length > 1 ? (
        <View>
          <SectionTitle title={t("linkTotp.loginFor", { host })} />
          <View style={styles.chips}>
            {logins.map((l) => {
              const on = login?.id === l.id;
              return (
                <Pressable
                  key={l.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    tap();
                    setLoginId(l.id);
                  }}
                  style={[styles.chip, { backgroundColor: on ? c.primary : c.sunken }]}
                >
                  <T variant="footnote" numberOfLines={1} color={on ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                    {l.username || l.name}
                  </T>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {choices.isSuccess && !logins.length ? (
        <Card style={[styles.warn, { backgroundColor: c.warningSoft, borderColor: "transparent" }]}>
          <Icon name="warning" size={15} color={c.warning} />
          <T variant="footnote" style={{ flex: 1 }}>
            {t("linkTotp.noLogin", { host })}
          </T>
        </Card>
      ) : null}

      <Card style={{ overflow: "hidden" }}>
        <Row style={styles.search}>
          <Icon name="search" size={15} color={c.textMuted} />
          <TextInput
            accessibilityLabel={t("linkTotp.search")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("linkTotp.search")}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.searchInput, { color: c.text }]}
          />
        </Row>
        <Hairline />
        {loading ? (
          <LoadingState style={{ paddingVertical: space.xl }} />
        ) : failed ? (
          <ErrorState title={t("linkTotp.loadFailed")} error={errorText(failed)} onRetry={() => void Promise.all([choices.refetch(), totp.refetch()])} />
        ) : top.length + rest.length === 0 ? (
          <T variant="subhead" muted style={styles.empty}>
            {query.trim() ? t("linkTotp.noMatch", { query: query.trim() }) : t("linkTotp.noCodes")}
          </T>
        ) : (
          <View style={{ paddingBottom: space.xs }}>
            {top.length ? <Heading title={t("linkTotp.suggestedFor", { host })} /> : null}
            {top.map(row)}
            {rest.length ? <Heading title={top.length || !query.trim() ? t("linkTotp.allCodes") : t("linkTotp.matches")} /> : null}
            {rest.map(row)}
            {hidden > 0 ? (
              <T variant="footnote" muted style={styles.more}>
                {t("linkTotp.hiddenMore", { count: hidden })}
              </T>
            ) : null}
          </View>
        )}
      </Card>

      {preview ? (
        <Row style={styles.preview}>
          <Icon name="link" size={13} color={c.brandStrong} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {preview}
          </T>
        </Row>
      ) : null}

      <Button title={t("linkTotp.importNew")} icon="scan" variant="secondary" onPress={() => router.replace("/vault/totp-edit")} />
    </ScrollView>
  );
}

function Heading({ title }: { title: string }) {
  const c = useColors();
  return (
    <T variant="caption" color={c.textMuted} style={styles.heading}>
      {title.toUpperCase()}
    </T>
  );
}

function CodeRow({ entry, linked, selected, onSelect }: { entry: TotpEntry; linked: Credential | undefined; selected: boolean; onSelect: () => void }) {
  const c = useColors();
  const { t } = useTranslation("inbox");
  const name = entry.issuer || entry.accountName;
  const linkedDomain = linked ? (linked.domains[0] ?? domainFromUrl(linked.url)) : "";
  const detail = [entry.issuer && entry.accountName ? entry.accountName : null, linked ? `${linked.name}${linkedDomain ? ` (${linkedDomain})` : ""}` : t("linkTotp.notLinked")].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={() => {
        tap();
        onSelect();
      }}
      style={({ pressed }) => [styles.code, (pressed || selected) && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.tile, { backgroundColor: selected ? c.surface : c.sunken }]}>
        <T variant="footnote" style={{ fontWeight: "600" }}>
          {name.slice(0, 1).toUpperCase()}
        </T>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {name}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {detail}
        </T>
      </View>
      {selected ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

function pickLogin(logins: SiteLogin[], entry: TotpEntry | null, chosen: string | null): SiteLogin | null {
  if (chosen) return logins.find((l) => l.id === chosen) ?? null;
  const same = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();
  return (entry && (logins.find((l) => l.totpId === entry.id) ?? logins.find((l) => same(l.username, entry.accountName)))) || logins[0] || null;
}

/** What linking does, in the desktop's words: links it, keeps it with a login that covers the site too, or moves it. */
function outcomeText(t: TFunction<["inbox", "common"]>, entry: TotpEntry, login: SiteLogin, host: string, credById: Map<string, Credential>): string {
  const owner = entry.credentialId && entry.credentialId !== login.id ? credById.get(entry.credentialId) : undefined;
  const who = login.username ? `${login.name} · ${login.username}` : login.name;
  if (entry.credentialId === login.id) return t("linkTotp.outcome.alreadyLinked", { who });
  if (!owner) return t("linkTotp.outcome.links", { who });
  const sameAccount = !!owner.username.trim() && owner.username.trim().toLowerCase() === login.username.trim().toLowerCase();
  const ownerCovers = [...owner.domains, domainFromUrl(owner.url)].some((d) => d && (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)));
  if (ownerCovers) return t("linkTotp.outcome.staysCovered", { owner: owner.name, host });
  if (sameAccount) return t("linkTotp.outcome.sameAccount", { owner: owner.name, domain: owner.domains[0] ?? domainFromUrl(owner.url), host });
  return t("linkTotp.outcome.moves", { from: owner.username ? `${owner.name} · ${owner.username}` : owner.name, who });
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
    gap: space.lg,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  chip: {
    height: 32,
    maxWidth: "100%",
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    justifyContent: "center",
  },
  warn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
  },
  search: {
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 12,
  },
  empty: {
    padding: space.xl,
    textAlign: "center",
  },
  heading: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
    letterSpacing: 0.4,
  },
  code: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 9,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  more: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  preview: {
    gap: space.sm,
    alignItems: "flex-start",
    paddingHorizontal: 4,
  },
});
