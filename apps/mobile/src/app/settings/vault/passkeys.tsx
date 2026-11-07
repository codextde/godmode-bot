import { useMemo, useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { Passkey } from "@godmode/shared";
import { useFullAccess } from "@/components/full-access";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { confirmDelete, RowMenu } from "@/components/secret-parts";
import { T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { fullVaultApi, refreshVault, usePasskeys } from "@/lib/vault";

/** Passkeys the Godmode browser keeps for sites. Their private keys never leave the computer; with full access one can be deleted. */
export default function Passkeys() {
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const list = usePasskeys();
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    return q ? all.filter((p) => `${p.rpId} ${p.userName} ${p.userDisplayName}`.toLowerCase().includes(q)) : all;
  }, [list.data, search]);
  const remove = (p: Passkey) =>
    confirmDelete(t("passkeys.deleteTitle", { site: p.rpId }), t("passkeys.deleteBody"), t("common:actions.delete"), t("common:actions.cancel"), () => {
      fullVaultApi
        .deletePasskey(p.id)
        .then(refreshVault)
        .catch((err: unknown) => Alert.alert(t("passkeys.deleteFailed"), errorText(err)));
    });

  return (
    <ReadonlyList<Passkey>
      title={t("passkeys.title")}
      query={list}
      items={items}
      keyOf={(p) => p.id}
      extraData={fullAccess}
      search={{ placeholder: t("passkeys.search"), value: search, onChange: setSearch }}
      icon="passkey"
      emptyTitle={t("passkeys.emptyTitle")}
      failedTitle={t("passkeys.loadFailed")}
      renderRow={(p) => (
        <ListRow
          icon="passkey"
          title={p.rpId}
          lines={[p.userDisplayName && p.userDisplayName !== p.userName ? `${p.userDisplayName} · ${p.userName}` : p.userName]}
          trailing={
            <>
              {p.lastUsedAt ? (
                <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                  {shortTime(p.lastUsedAt)}
                </T>
              ) : null}
              {fullAccess ? <RowMenu label={t("passkeys.actionsFor", { site: p.rpId })} items={[{ label: t("common:actions.delete"), icon: "trash", destructive: true, onPress: () => remove(p) }]} /> : null}
            </>
          }
        />
      )}
    />
  );
}
