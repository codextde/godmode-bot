import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { Passkey } from "@godmode/shared";
import { useFullAccess } from "@/components/full-access";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { confirmDelete, RowMenu } from "@/components/secret-parts";
import { ago } from "@/components/status-rows";
import { T } from "@/components/ui";
import { ScopeBadge, ScopeChips, useVaultScope } from "@/components/vault-scope";
import { api, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { space } from "@/lib/theme";
import { fullVaultApi, refreshVault, usePasskeys } from "@/lib/vault";

/** Passkeys the Godmode browser keeps for sites. Their private keys never leave the computer; with full access one can be deleted. */
export default function Passkeys() {
  const { t } = useTranslation(["vault", "common"]);
  const { fullAccess } = useFullAccess();
  const list = usePasskeys();
  const scope = useVaultScope();
  const { filter } = scope;
  const agents = useAgents();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const profileName = useMemo(() => new Map((profiles.data ?? []).map((p) => [p.id, p.name])), [profiles.data]);
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = filter(list.data ?? []);
    return q ? all.filter((p) => `${p.rpId} ${p.userName} ${p.userDisplayName}`.toLowerCase().includes(q)) : all;
  }, [list.data, search, filter]);
  /** "Created 2 days ago by Scout · Main profile": where a passkey came from. */
  const origin = (p: Passkey) => {
    const agent = p.createdByAgentId ? agents.byId.get(p.createdByAgentId)?.name : undefined;
    const profile = p.profileId ? profileName.get(p.profileId) : undefined;
    return [agent ? t("passkeys.createdBy", { when: ago(p.createdAt), agent }) : t("passkeys.created", { when: ago(p.createdAt) }), profile ? t("passkeys.profile", { name: profile }) : null].filter(Boolean).join(" · ");
  };
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
      extraData={[fullAccess, scope.nameOf, agents.byId, profileName]}
      search={{ placeholder: t("passkeys.search"), value: search, onChange: setSearch }}
      icon="passkey"
      emptyTitle={scope.filtered ? t("passkeys.emptyScopeTitle") : t("passkeys.emptyTitle")}
      failedTitle={t("passkeys.loadFailed")}
      header={list.data?.length ? <ScopeChips state={scope} bleed={space.md} /> : undefined}
      renderRow={(p) => (
        <ListRow
          icon="passkey"
          title={p.rpId}
          lines={[p.userDisplayName && p.userDisplayName !== p.userName ? `${p.userDisplayName} · ${p.userName}` : p.userName, origin(p)]}
          lineLimit={2}
          badges={scope.active ? <ScopeBadge name={scope.nameOf(p.workspaceId)} global={!p.workspaceId} /> : null}
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
