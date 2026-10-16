import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, RefreshControl, View } from "react-native";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { ConversationRow } from "@/components/rows";
import { FilterChips } from "@/components/filter-chips";
import type { IconName } from "@/components/icon";
import { EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { chatBucket, chatDayLabel, continuesAt, type ChatBucket } from "@/lib/desktop-parity";
import { CHAT_LIST_LIMIT, useAgents } from "@/lib/hooks";
import { useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { inProject, useProjectIndex, useWorkspace, chatProject } from "@/lib/workspace";
import { space } from "@/lib/theme";

type Tab = "all" | ChatBucket;
type Item = { kind: "header"; key: string; title: string } | { kind: "chat"; key: string; conversation: Conversation; divided: boolean };

const EMPTY: Record<Tab, { icon: IconName; title: string; body: string }> = {
  all: { icon: "chats", title: "No chats yet", body: "New chats you start land in this list, on your computer too." },
  running: { icon: "bolt", title: "Nothing running", body: "Chats that work or wait for you show up here." },
  scheduled: { icon: "clock", title: "Nothing scheduled", body: "When an agent plans to check back later, the chat waits here." },
  done: { icon: "check", title: "Nothing finished yet", body: "Finished chats land here." },
};

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
  const [tab, setTab] = useState<Tab>("all");
  const { id: workspaceId, workspace, projectId, project } = useWorkspace();
  const projects = useProjectIndex();
  const list = useQuery({
    queryKey: qk.conversationList(q, workspaceId),
    queryFn: () => api.conversations.list({ search: q || undefined, limit: CHAT_LIST_LIMIT, workspaceId }),
    placeholderData: (previous) => previous,
  });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const running = useRunningChats();
  const visible = useMemo(() => inProject(list.data ?? [], projectId, byId).filter((conv) => conv.origin !== "dream" && !conv.archived), [list.data, projectId, byId]);
  const counts = useMemo(() => {
    const n = { running: 0, scheduled: 0 };
    for (const conv of visible) {
      const bucket = chatBucket(conv, running.has(conv.id));
      if (bucket !== "done") n[bucket]++;
    }
    return n;
  }, [visible, running]);

  const items = useMemo(() => {
    const matching = visible
      .filter((conv) => tab === "all" || chatBucket(conv, running.has(conv.id)) === tab)
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
  }, [visible, tab, running, q]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      if (item.kind === "header") return <DayTitle title={item.title} />;
      const conv = item.conversation;
      const id = projectId ? null : chatProject(conv, byId);
      return (
        <>
          {item.divided && <Hairline inset={76} />}
          <ChatItem conversation={conv} agent={byId.get(conv.agentId)} running={running.has(conv.id)} project={id ? projects.get(id)?.project : undefined} />
        </>
      );
    },
    [byId, running, projectId, projects],
  );
  const scopeName = project?.name ?? workspace?.name ?? null;
  const empty = tab === "all" && scopeName ? { ...EMPTY.all, title: `No chats in ${scopeName} yet`, body: "New chats you start here land in this list." } : EMPTY[tab];

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
        extraData={running}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.md }}>
            <WorkspaceChip />
            <FilterChips
              bleed={space.lg}
              value={tab}
              onChange={setTab}
              filters={[
                { id: "all", label: "All" },
                { id: "running", label: "Running", count: counts.running },
                { id: "scheduled", label: "Scheduled", count: counts.scheduled },
                { id: "done", label: "Done" },
              ]}
            />
          </View>
        }
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

const ChatItem = memo(function ChatItem({ conversation, agent, running, project }: { conversation: Conversation; agent?: Agent; running: boolean; project?: Project }) {
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

  const row = <ConversationRow conversation={conversation} agent={agent} running={running} project={project} />;
  if (process.env.EXPO_OS !== "ios") return row;
  return (
    <Link href={{ pathname: "/chat/[id]", params: { id: conversation.id } }} asChild>
      <Link.Trigger>
        <View>{row}</View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        <Link.MenuAction title={conversation.pinned ? "Unpin" : "Pin"} icon={conversation.pinned ? "pin.slash" : "pin"} onPress={() => update.mutate({ pinned: !conversation.pinned })} />
        <Link.MenuAction title="Archive" icon="archivebox" onPress={() => update.mutate({ archived: true })} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={remove} />
      </Link.Menu>
    </Link>
  );
});
