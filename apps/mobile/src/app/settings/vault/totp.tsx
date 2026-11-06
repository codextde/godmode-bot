import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TotpEntry } from "@godmode/shared";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { Badge } from "@/components/ui";
import { useLogins, useTotp } from "@/lib/vault";

/** 2FA entries by service and account, and the login each belongs to. Codes and seeds stay on the computer. */
export default function TwoFactor() {
  const { t } = useTranslation("vault");
  const list = useTotp();
  const logins = useLogins();
  const [search, setSearch] = useState("");
  const names = useMemo(() => new Map((logins.data ?? []).map((c) => [c.id, c.name])), [logins.data]);
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    return q ? all.filter((e) => `${e.issuer} ${e.accountName}`.toLowerCase().includes(q)) : all;
  }, [list.data, search]);

  return (
    <ReadonlyList<TotpEntry>
      title={t("totp.title")}
      query={list}
      items={items}
      keyOf={(e) => e.id}
      extraData={names}
      search={{ placeholder: t("totp.search"), value: search, onChange: setSearch }}
      icon="shield"
      emptyTitle={t("totp.emptyTitle")}
      failedTitle={t("totp.loadFailed")}
      renderRow={(e) => (
        <ListRow
          icon="shield"
          title={e.issuer || e.accountName || t("totp.unnamed")}
          lines={[e.issuer ? e.accountName : null, e.credentialId && names.get(e.credentialId) && names.get(e.credentialId) !== e.issuer ? t("totp.linkedTo", { name: names.get(e.credentialId) }) : null]}
          trailing={e.credentialId ? null : <Badge label={t("totp.notLinked")} dot={false} />}
        />
      )}
    />
  );
}
