import { router } from "expo-router";
import { memo, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TotpEntry } from "@godmode/shared";
import { confirmWithBiometrics, useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { confirmDelete, CountdownRing, RowMenu } from "@/components/secret-parts";
import { TotpAutoLink, useLinkSuggestions } from "@/components/totp-autolink";
import { Badge, Row, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { copySecret, formatCode, maskedCode, useLiveCodes, useRevealed, type LiveCode } from "@/lib/secrets";
import { fullVaultApi, isVaultLocked, refreshVault, useLogins, useTotp } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

const SHOW_MS = 3 * 60_000;

/**
 * 2FA entries by service and account, and the login each belongs to. With full access the codes show after Face ID
 * (all of them, until the screen is left) and a tap copies one; entries are added, edited and deleted here too.
 */
export default function TwoFactor() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const list = useTotp();
  const logins = useLogins();
  const [search, setSearch] = useState("");
  const shown = useRevealed<true>(SHOW_MS);
  const live = useLiveCodes(!!fullAccess && !!shown.value);
  const names = useMemo(() => new Map((logins.data ?? []).map((c) => [c.id, c.name])), [logins.data]);
  const suggestions = useLinkSuggestions(list.data, logins.data, !!fullAccess);
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    return q ? all.filter((e) => `${e.issuer} ${e.accountName}`.toLowerCase().includes(q)) : all;
  }, [list.data, search]);

  const showCodes = async () => {
    if (await confirmWithBiometrics(t("totp.revealAllReason"))) shown.show(true);
  };
  const remove = (entry: TotpEntry) =>
    confirmDelete(t("totpEdit.deleteTitle", { name: entry.issuer || entry.accountName }), t("totpEdit.deleteBody"), t("common:actions.delete"), t("common:actions.cancel"), () => {
      fullVaultApi
        .deleteTotp(entry.id)
        .then(refreshVault)
        .catch((err: unknown) => Alert.alert(t("totpEdit.deleteFailed"), errorText(err)));
    });

  const linkedName = (e: TotpEntry) => (e.credentialId && names.get(e.credentialId) && names.get(e.credentialId) !== e.issuer ? t("totp.linkedTo", { name: names.get(e.credentialId) }) : null);

  return (
    <>
      {fullAccess ? (
        <HeaderActions
          actions={[
            shown.value
              ? { icon: "incognito", label: t("totp.hideCodes"), onPress: shown.hide }
              : { icon: "eye", label: t("totp.showCodes"), onPress: () => void showCodes() },
            { icon: "plus", label: t("totpEdit.addTitle"), onPress: () => router.push("/vault/totp-edit") },
          ]}
        />
      ) : null}
      <ReadonlyList<TotpEntry>
        title={t("totp.title")}
        query={list}
        items={items}
        keyOf={(e) => e.id}
        extraData={[names, fullAccess, shown.value, live.codes]}
        search={{ placeholder: t("totp.search"), value: search, onChange: setSearch }}
        icon="shield"
        emptyTitle={t("totp.emptyTitle")}
        failedTitle={t("totp.loadFailed")}
        header={
          (suggestions.length && !search.trim()) || (shown.value && live.error && !live.codes.size) ? (
            <View style={{ gap: space.md }}>
              {suggestions.length && !search.trim() ? <TotpAutoLink rows={suggestions} /> : null}
              {shown.value && live.error && !live.codes.size ? (
                <T variant="footnote" color={c.danger}>
                  {isVaultLocked(live.error) ? t("totp.locked") : `${t("totp.codesFailed")} ${errorText(live.error)}`}
                </T>
              ) : null}
            </View>
          ) : undefined
        }
        renderRow={(e) =>
          fullAccess ? (
            <CodeRow
              entry={e}
              line={[e.issuer ? e.accountName : null, linkedName(e)].filter(Boolean).join(" · ")}
              code={shown.value ? live.codes.get(e.id) : undefined}
              shown={!!shown.value}
              onShow={() => void showCodes()}
              onEdit={() => router.push({ pathname: "/vault/totp-edit", params: { id: e.id } })}
              onDelete={() => remove(e)}
            />
          ) : (
            <ListRow
              icon="shield"
              title={e.issuer || e.accountName || t("totp.unnamed")}
              lines={[e.issuer ? e.accountName : null, linkedName(e)]}
              trailing={e.credentialId ? null : <Badge label={t("totp.notLinked")} dot={false} />}
            />
          )
        }
      />
    </>
  );
}

/** One entry: dots until the codes show, then its live code; a tap copies it. */
const CodeRow = memo(function CodeRow({
  entry,
  line,
  code,
  shown,
  onShow,
  onEdit,
  onDelete,
}: {
  entry: TotpEntry;
  line: string;
  code: LiveCode | undefined;
  shown: boolean;
  onShow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const now = useNow(shown ? 500 : 60_000);
  const [copied, setCopied] = useState(false);
  const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;
  const name = entry.issuer || entry.accountName || t("totp.unnamed");
  const visible = shown && code && remaining > 0;

  const press = () => {
    tap();
    if (!shown) return onShow();
    if (!visible) return;
    void copySecret(code.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={visible ? t("totp.copy", { name }) : t("totp.showCodes")} onPress={press} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <T variant="callout" style={{ fontWeight: "600" }}>
          {name.slice(0, 1).toUpperCase()}
        </T>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {name}
        </T>
        <T variant="headline" color={visible ? (copied ? c.brandStrong : c.text) : c.textFaint} style={{ fontVariant: ["tabular-nums"], letterSpacing: visible ? 1 : 2 }}>
          {copied ? t("totp.copied") : visible ? formatCode(code.code) : maskedCode(entry.digits)}
        </T>
        {line ? (
          <T variant="footnote" muted numberOfLines={1}>
            {line}
          </T>
        ) : null}
      </View>
      <Row style={{ gap: space.sm }}>
        {visible ? <CountdownRing remaining={remaining} period={code.period} size={20} /> : null}
        <RowMenu
          label={t("totp.actionsFor", { name })}
          items={[
            { label: t("common:actions.edit"), icon: "pencil", onPress: onEdit },
            { label: t("common:actions.delete"), icon: "trash", destructive: true, onPress: onDelete },
          ]}
        />
      </Row>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
