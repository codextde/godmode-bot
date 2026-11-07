import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { FilterToolbar } from "@/components/filter-toolbar";
import { useFullAccess } from "@/components/full-access";
import { ConversationRow } from "@/components/rows";
import { Icon, type IconName } from "@/components/icon";
import { SegmentedTabs } from "@/components/segmented-tabs";
import { useMenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { EmptyState, ErrorState, Hairline, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { RowPressable } from "@/components/row-pressable";
import { api, errorText } from "@/lib/api";
import { chatSource, SOURCES, sourceStats, TABS, useChatFilters, type ChatSource, type RecentTab } from "@/lib/chat-filters";
import { chatBucket, chatDayLabel, continuesAt } from "@/lib/desktop-parity";
import { CHAT_LIST_LIMIT, useAgents } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { inProject, useProjectIndex, useWorkspace, chatProject } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

type Tab = RecentTab;
type Item = { kind: "header"; key: string; title: string } | { kind: "chat"; key: string; conversation: Conversation; divided: boolean };

const EMPTY_ICON: Record<Tab, IconName> = { all: "chats", running: "bolt", scheduled: "clock", done: "check" };

const EMPTY_SOURCE_ICON: Record<ChatSource, IconName> = { mine: "chats", automations: "clock", agents: "user" };

/** The chats a run works on right now, and the ones waiting their turn. */
function useChatRuns(): { running: Set<string>; queued: Set<string> } {
  const key = useLive((s) => {
    const runs = Object.values(s.runs).map(({ run }) => run);
    const running = new Set(runs.filter((r) => r.status === "running").map((r) => r.conversationId));
    const queued = new Set(runs.filter((r) => r.status === "queued" && !running.has(r.conversationId)).map((r) => r.conversationId));
    return `${[...running].sort().join(",")}|${[...queued].sort().join(",")}`;
  });
  return useMemo(() => {
    const [running = "", queued = ""] = key.split("|");
    return { running: new Set(running ? running.split(",") : []), queued: new Set(queued ? queued.split(",") : []) };
  }, [key]);
}

export default function Chats() {
  const { t } = useTranslation(["tabs", "chat"]);
  const { fullAccess } = useFullAccess();
  const [search, setSearch] = useState("");
  // The search reads every message on the computer: ask once the typing pauses.
  const [q, setQ] = useState("");
  useEffect(() => {
    const next = search.trim();
    const timer = setTimeout(() => setQ(next), next ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search]);
  const tab = useChatFilters((s) => s.tab);
  const setTab = useChatFilters((s) => s.setTab);
  const source = useChatFilters((s) => s.source);
  const setSource = useChatFilters((s) => s.setSource);
  const { id: workspaceId, workspace, projectId, project } = useWorkspace();
  const projects = useProjectIndex();
  const list = useQuery({
    queryKey: qk.conversationList(q, workspaceId),
    queryFn: () => api.conversations.list({ search: q || undefined, limit: CHAT_LIST_LIMIT, workspaceId }),
    placeholderData: (previous) => previous,
  });
  const hasArchived = useQuery({
    queryKey: ["archived-count", "any", workspaceId ?? "all"],
    queryFn: async () => (await api.conversations.list({ archived: true, limit: 1, workspaceId })).length > 0,
  }).data;
  // Archived chats that still work, wait or come back on their own.
  const archivedOngoing =
    useQuery({
      queryKey: ["archived-count", "ongoing", workspaceId ?? "all"],
      queryFn: async () => (await api.conversations.list({ archived: true, ongoing: true, limit: 100, workspaceId })).length,
      enabled: !!hasArchived,
    }).data ?? 0;
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const runs = useChatRuns();
  const unarchived = useMemo(() => inProject(list.data ?? [], projectId, byId).filter((conv) => !conv.archived), [list.data, projectId, byId]);
  const sources = useMemo(() => sourceStats(unarchived), [unarchived]);
  const visible = useMemo(() => (q ? unarchived : unarchived.filter((conv) => source === "all" || chatSource(conv) === source)), [unarchived, source, q]);
  const live = useCallback((conv: Conversation) => runs.running.has(conv.id) || runs.queued.has(conv.id), [runs]);
  const counts = useMemo(() => {
    const n = { running: 0, scheduled: 0 };
    for (const conv of visible) {
      const bucket = chatBucket(conv, live(conv));
      if (bucket !== "done") n[bucket]++;
    }
    return n;
  }, [visible, live]);
  const unread = useMemo(() => visible.flatMap((conv) => (conv.unread ? [conv.id] : [])), [visible]);
  const markRead = () => {
    tap();
    api.conversations
      .read(unread.slice(0, 500))
      .catch((err) => Alert.alert(t("chats.markReadFailed"), errorText(err)))
      .finally(() => void queryClient.invalidateQueries({ queryKey: qk.conversations }));
  };

  const items = useMemo(() => {
    const matching = visible
      .filter((conv) => tab === "all" || chatBucket(conv, live(conv)) === tab)
      .sort((a, b) =>
        q
          ? 0
          : tab === "scheduled"
            ? continuesAt(a).localeCompare(continuesAt(b))
            : Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
      );
    // Long lists read by day; the running and scheduled tabs are short and ordered by what comes next.
    const dated = !q && (tab === "all" || tab === "done");
    const now = new Date();
    const out: Item[] = [];
    let day: string | null = null;
    for (const conversation of matching) {
      const label = dated ? (conversation.pinned ? t("chats.pinned") : chatDayLabel(conversation.lastMessageAt ?? conversation.createdAt, now)) : null;
      if (label && label !== day) out.push({ kind: "header", key: `h-${label}`, title: label });
      out.push({ kind: "chat", key: conversation.id, conversation, divided: out.length > 0 && out[out.length - 1]!.kind === "chat" });
      day = label;
    }
    return out;
  }, [visible, tab, live, q, t]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      if (item.kind === "header") return <DayTitle title={item.title} />;
      const conv = item.conversation;
      const id = projectId ? null : chatProject(conv, byId);
      return (
        <>
          {item.divided && <Hairline inset={76} />}
          <ChatItem
            conversation={conv}
            agent={byId.get(conv.agentId)}
            from={conv.delegatedFrom ? byId.get(conv.delegatedFrom.agentId) : undefined}
            running={runs.running.has(conv.id) || (!!conv.running && !runs.queued.has(conv.id))}
            queued={runs.queued.has(conv.id)}
            project={id ? projects.get(id)?.project : undefined}
          />
        </>
      );
    },
    [byId, runs, projectId, projects],
  );
  const scopeName = project?.name ?? workspace?.name ?? null;
  const empty =
    tab === "all" && source !== "all"
      ? { icon: EMPTY_SOURCE_ICON[source], title: t(`chats.emptySource.${source}.title`), body: t(`chats.emptySource.${source}.body`) }
      : tab === "all" && scopeName
        ? { icon: EMPTY_ICON.all, title: t("chats.emptyScope.title", { name: scopeName }), body: t("chats.emptyScope.body") }
        : { icon: EMPTY_ICON[tab], title: t(`chats.empty.${tab}.title`), body: t(`chats.empty.${tab}.body`) };

  return (
    <>
      <Stack.Title large>{t("chats.title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("chats.search")} hideWhenScrolling={false} onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <FilterToolbar
        actions={[
          { icon: "archive", label: t("chats.archived"), onPress: () => router.push("/archived") },
          { icon: "compose", label: t("home.newChat"), onPress: () => router.push("/compose") },
        ]}
        menu={fullAccess ? [{ icon: "inbox", title: t("chat:import.menu"), onPress: () => router.push("/chat-import") }] : []}
        filters={[
          {
            id: "status",
            title: t("chats.status"),
            icon: "filter",
            value: tab,
            options: TABS.map((f) => ({ value: f.value, label: t(`chats.filter.${f.value}.label`) })),
            onChange: (next) => setTab(next as Tab),
          },
        ]}
      />
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        extraData={runs}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.sm }}>
            <Row style={{ gap: space.sm, marginBottom: space.xs }}>
              <WorkspaceChip />
              {tab !== "all" && <StatusChip label={t(`chats.filter.${tab}.label`)} count={tab === "running" || tab === "scheduled" ? counts[tab] : 0} onClear={() => setTab("all")} />}
              {unread.length > 0 && <MarkRead onPress={markRead} />}
            </Row>
            {q ? <SearchEverywhere query={q} /> : null}
            {!q && (
              <SegmentedTabs
                label={t("chats.sourceLabel")}
                value={source}
                onChange={setSource}
                tabs={SOURCES.map((s) => {
                  const { unread: n, needsYou } = sources[s.value];
                  return {
                    value: s.value,
                    label: t(`chats.source.${s.value}.label`),
                    accessibilityHint: t(`chats.source.${s.value}.hint`),
                    dot: s.value === "all" ? null : needsYou > 0 ? "warning" : n > 0 ? "brand" : null,
                  };
                })}
              />
            )}
          </View>
        }
        ListFooterComponent={hasArchived && !q ? <ArchivedLink ongoing={archivedOngoing} /> : null}
        ListEmptyComponent={
          list.isLoading ? (
            <SkeletonRows count={8} />
          ) : list.isError ? (
            <ErrorState title={t("chats.loadError")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : q ? (
            <EmptyState icon="search" title={t("chats.noResults.title")} body={t("chats.noResults.body", { query: q })} />
          ) : (
            <EmptyState icon={empty.icon} title={empty.title} body={empty.body} />
          )
        }
      />
    </>
  );
}

/** While searching chats: the same words through messages, tasks and agents too. */
function SearchEverywhere({ query }: { query: string }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        router.push({ pathname: "/search", params: { q: query } });
      }}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, height: 44, borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: c.surface },
        pressed && { backgroundColor: c.sunken },
      ]}
    >
      <Icon name="search" size={15} color={c.textMuted} />
      <T variant="subhead" numberOfLines={1} style={{ flex: 1 }}>
        {t("search.everywhere", { query })}
      </T>
      <Icon name="chevron" size={12} color={c.textMuted} />
    </Pressable>
  );
}

