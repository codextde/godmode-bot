import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, type AgentNote } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { T, tap } from "@/components/ui";
import { filesApi, fk, parentOf } from "@/lib/agent-files";
import { dateLocale } from "@/lib/i18n";
import { fonts, space, useColors } from "@/lib/theme";

type Sort = "folder" | "modified" | "size";
type Item = { kind: "head"; title: string } | { kind: "note"; note: AgentNote };

const unlinkedNote = (n: AgentNote) => n.path.startsWith("memory/") && !n.linked;

/** An agent's notes across its folder, like the desktop's Notes tab: by folder, newest or largest, and the memory notes nothing links to. */
export default function AgentNotes() {
  const { t } = useTranslation("files");
  return (
    <FullAccessGate locked={<NeedsFullAccessScreen />}>
      <Notes key={t("notes.title")} />
    </FullAccessGate>
  );
}

function Notes() {
  const c = useColors();
  const { t } = useTranslation("files");
  const { agent } = useLocalSearchParams<{ agent: string }>();
  const notes = useQuery({ queryKey: fk.notes(agent), queryFn: () => filesApi.notes(agent), staleTime: 30_000 });
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("folder");
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const needle = filter.trim().toLowerCase();
  const all = useMemo(() => notes.data ?? [], [notes.data]);
  const unlinked = all.filter(unlinkedNote).length;

  const items = useMemo<Item[]>(() => {
    let list = all.filter((n) => !needle || n.title.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle));
    if (onlyUnlinked) list = list.filter(unlinkedNote);
    if (sort === "modified") list = [...list].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    if (sort === "size") list = [...list].sort((a, b) => b.bytes - a.bytes);
    if (sort !== "folder") return list.map((note) => ({ kind: "note", note }));
    const by = new Map<string, AgentNote[]>();
    for (const n of list) {
      const key = n.path === "MEMORY.md" ? "" : parentOf(n.path);
      by.set(key, [...(by.get(key) ?? []), n]);
    }
    return [...by.entries()].flatMap(([title, group]): Item[] => [{ kind: "head", title: title ? `${title}/` : t("notes.memory") }, ...group.map((note) => ({ kind: "note" as const, note }))]);
  }, [all, needle, sort, onlyUnlinked, t]);

  const pick = (next: Sort) => () => setSort(next);
  return (
    <>
      <HeaderActions
        menu={[
          { icon: sort === "folder" ? "check" : "folder", title: t("notes.byFolder"), onPress: pick("folder") },
          { icon: sort === "modified" ? "check" : "clock", title: t("notes.byModified"), onPress: pick("modified") },
          { icon: sort === "size" ? "check" : "layers", title: t("notes.bySize"), onPress: pick("size") },
        ]}
      />
      <ReadonlyList<Item>
        title={t("notes.title")}
        inline
        query={notes}
        items={items}
        keyOf={(i) => (i.kind === "head" ? `head:${i.title}` : i.note.path)}
        extraData={sort}
        search={{ placeholder: t("notes.filter"), value: filter, onChange: setFilter }}
        icon="note"
        emptyTitle={t("notes.empty")}
        failedTitle={t("notes.loadFailed")}
        inset={space.lg}
        header={
          unlinked > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: onlyUnlinked }}
              onPress={() => {
                tap();
                setOnlyUnlinked((v) => !v);
              }}
              style={[styles.unlinked, { backgroundColor: c.warningSoft }]}
            >
              <Icon name="warning" size={13} color={c.warning} />
              <T variant="footnote" style={{ flex: 1 }}>
                {t("notes.unlinked", { count: unlinked })}
              </T>
              <T variant="footnote" muted>
                {onlyUnlinked ? t("notes.showAll") : t("notes.showOnly")}
              </T>
            </Pressable>
          ) : undefined
        }
        renderRow={(i) =>
          i.kind === "head" ? (
            <View style={styles.head}>
              <T variant="caption" muted numberOfLines={1} style={{ fontFamily: fonts.mono }}>
                {i.title}
              </T>
            </View>
          ) : (
            <ListRow
              icon={i.note.path === "MEMORY.md" ? "sparkles" : "note"}
              tint={unlinkedNote(i.note) ? c.warning : undefined}
              title={i.note.title}
              lines={[sort === "folder" ? i.note.path.slice(i.note.path.lastIndexOf("/") + 1) : i.note.path, `${formatBytes(i.note.bytes)} · ${formatDistanceToNowStrict(new Date(i.note.modifiedAt), { locale: dateLocale() })}`]}
              onPress={() => router.push({ pathname: "/settings/files/preview", params: { agent, path: i.note.path } })}
            />
          )
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  unlinked: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: 12, borderCurve: "continuous" },
  head: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs },
});
