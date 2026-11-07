import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, router, useLocalSearchParams, useNavigation } from "expo-router";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatBytes, type AgentFileEntry, type AgentFileSearchHit, type AgentFileSize } from "@godmode/shared";
import { entryActions, openDeleteMany, openMoveMany, openNew, useDreamingNow } from "@/components/file-actions";
import { useFullAccess } from "@/components/full-access";
import { Glass } from "@/components/glass";
import { HeaderActions, MenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { Icon, sfSymbol } from "@/components/icon";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { T, tap } from "@/components/ui";
import { KIND_ICON, fileKind, filesApi, fk, isLocked, movedPath, nameOf, onFileChange, parentOf, placeable, wasDeleted } from "@/lib/agent-files";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { radius, space, useColors } from "@/lib/theme";

/** Godmode's own folders first at the top of an agent's folder, like the desktop. */
const ROOT_ORDER = ["workspace", "memory", "MEMORY.md", "CLAUDE.md"];

type Item = { kind: "entry"; entry: AgentFileEntry } | { kind: "hit"; hit: AgentFileSearchHit };

/**
 * One folder of an agent: folders open in place, files in the viewer, search covers the whole folder. With full access
 * the header makes notes and folders and opens the bin and the review; a long press renames, moves or deletes.
 */
export default function AgentFolder() {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const { agent: agentId, path = "" } = useLocalSearchParams<{ agent: string; path?: string }>();
  const navigation = useNavigation();
  const { byId } = useAgents();
  const agent = byId.get(agentId);
  const { fullAccess } = useFullAccess();
  const frozen = useDreamingNow(agentId);
  const list = useQuery({ queryKey: fk.list(agentId, path), queryFn: () => filesApi.list(agentId, path) });
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const hits = useQuery({ queryKey: fk.search(agentId, query), queryFn: () => filesApi.search(agentId, query), enabled: query.length >= 2, placeholderData: keepPreviousData });
  const searching = query.length >= 2;
  // What folders hold is counted on the computer: only full access reaches it.
  const sizes = useQuery({ queryKey: [...fk.agent(agentId), "sizes", path], queryFn: () => filesApi.sizes(agentId, path), enabled: !!fullAccess, staleTime: 30_000 });
  const sizeOf = useMemo(() => new Map((sizes.data ?? []).map((s) => [s.path, s])), [sizes.data]);
  // Only the counts: the review looks through every file, so it waits until it was asked for once.
  const bin = useQuery({ queryKey: fk.bin(agentId), queryFn: () => filesApi.deleted(agentId), enabled: !!fullAccess });
  /** Picking several at once: the set of paths, or null when not. */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const insets = useSafeAreaInsets();

  // This folder was renamed or moved: it follows; deleted: back to where it was. A new note made here opens to write.
  useEffect(
    () =>
      onFileChange((change) => {
        if (change.agentId !== agentId) return;
        // This screen's own navigation: the sheet that changed it may still be the focused route.
        if ("moves" in change) {
          const to = path ? movedPath(path, change.moves) : null;
          if (to) navigation.setParams({ path: to } as never);
        } else if ("deleted" in change) {
          if (path && wasDeleted(path, change.deleted) && navigation.canGoBack()) navigation.goBack();
        } else if (change.kind === "note" && parentOf(change.created) === path) {
          router.push({ pathname: "/settings/files/preview", params: { agent: agentId, path: change.created, edit: "1" } });
        }
      }),
    [agentId, path, navigation],
  );

  const items = useMemo<Item[]>(() => {
    if (searching) return (hits.data ?? []).map((hit) => ({ kind: "hit", hit }));
    const entries = [...(list.data ?? [])];
    if (!path) entries.sort((a, b) => rank(a.path) - rank(b.path));
    return entries.map((entry) => ({ kind: "entry", entry }));
  }, [searching, hits.data, list.data, path]);

  const canCreate = placeable(path) && !frozen;
  const binCount = bin.data?.length ?? 0;
  const pickable = (list.data ?? []).filter((e) => !isLocked(e.path));
  const pickedList = pickable.filter((e) => picked?.has(e.path));
  const pickedBytes = pickedList.reduce((n, e) => n + e.size, 0);
  const paths = pickedList.map((e) => e.path);
  const toggle = (target: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  const menu: HeaderMenuItem[] = [
    ...(fullAccess && pickable.length && !frozen ? [{ icon: "checkCircle" as const, title: t("select.start"), onPress: () => setPicked(new Set()) }] : []),
    ...(canCreate
      ? [
          { icon: "note" as const, title: t("folder.newNote"), onPress: () => openNew(agentId, "note", path) },
          { icon: "folder" as const, title: t("folder.newFolder"), onPress: () => openNew(agentId, "folder", path) },
        ]
      : []),
    { icon: "note", title: t("notes.title"), onPress: () => router.push({ pathname: "/settings/files/notes", params: { agent: agentId } }) },
    { icon: "broom", title: t("folder.review"), onPress: () => router.push({ pathname: "/settings/files/review", params: { agent: agentId } }) },
    { icon: "trash", title: binCount ? t("folder.binCount", { count: binCount }) : t("folder.bin"), onPress: () => router.push({ pathname: "/settings/files/bin", params: { agent: agentId } }) },
  ];
  const editable = fullAccess === true;

  return (
    <>
      {fullAccess === undefined ? null : picked ? (
        <HeaderActions
          actions={[{ icon: "close", label: t("common:actions.done"), onPress: () => setPicked(null) }]}
          menu={[{ icon: "checkCircle", title: pickedList.length === pickable.length ? t("select.none") : t("select.all"), onPress: () => setPicked(new Set(pickedList.length === pickable.length ? [] : pickable.map((e) => e.path))) }]}
        />
      ) : (
        <HeaderActions menu={menu} />
      )}
      <ReadonlyList<Item>
        title={path ? nameOf(path) : (agent?.name ?? t("folder.title"))}
        inline
        query={searching ? { ...hits, isLoading: hits.isLoading && !hits.data } : list}
        items={items}
        keyOf={(i) => (i.kind === "entry" ? i.entry.path : `hit:${i.hit.path}`)}
        extraData={`${editable}|${frozen}|${picked ? [...picked].join() : "off"}|${sizes.dataUpdatedAt}`}
        search={{ placeholder: t("folder.search"), value: search, onChange: setSearch }}
        icon="folder"
        emptyTitle={t("folder.emptyTitle")}
        failedTitle={t("folder.loadFailed")}
        header={frozen ? <Dreaming name={agent?.name ?? t("folder.theAgent")} /> : undefined}
        renderRow={(i) =>
          i.kind === "hit" ? (
            <EntryRow agentId={agentId} path={i.hit.path} type={i.hit.type} lines={[parentOf(i.hit.path) || agent?.name, i.hit.snippet ? `${i.hit.line}: ${i.hit.snippet.trim()}` : null]} editable={editable} frozen={frozen} />
          ) : (
            <EntryRow
              agentId={agentId}
              path={i.entry.path}
              type={i.entry.type}
              lines={[[bytesOf(i.entry, sizeOf.get(i.entry.path)), shortTime(i.entry.modifiedAt)].filter(Boolean).join(" · ")]}
              editable={editable}
              frozen={frozen}
              picking={picked ? !isLocked(i.entry.path) : undefined}
              picked={picked?.has(i.entry.path)}
              onPick={toggle}
            />
          )
        }
      />
      {picked ? (
        <View pointerEvents="box-none" style={[styles.barWrap, { paddingBottom: Math.max(insets.bottom, space.md) + SEARCH_BAR }]}>
          <Glass style={styles.bar} fallback={c.surface}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={1}>
                {pickedList.length ? t("select.count", { count: pickedList.length }) : t("select.pick")}
              </T>
              {pickedBytes ? (
                <T variant="caption" muted>
                  {formatBytes(pickedBytes)}
                </T>
              ) : null}
            </View>
            <BarButton
              title={t("actions.move")}
              icon="move"
              disabled={!paths.length}
              onPress={() => {
                openMoveMany(agentId, paths);
                setPicked(null);
              }}
            />
            <BarButton
              title={t("common:actions.delete")}
              icon="trash"
              danger
              disabled={!paths.length}
              onPress={() => {
                openDeleteMany(agentId, paths);
                setPicked(null);
              }}
            />
          </Glass>
        </View>
      ) : null}
    </>
  );
}

function BarButton({ title, icon, danger, disabled, onPress }: { title: string; icon: "move" | "trash"; danger?: boolean; disabled: boolean; onPress: () => void }) {
  const c = useColors();
  const color = danger ? c.danger : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      hitSlop={6}
      style={({ pressed }) => [styles.barButton, { backgroundColor: c.sunken, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Icon name={icon} size={16} color={color} />
    </Pressable>
  );
}

function Dreaming({ name }: { name: string }) {
  const c = useColors();
  const { t } = useTranslation("files");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }} accessibilityRole="text">
      <Icon name="moon" size={14} color={c.dream} />
      <T variant="footnote" muted style={{ flex: 1 }}>
        {t("folder.dreaming", { name })}
      </T>
    </View>
  );
}

/** A file's size, or what a folder holds once the computer counted it (`partial`: at least this much). */
function bytesOf(entry: AgentFileEntry, size: AgentFileSize | undefined): string | null {
  if (entry.type === "file") return formatBytes(entry.size);
  return size ? `${size.partial ? "> " : ""}${formatBytes(size.bytes)}` : null;
}

const hrefOf = (agent: string, path: string, type: "file" | "dir") =>
  type === "dir" ? { pathname: "/settings/files/[agent]" as const, params: { agent, path } } : { pathname: "/settings/files/preview" as const, params: { agent, path } };

/** A file or folder; with full access its actions on a long press (the system menu on iOS, a sheet on Android). */
const EntryRow = memo(function EntryRow({
  agentId,
  path,
  type,
  lines,
  editable,
  frozen,
  picking,
  picked,
  onPick,
}: {
  agentId: string;
  path: string;
  type: "file" | "dir";
  lines: (string | null | undefined)[];
  editable: boolean;
  frozen: boolean;
  /** Picking several: whether this one can be picked (undefined when not picking). */
  picking?: boolean;
  picked?: boolean;
  onPick?: (path: string) => void;
}) {
  const c = useColors();
  const { t } = useTranslation("files");
  const [open, setOpen] = useState(false);
  const actions = editable ? entryActions(agentId, path, frozen) : [];
  const href = hrefOf(agentId, path, type);
  const row = (onPress?: () => void, onLongPress?: () => void, trailing?: ReactNode) => (
    <ListRow
      icon={KIND_ICON[fileKind({ path, type })]}
      tint={type === "dir" ? c.brandStrong : undefined}
      title={nameOf(path)}
      lines={lines}
      onPress={onPress}
      onLongPress={onLongPress}
      trailing={trailing}
    />
  );
  if (picking !== undefined) {
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={t("select.item", { name: nameOf(path) })}
        accessibilityState={{ checked: !!picked, disabled: !picking }}
        disabled={!picking}
        onPress={() => {
          tap();
          onPick?.(path);
        }}
      >
        <ListRow
          icon={KIND_ICON[fileKind({ path, type })]}
          tint={type === "dir" ? c.brandStrong : undefined}
          title={nameOf(path)}
          lines={lines}
          trailing={<Icon name={picked ? "checkCircleFill" : "circle"} size={20} color={!picking ? c.border : picked ? c.brandStrong : c.textFaint} />}
        />
      </Pressable>
    );
  }
  if (!actions.length) return row(() => router.push(href));
  if (process.env.EXPO_OS !== "ios") {
    return (
      <>
        {row(() => router.push(href), () => setOpen(true))}
        <MenuSheet items={actions} open={open} onClose={() => setOpen(false)} />
      </>
    );
  }
  return (
    <Link href={href} asChild>
      <Link.Trigger>
        <View>{row(undefined, undefined, <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" />)}</View>
      </Link.Trigger>
      <Link.Menu>
        {actions.map((a) => (
          <Link.MenuAction key={a.title} title={a.title} icon={sfSymbol(a.icon)} destructive={a.destructive} onPress={a.onPress} />
        ))}
      </Link.Menu>
    </Link>
  );
});

/** iOS keeps its search field at the bottom of the screen: the bar sits above it. */
const SEARCH_BAR = process.env.EXPO_OS === "ios" ? 60 : 0;

const styles = StyleSheet.create({
  barWrap: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg },
  bar: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, paddingLeft: space.lg, paddingRight: space.sm, borderRadius: radius.xl, borderCurve: "continuous" },
  barButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});

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
