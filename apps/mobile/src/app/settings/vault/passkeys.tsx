import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Passkey } from "@godmode/shared";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { T } from "@/components/ui";
import { shortTime } from "@/lib/format";
import { usePasskeys } from "@/lib/vault";

/** Passkeys the Godmode browser keeps for sites. Their private keys never leave the computer. */
export default function Passkeys() {
  const { t } = useTranslation("vault");
  const list = usePasskeys();
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    return q ? all.filter((p) => `${p.rpId} ${p.userName} ${p.userDisplayName}`.toLowerCase().includes(q)) : all;
  }, [list.data, search]);

  return (
    <ReadonlyList<Passkey>
      title={t("passkeys.title")}
      query={list}
      items={items}
      keyOf={(p) => p.id}
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
            p.lastUsedAt ? (
              <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                {shortTime(p.lastUsedAt)}
              </T>
            ) : null
          }
        />
      )}
    />
  );
}
