import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, View } from "react-native";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { ConversationRow } from "@/components/rows";
import { Icon, type IconName } from "@/components/icon";
import { SegmentedTabs } from "@/components/segmented-tabs";
import { EmptyState, ErrorState, Hairline, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { chatSource, SOURCES, sourceStats, TABS, useChatFilters, type ChatSource, type RecentTab } from "@/lib/chat-filters";
import { chatBucket, chatDayLabel, continuesAt } from "@/lib/desktop-parity";
import { CHAT_LIST_LIMIT, useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { inProject, useProjectIndex, useWorkspace, chatProject } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

type Tab = RecentTab;
type Item = { kind: "header"; key: string; title: string } | { kind: "chat"; key: string; conversation: Conversation; divided: boolean };

const EMPTY: Record<Tab, { icon: IconName; title: string; body: string }> = {
  all: { icon: "chats", title: "No chats yet", body: "New chats you start land in this list, on your computer too." },
  running: { icon: "bolt", title: "Nothing running", body: "Chats that work or wait for you show up here." },
  scheduled: { icon: "clock", title: "Nothing scheduled", body: "When an agent plans to check back later, the chat waits here." },
  done: { icon: "check", title: "Nothing finished yet", body: "Finished chats land here." },
};

const EMPTY_SOURCE: Record<ChatSource, { icon: IconName; title: string; body: string }> = {
  mine: { icon: "chats", title: "No chats from you yet", body: "Chats you start show up here. Automations and agents have their own tabs." },
  automations: { icon: "clock", title: "No automation chats", body: "When an automation runs, its chat lands here." },
  agents: { icon: "user", title: "No agent chats", body: "Handovers, board tasks and heartbeats agents start themselves land here." },
};

/** The chats a run works on right now, and the ones waiting for a free slot. */
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
  const [search, setSearch] = useState("");
  // The search reads every message on the computer: ask once the typing pauses.
  const [q, setQ] = useState("");
  useEffect(() => {
    const next = search.trim();
    if (!next) return setQ("");
    const timer = setTimeout(() => setQ(next), 300);
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
    queryKey: [...qk.conversations, "has-archived", workspaceId ?? "all"],
    queryFn: async () => (await api.conversations.list({ archived: true, limit: 1, workspaceId })).length > 0,
  }).data;
  // Archived chats that still work, wait or come back on their own.
  const archivedOngoing =
    useQuery({
      queryKey: [...qk.conversations, "archived-ongoing", workspaceId ?? "all"],
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
    const n = { running: 0, scheduled: 0, needsYou: 0 };
    for (const conv of visible) {
      const bucket = chatBucket(conv, live(conv));
      if (bucket !== "done") n[bucket]++;
      if (conv.paused?.reason === "question") n.needsYou++;
    }
    return n;
  }, [visible, live]);
  const unread = useMemo(() => visible.flatMap((conv) => (conv.unread ? [conv.id] : [])), [visible]);
  const markRead = () => {
    tap();
    api.conversations
      .read(unread.slice(0, 500))
      .catch((err) => Alert.alert("Couldn't mark the chats read", errorText(err)))
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
      const label = dated ? (conversation.pinned ? "Pinned" : chatDayLabel(conversation.lastMessageAt ?? conversation.createdAt, now)) : null;
      if (label && label !== day) out.push({ kind: "header", key: `h-${label}`, title: label });
      out.push({ kind: "chat", key: conversation.id, conversation, divided: out.length > 0 && out[out.length - 1]!.kind === "chat" });
      day = label;
    }
    return out;
  }, [visible, tab, live, q]);

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
      ? EMPTY_SOURCE[source]
      : tab === "all" && scopeName
        ? { ...EMPTY.all, title: `No chats in ${scopeName} yet`, body: "New chats you start here land in this list." }
        : EMPTY[tab];

  return (
    <>
      <Stack.Title large>Chats</Stack.Title>
      <Stack.SearchBar placeholder="Search chats" hideWhenScrolling={false} onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <HeaderActions
        actions={[
          { icon: "archive", label: "Archived chats", onPress: () => router.push("/archived") },
          { icon: "compose", label: "New chat", onPress: () => router.push("/compose") },
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
            <Row style={{ gap: space.sm, justifyContent: "space-between", marginBottom: space.xs }}>
              <WorkspaceChip />
              {unread.length > 0 && <MarkRead onPress={markRead} />}
            </Row>
            {!q && (
              <SegmentedTabs
                label="Who started the chats"
                value={source}
                onChange={setSource}
                tabs={SOURCES.map((s) => {
                  const { unread: n, needsYou } = sources[s.value];
                  return {
                    value: s.value,
                    label: s.label,
                    accessibilityHint: s.hint,
                    dot: s.value === "all" ? null : needsYou > 0 ? "warning" : n > 0 ? "brand" : null,
                  };
                })}
              />
            )}
            <SegmentedTabs
              label="Filter recent chats"
              value={tab}
              onChange={setTab}
              tabs={TABS.map((t) => ({
                value: t.value,
                label: t.label,
                accessibilityHint: t.hint,
                count: t.value === "running" || t.value === "scheduled" ? counts[t.value] : 0,
                tone: t.value === "running" ? (counts.needsYou > 0 ? "warning" : "brand") : "neutral",
              }))}
            />
          </View>
        }
        ListFooterComponent={hasArchived && !q ? <ArchivedLink ongoing={archivedOngoing} /> : null}
        ListEmptyComponent={
          list.isLoading ? (
            <SkeletonRows count={8} />
          ) : list.isError ? (
            <ErrorState title="Couldn't load your chats" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : q ? (
            <EmptyState icon="search" title="Nothing found" body={`No chat mentions “${q}”.`} />
          ) : (
            <EmptyState icon={empty.icon} title={empty.title} body={empty.body} />
          )
        }
      />
    </>
  );
}

function MarkRead({ onPress }: { onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
      <T variant="footnote" color={c.textMuted} style={{ fontWeight: "500" }}>
        Mark all read
      </T>
    </Pressable>
  );
}

/** The archive, with how many of its chats still have work ahead. */
function ArchivedLink({ ongoing }: { ongoing: number }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        router.push("/archived");
      }}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.lg, paddingHorizontal: space.md, height: 44, borderRadius: radius.lg, borderCurve: "continuous" }, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name="archive" size={15} color={c.textMuted} />
      <T variant="subhead" muted style={{ flex: 1 }}>
        Archived chats
      </T>
      {ongoing > 0 && (
        <View
          accessibilityLabel={`${ongoing === 1 ? "1 archived chat still has" : `${ongoing} archived chats still have`} work ahead`}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 20, paddingHorizontal: 7, borderRadius: radius.pill, backgroundColor: c.sunken }}
        >
          <Icon name="clock" size={10} color={c.brandStrong} />
          <T variant="caption" style={{ fontVariant: ["tabular-nums"], fontWeight: "600" }}>
            {ongoing}
          </T>
        </View>
      )}
      <Icon name="chevron" size={12} color={c.textMuted} />
    </Pressable>
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
    .catch((err) => Alert.alert("Couldn't change the chat", errorText(err)))
    .finally(() => void queryClient.invalidateQueries({ queryKey: qk.conversations }));
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
  const update = { mutate: (patch: { pinned?: boolean; archived?: boolean }) => changeChat(conversation.id, patch) };
  const remove = () =>
    Alert.alert("Delete this chat?", "It's removed on your computer too.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void api.conversations
            .delete(conversation.id)
            .then(() => queryClient.invalidateQueries({ queryKey: qk.conversations }))
            .catch((err) => Alert.alert("Couldn't delete the chat", errorText(err))),
      },
    ]);

  const row = <ConversationRow conversation={conversation} agent={agent} from={from} running={running} queued={queued} project={project} />;
  if (process.env.EXPO_OS !== "ios") return row;
  return (
    <Link href={{ pathname: "/chat/[id]", params: { id: conversation.id } }} asChild>
      <Link.Trigger>
        <View>{row}</View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {conversation.unread ? <Link.MenuAction title="Mark as read" icon="checkmark.message" onPress={() => void api.conversations.read([conversation.id]).finally(() => void queryClient.invalidateQueries({ queryKey: qk.conversations }))} /> : null}
        <Link.MenuAction title={conversation.pinned ? "Unpin" : "Pin"} icon={conversation.pinned ? "pin.slash" : "pin"} onPress={() => update.mutate({ pinned: !conversation.pinned })} />
        <Link.MenuAction title="Archive" icon="archivebox" onPress={() => update.mutate({ archived: true })} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={remove} />
      </Link.Menu>
    </Link>
  );
});
