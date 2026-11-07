import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Icon } from "./icon";
import { Badge, Button, Card, Hairline, Row, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { pairKey, useDismissedLinks } from "@/lib/totp-autolink";
import { fullVaultApi, refreshVault, vk } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

/** "Stripe:dan@x.de" without an issuer reads as service "Stripe", account "dan@x.de". */
function entryLabel(e: TotpEntry): { service: string; account: string } {
  if (e.issuer) return { service: e.issuer, account: e.accountName };
  const i = e.accountName.indexOf(":");
  return i > 0 ? { service: e.accountName.slice(0, i), account: e.accountName.slice(i + 1) } : { service: e.accountName, account: "" };
}

export interface LinkSuggestion {
  key: string;
  credentialId: string;
  totpId: string;
  sure: boolean;
  entry: TotpEntry;
  login: Credential;
}

/** The computer's suggestions this phone didn't hide, with their login and 2FA code. */
export function useLinkSuggestions(entries: TotpEntry[] | undefined, logins: Credential[] | undefined, enabled: boolean): LinkSuggestion[] {
  const dismissed = useDismissedLinks((s) => s.keys);
  const suggestions = useQuery({ queryKey: vk.autolink, queryFn: fullVaultApi.autolinkSuggestions, enabled: enabled && !!entries?.length && !!logins?.length });
  return useMemo(() => {
    const totpById = new Map((entries ?? []).map((e) => [e.id, e]));
    const loginById = new Map((logins ?? []).map((l) => [l.id, l]));
    const out: LinkSuggestion[] = [];
    for (const s of suggestions.data ?? []) {
      const key = pairKey(s);
      const entry = totpById.get(s.totpId);
      const login = loginById.get(s.credentialId);
      if (!dismissed.has(key) && entry && login) out.push({ key, credentialId: s.credentialId, totpId: s.totpId, sure: s.sure, entry, login });
    }
    return out;
  }, [suggestions.data, dismissed, entries, logins]);
}

/**
 * Logins and 2FA codes that clearly belong together, linked in one tap, like the desktop's suggestions above its 2FA
 * list. Sure matches start checked, likely ones unchecked; "Not now" hides the ones shown.
 */
export function TotpAutoLink({ rows }: { rows: LinkSuggestion[] }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const dismiss = useDismissedLinks((s) => s.dismiss);
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [checkedLikely, setCheckedLikely] = useState<Set<string>>(() => new Set());

  const isChecked = (r: { key: string; sure: boolean }) => (unchecked.has(r.key) ? false : r.sure || checkedLikely.has(r.key));
  const selected = rows.filter(isChecked);

  const toggle = (r: { key: string; sure: boolean }) => {
    tap();
    const flip = (set: Set<string>) => {
      const next = new Set(set);
      if (next.has(r.key)) next.delete(r.key);
      else next.add(r.key);
      return next;
    };
    if (r.sure) setUnchecked(flip);
    else setCheckedLikely(flip);
  };

  const link = useMutation({
    mutationFn: () => fullVaultApi.autolink(selected.map(({ credentialId, totpId }) => ({ credentialId, totpId }))),
    onSuccess: (res) => {
      refreshVault();
      if (res.linked.length) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      else Alert.alert(t("autolink.nothing"), t("autolink.nothingBody"));
    },
    onError: (err) => Alert.alert(t("autolink.failed"), errorText(err)),
  });

  if (!rows.length) return null;
  return (
    <Card style={styles.card}>
      <Row style={styles.head}>
        <View style={[styles.tile, { backgroundColor: c.brandSoft }]}>
          <Icon name="link" size={16} color={c.brandStrong} />
        </View>
        <T variant="subhead" style={{ flex: 1, fontWeight: "600" }}>
          {t("autolink.title", { count: rows.length })}
        </T>
      </Row>
      <View>
        {rows.map((r, i) => {
          const checked = isChecked(r);
          const { service, account } = entryLabel(r.entry);
          return (
            <View key={r.key}>
              {i > 0 ? <Hairline inset={space.lg + 22 + space.md} /> : null}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={t("autolink.linkPair", { service, login: r.login.name })}
                onPress={() => toggle(r)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
              >
                <Icon name={checked ? "checkFill" : "circle"} size={22} color={checked ? c.brandStrong : c.textFaint} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                    {account ? `${service} · ${account}` : service}
                  </T>
                  <T variant="footnote" muted numberOfLines={1}>
                    {`→ ${[r.login.name, r.login.username].filter(Boolean).join(" · ")}`}
                  </T>
                </View>
                <Badge label={r.sure ? t("autolink.match") : t("autolink.likely")} tone={r.sure ? "success" : "neutral"} dot={false} />
              </Pressable>
            </View>
          );
        })}
      </View>
      <Row style={styles.actions}>
        <Button title={t("autolink.notNow")} variant="secondary" disabled={link.isPending} onPress={() => dismiss(rows.map((r) => r.key))} style={{ flex: 1 }} />
        <Button
          title={selected.length ? t("autolink.linkCount", { count: selected.length }) : t("autolink.link")}
          icon="link"
          loading={link.isPending}
          disabled={!selected.length}
          onPress={() => link.mutate()}
          style={{ flex: 1 }}
        />
      </Row>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingTop: space.md,
    overflow: "hidden",
  },
  head: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.sm,
  },
  actions: {
    gap: space.sm,
    padding: space.md,
  },
});
