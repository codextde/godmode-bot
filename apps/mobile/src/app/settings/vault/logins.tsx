import { router } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Credential } from "@godmode/shared";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { Badge } from "@/components/ui";
import { loginHost, useLogins } from "@/lib/vault";

/**
 * Saved logins: site, username and whether a 2FA code belongs to it. With full access a login opens (password and code
 * behind Face ID) and new ones can be added; otherwise passwords stay on the computer.
 */
export default function Logins() {
  const { t } = useTranslation("vault");
  const { fullAccess } = useFullAccess();
  const list = useLogins();
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    return q ? all.filter((c) => [c.name, c.username, c.url, ...c.domains].join(" ").toLowerCase().includes(q)) : all;
  }, [list.data, search]);

  return (
    <>
      {fullAccess ? (
        <HeaderActions
          actions={[{ icon: "plus", label: t("loginEdit.addTitle"), onPress: () => router.push("/vault/login-edit") }]}
          menu={[{ icon: "doc", title: t("passwordImport.title"), onPress: () => router.push("/vault/password-import") }]}
        />
      ) : null}
      <ReadonlyList<Credential>
        title={t("logins.title")}
        query={list}
        items={items}
        keyOf={(c) => c.id}
        extraData={fullAccess}
        search={{ placeholder: t("logins.search"), value: search, onChange: setSearch }}
        icon="key"
        emptyTitle={t("logins.emptyTitle")}
        failedTitle={t("logins.loadFailed")}
        renderRow={(c) => (
          <ListRow
            icon="key"
            title={c.name}
            lines={[[c.username, loginHost(c)].filter(Boolean).join(" · ") || t("logins.noUsername")]}
            trailing={c.totpId ? <Badge label={t("logins.twoFactor")} tone="success" dot={false} /> : null}
            onPress={fullAccess ? () => router.push({ pathname: "/settings/vault/login/[id]", params: { id: c.id } }) : undefined}
          />
        )}
      />
    </>
  );
}
