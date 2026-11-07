import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, Stack } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { FilterChips } from "@/components/filter-chips";
import { ConversationRow } from "@/components/rows";
import { useMenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { chatDayLabel, continuesAt } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { agentsFor, chatProject, inProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string; hint?: string } | { kind: "chat"; key: string; conversation: Conversation; divided: boolean };

const LIMIT = 200;
const ALL = "all";

/**
 * Chats taken out of the list, by when they were last active. Archiving stops nothing, so the ones with work ahead
 * (running, paused, coming back on their own) come first. Searchable, and filtered by agent like on the computer.
 */
export default function ArchivedChats() {
  const { t } = useTranslation(["tasks", "chat"]);
  const { id: workspaceId, projectId } = useWorkspace();
  const projects = useProjectIndex();
  const { data: agents = [], byId } = useAgents();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const next = search.trim();
    const timer = setTimeout(() => setQ(next), next ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search]);
  const [agentFilter, setAgentFilter] = useState(ALL);
  const agentId = agentFilter === ALL ? undefined : agentFilter;
  const filter = { archived: true, limit: LIMIT, workspaceId, search: q || undefined, agentId };
  const list = useQuery({
    queryKey: [...qk.archivedChats(workspaceId), "list", q, agentFilter],
    queryFn: () => api.conversations.list(filter),
    placeholderData: keepPreviousData,
  });
  // What still works, waits or comes back by itself, as the computer counts it (also queued messages and runs).
  const ongoing = useQuery({
    queryKey: [...qk.archivedChats(workspaceId), "ongoing", q, agentFilter],
    queryFn: () => api.conversations.list({ ...filter, ongoing: true }),
    placeholderData: keepPreviousData,
  });
  const pull = usePullRefresh(() => Promise.all([list.refetch(), ongoing.refetch()]));
  const running = useRunningChats();
  const filters = useMemo(() => {
    const shown = agentsFor(agents, workspaceId);
    return shown.length > 1 ? [{ id: ALL, label: t("chat:archive.allAgents") }, ...shown.map((a) => ({ id: a.id, label: a.name }))] : [];
  }, [agents, workspaceId, t]);

  const items = useMemo(() => {
    const keep = (convs: Conversation[]) => inProject(convs, projectId, byId).filter((conv) => conv.origin !== "dream" && conv.origin !== "review");
    const chats = keep(list.data ?? []);
    const server = new Set((ongoing.data ?? []).map((conv) => conv.id));
    const isGoing = (conv: Conversation) => server.has(conv.id) || running.has(conv.id) || !!conv.paused || !!conv.followup;
    const going = [...keep(ongoing.data ?? []), ...chats.filter((conv) => !server.has(conv.id) && isGoing(conv))].sort((a, b) =>
      continuesAt(a).localeCompare(continuesAt(b)),
    );
    const out: Item[] = [];
    const add = (group: Conversation[]) => group.forEach((conversation, i) => out.push({ kind: "chat", key: conversation.id, conversation, divided: i > 0 }));
    if (going.length) {
      out.push({ kind: "header", key: "h-going", title: t("archivedChats.stillGoing"), hint: t("archivedChats.stillGoingHint") });
      add(going);
    }
    const now = new Date();
    let day: string | null = null;
    let group: Conversation[] = [];
    const flush = () => {
      if (!group.length) return;
      out.push({ kind: "header", key: `h-${day}`, title: day! });
      add(group);
      group = [];
    };
    for (const conv of chats) {
      if (isGoing(conv)) continue;
      const label = chatDayLabel(conv.lastMessageAt ?? conv.createdAt, now);
      if (label !== day) {
        flush();
        day = label;
      }
      group.push(conv);
    }
    flush();
    return out;
  }, [list.data, ongoing.data, projectId, byId, running, t]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      if (item.kind === "header") return <GroupTitle title={item.title} hint={item.hint} />;
      const conv = item.conversation;
      const id = projectId ? null : chatProject(conv, byId);
      return (
        <ArchivedChat conversation={conv} agent={byId.get(conv.agentId)} running={running.has(conv.id)} project={id ? projects.get(id)?.project : undefined} divided={item.divided} />
      );
    },
    [byId, running, projectId, projects],
  );

  const filtered = !!q || agentFilter !== ALL;

  return (
    <>
      <Stack.Title>{t("archivedChats.title")}</Stack.Title>
      <Stack.SearchBar
        placeholder={t("chat:archive.search")}
        hideWhenScrolling={false}
        onChangeText={(e) => setSearch(e.nativeEvent.text)}
        onCancelButtonPress={() => setSearch("")}
      />
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        extraData={running}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          filters.length ? (
            <View style={{ paddingTop: space.sm }}>
              <FilterChips filters={filters} value={agentFilter} onChange={setAgentFilter} bleed={space.sm} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.sm }}>
              <SkeletonRows count={8} />
            </View>
          ) : list.isError ? (
            <ErrorState title={t("archivedChats.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : filtered ? (
            <EmptyState icon="search" title={t("chat:archive.noMatchTitle")} body={t("chat:archive.noMatchBody")} />
          ) : (
            <EmptyState icon="archive" title={t("archivedChats.emptyTitle")} body={t("archivedChats.emptyBody")} />
          )
        }
      />
    </>
  );
}

function GroupTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
      <SectionTitle title={title} />
      {hint ? (
        <T variant="footnote" muted style={{ paddingHorizontal: 4, marginBottom: space.sm }}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

const refreshChats = () => {
  void queryClient.invalidateQueries({ queryKey: qk.conversations });
  void queryClient.invalidateQueries({ queryKey: ["archived-count"] });
};

/** Out of every cached archive right away; the refetch brings it back if the computer refused. */
function dropFromArchive(id: string) {
  queryClient.setQueriesData<Conversation[]>({ queryKey: [...qk.conversations, "archived"] }, (list) => list?.filter((conv) => conv.id !== id));
}

function unarchiveChat(id: string) {
  dropFromArchive(id);
  api.conversations
    .update(id, { archived: false })
    .catch((err) => Alert.alert(t("tasks:archivedChats.unarchiveFailed"), errorText(err)))
    .finally(refreshChats);
}

function deleteChat(id: string) {
  Alert.alert(t("tasks:archivedChats.deleteTitle"), t("tasks:archivedChats.deleteBody"), [
    { text: t("common:actions.cancel"), style: "cancel" },
    {
      text: t("common:actions.delete"),
      style: "destructive",
      onPress: () => {
        dropFromArchive(id);
        api.conversations
          .delete(id)
          .catch((err) => Alert.alert(t("tasks:archivedChats.deleteFailed"), errorText(err)))
          .finally(refreshChats);
      },
    },
  ]);
}

/** Long press on iOS: unarchive or delete. Android has no such menu, so the row carries an Unarchive button. */
const ArchivedChat = memo(function ArchivedChat({
  conversation,
  agent,
  running,
  project,
  divided,
}: {
  conversation: Conversation;
  agent?: Agent;
  running: boolean;
  project?: Project;
  divided: boolean;
}) {
  const c = useColors();
  const { t } = useTranslation(["tasks", "common"]);
  const menu = useMenuSheet();
  const row = (onLongPress?: () => void) => <ConversationRow conversation={conversation} agent={agent} running={running} project={project} onLongPress={onLongPress} />;
  if (process.env.EXPO_OS !== "ios") {
    const items: HeaderMenuItem[] = [
      { icon: "unarchive", title: t("archivedChats.unarchive"), onPress: () => unarchiveChat(conversation.id) },
      { icon: "trash", title: t("common:actions.delete"), destructive: true, onPress: () => deleteChat(conversation.id) },
    ];
    return (
      <>
        {divided && <Hairline inset={76} />}
        {menu.sheet}
        <View style={styles.withAction}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {row(() => {
              tap();
              menu.show(items, conversation.title || undefined);
            })}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={conversation.title ? t("archivedChats.unarchiveA11y", { title: conversation.title }) : t("archivedChats.unarchiveThis")}
            hitSlop={8}
            onPress={() => {
              tap();
              unarchiveChat(conversation.id);
            }}
            style={({ pressed }) => [styles.action, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
          >
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {t("archivedChats.unarchive")}
            </T>
          </Pressable>
        </View>
      </>
    );
  }
  return (
    <Link href={{ pathname: "/chat/[id]", params: { id: conversation.id } }} asChild>
      <Link.Trigger>
        <View>
          {divided && <Hairline inset={76} />}
          {row()}
        </View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        <Link.MenuAction title={t("archivedChats.unarchive")} icon="arrow.uturn.backward" onPress={() => unarchiveChat(conversation.id)} />
        <Link.MenuAction title={t("common:actions.delete")} icon="trash" destructive onPress={() => deleteChat(conversation.id)} />
      </Link.Menu>
    </Link>
  );
});

const styles = StyleSheet.create({
  withAction: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: space.sm,
  },
  action: {
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    justifyContent: "center",
  },
});