/** The status the list is narrowed to (picked in the header's filter menu); tap to show every chat again. */
function StatusChip({ label, count, onClear }: { label: string; count: number; onClear: () => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${t("filterToolbar.clear")}`}
      hitSlop={6}
      onPress={() => {
        tap();
        onClear();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 32,
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        backgroundColor: c.brandSoft,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <T variant="subhead" color={c.brandStrong} style={{ fontWeight: "600" }} numberOfLines={1}>
        {count > 0 ? `${label} ${count}` : label}
      </T>
      <Icon name="close" size={10} color={c.brandStrong} weight="bold" />
    </Pressable>
  );
}

function MarkRead({ onPress }: { onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("tabs");
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress} style={({ pressed }) => ({ marginLeft: "auto", opacity: pressed ? 0.5 : 1 })}>
      <T variant="footnote" color={c.textMuted} style={{ fontWeight: "500" }}>
        {t("chats.markAllRead")}
      </T>
    </Pressable>
  );
}

/** The archive, with how many of its chats still have work ahead. */
function ArchivedLink({ ongoing }: { ongoing: number }) {
  const c = useColors();
  const { t } = useTranslation("tabs");
  return (
    <RowPressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        router.push("/archived");
      }}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.lg, paddingHorizontal: space.md, height: 44, borderRadius: radius.lg, borderCurve: "continuous" }}
    >
      <Icon name="archive" size={15} color={c.textMuted} />
      <T variant="subhead" muted style={{ flex: 1 }}>
        {t("chats.archived")}
      </T>
      {ongoing > 0 && (
        <View
          accessibilityLabel={t("chats.archivedOngoing", { count: ongoing })}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 20, paddingHorizontal: 7, borderRadius: radius.pill, backgroundColor: c.sunken }}
        >
          <Icon name="clock" size={10} color={c.brandStrong} />
          <T variant="caption" style={{ fontVariant: ["tabular-nums"], fontWeight: "600" }}>
            {ongoing}
          </T>
        </View>
      )}
      <Icon name="chevron" size={12} color={c.textMuted} />
    </RowPressable>
  );
}

function DayTitle({ title }: { title: string }) {
  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
      <SectionTitle title={title} />
    </View>
  );
}

function changeChat(id: string, patch: { pinned?: boolean; archived?: boolean }) {
  api.conversations
    .update(id, patch)
    .catch((err) => Alert.alert(t("tabs:chats.changeFailed"), errorText(err)))
    .finally(() => {
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      if (patch.archived !== undefined) void queryClient.invalidateQueries({ queryKey: ["archived-count"] });
    });
}

const ChatItem = memo(function ChatItem({
  conversation,
  agent,
  from,
  running,
  queued,
  project,
}: {
  conversation: Conversation;
  agent?: Agent;
  from?: Agent;
  running: boolean;
  queued: boolean;
  project?: Project;
}) {
  const { t } = useTranslation(["tabs", "common"]);
  const update = { mutate: (patch: { pinned?: boolean; archived?: boolean }) => changeChat(conversation.id, patch) };
  const menu = useMenuSheet();
  const markRead = () => void api.conversations.read([conversation.id]).finally(() => void queryClient.invalidateQueries({ queryKey: qk.conversations }));
  const markUnread = () => void api.conversations.unread([conversation.id]).finally(() => void queryClient.invalidateQueries({ queryKey: qk.conversations }));
  const remove = () =>
    Alert.alert(t("chats.deleteDialog.title"), t("chats.deleteDialog.body"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: () =>
          void api.conversations
            .delete(conversation.id)
            .then(() => queryClient.invalidateQueries({ queryKey: qk.conversations }))
            .catch((err) => Alert.alert(t("chats.deleteFailed"), errorText(err))),
      },
    ]);

  const row = (onLongPress?: () => void) => <ConversationRow conversation={conversation} agent={agent} from={from} running={running} queued={queued} project={project} onLongPress={onLongPress} />;
  if (process.env.EXPO_OS !== "ios") {
    const items: HeaderMenuItem[] = [
      conversation.unread ? { icon: "checkAll", title: t("chats.menu.markRead"), onPress: markRead } : { icon: "dot", title: t("chats.menu.markUnread"), onPress: markUnread },
      { icon: "pin", title: conversation.pinned ? t("chats.menu.unpin") : t("chats.menu.pin"), onPress: () => update.mutate({ pinned: !conversation.pinned }) },
      { icon: "archive", title: t("chats.menu.archive"), onPress: () => update.mutate({ archived: true }) },
      { icon: "trash", title: t("common:actions.delete"), destructive: true, onPress: remove },
    ];
    return (
      <>
        {row(() => {
          tap();
          menu.show(items, conversation.title || undefined);
        })}
        {menu.sheet}
      </>
    );
  }
  return (
    <Link href={{ pathname: "/chat/[id]", params: { id: conversation.id } }} asChild>
      <Link.Trigger>
        <View>{row()}</View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {conversation.unread ? <Link.MenuAction title={t("chats.menu.markRead")} icon="checkmark.message" onPress={markRead} /> : <Link.MenuAction title={t("chats.menu.markUnread")} icon="message.badge" onPress={markUnread} />}
        <Link.MenuAction title={conversation.pinned ? t("chats.menu.unpin") : t("chats.menu.pin")} icon={conversation.pinned ? "pin.slash" : "pin"} onPress={() => update.mutate({ pinned: !conversation.pinned })} />
        <Link.MenuAction title={t("chats.menu.archive")} icon="archivebox" onPress={() => update.mutate({ archived: true })} />
        <Link.MenuAction title={t("common:actions.delete")} icon="trash" destructive onPress={remove} />
      </Link.Menu>
    </Link>
  );
});
