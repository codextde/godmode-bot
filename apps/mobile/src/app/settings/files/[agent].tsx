import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, type AgentFileEntry, type AgentFileSearchHit } from "@godmode/shared";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { KIND_ICON, fileKind, filesApi, fk, nameOf, parentOf } from "@/lib/agent-files";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { useColors } from "@/lib/theme";

/** Godmode's own folders first at the top of an agent's folder, like the desktop. */
const ROOT_ORDER = ["workspace", "memory", "MEMORY.md", "CLAUDE.md"];

type Item = { kind: "entry"; entry: AgentFileEntry } | { kind: "hit"; hit: AgentFileSearchHit };

/** One folder of an agent, read-only: folders open in place, files in the viewer. Search covers the whole folder. */
export default function AgentFolder() {
  const c = useColors();
  const { t } = useTranslation("files");
  const { agent: agentId, path = "" } = useLocalSearchParams<{ agent: string; path?: string }>();
  const { byId } = useAgents();
  const agent = byId.get(agentId);
  const list = useQuery({ queryKey: fk.list(agentId, path), queryFn: () => filesApi.list(agentId, path) });
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const hits = useQuery({ queryKey: fk.search(agentId, query), queryFn: () => filesApi.search(agentId, query), enabled: query.length >= 2, placeholderData: keepPreviousData });
  const searching = query.length >= 2;

  const items = useMemo<Item[]>(() => {
    if (searching) return (hits.data ?? []).map((hit) => ({ kind: "hit", hit }));
    const entries = [...(list.data ?? [])];
    if (!path) entries.sort((a, b) => rank(a.path) - rank(b.path));
    return entries.map((entry) => ({ kind: "entry", entry }));
  }, [searching, hits.data, list.data, path]);

  const open = (p: string, type: "file" | "dir") =>
    type === "dir" ? router.push({ pathname: "/settings/files/[agent]", params: { agent: agentId, path: p } }) : router.push({ pathname: "/settings/files/preview", params: { agent: agentId, path: p } });

  return (
    <ReadonlyList<Item>
      title={path ? nameOf(path) : (agent?.name ?? t("folder.title"))}
      inline
      query={searching ? { ...hits, isLoading: hits.isLoading && !hits.data } : list}
      items={items}
      keyOf={(i) => (i.kind === "entry" ? i.entry.path : `hit:${i.hit.path}`)}
      search={{ placeholder: t("folder.search"), value: search, onChange: setSearch }}
      icon="folder"
      emptyTitle={t("folder.emptyTitle")}
      failedTitle={t("folder.loadFailed")}
      renderRow={(i) => {
        if (i.kind === "hit") {
          const h = i.hit;
          return (
            <ListRow
              icon={KIND_ICON[fileKind(h)]}
              tint={h.type === "dir" ? c.brandStrong : undefined}
              title={nameOf(h.path)}
              lines={[parentOf(h.path) || agent?.name, h.snippet ? `${h.line}: ${h.snippet.trim()}` : null]}
              onPress={() => open(h.path, h.type)}
            />
          );
        }
        const e = i.entry;
        return (
          <ListRow
            icon={KIND_ICON[fileKind(e)]}
            tint={e.type === "dir" ? c.brandStrong : undefined}
            title={nameOf(e.path)}
            lines={[[e.type === "file" ? formatBytes(e.size) : null, shortTime(e.modifiedAt)].filter(Boolean).join(" · ")]}
            onPress={() => open(e.path, e.type)}
          />
        );
      }}
    />
  );
}

function rank(path: string): number {
  const i = ROOT_ORDER.indexOf(path);
  return i === -1 ? ROOT_ORDER.length : i;
}

function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}
