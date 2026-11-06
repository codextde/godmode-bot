import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, type Agent } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { filesApi, fk } from "@/lib/agent-files";
import { useAgents } from "@/lib/hooks";

/** Every agent's folder, the largest first: what it keeps, its notes. Opened read-only. */
export default function Files() {
  const { t } = useTranslation("files");
  const agents = useAgents();
  const overview = useQuery({ queryKey: fk.overview, queryFn: filesApi.overview, staleTime: 60_000 });
  const sizes = useMemo(() => new Map((overview.data ?? []).map((o) => [o.agentId, o])), [overview.data]);
  const items = useMemo(
    () => [...(agents.data ?? [])].sort((a, b) => (sizes.get(b.id)?.bytes ?? 0) - (sizes.get(a.id)?.bytes ?? 0) || a.name.localeCompare(b.name)),
    [agents.data, sizes],
  );
  const query = { ...agents, refetch: () => Promise.all([agents.refetch(), overview.refetch()]) };

  return (
    <ReadonlyList<Agent>
      title={t("index.title")}
      query={query}
      items={items}
      keyOf={(a) => a.id}
      extraData={sizes}
      icon="files"
      emptyTitle={t("index.emptyTitle")}
      failedTitle={t("index.loadFailed")}
      inset={64}
      renderRow={(a) => {
        const o = sizes.get(a.id);
        return (
          <ListRow
            lead={<CharacterAvatar agent={a} size={36} />}
            title={a.name}
            lines={[o ? [formatBytes(o.bytes), o.notes ? t("index.notes", { count: o.notes }) : null].filter(Boolean).join(" · ") : null]}
            onPress={() => router.push({ pathname: "/settings/files/[agent]", params: { agent: a.id } })}
          />
        );
      }}
    />
  );
}
