import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { Alert, RefreshControl, View } from "react-native";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { ConversationRow } from "@/components/rows";
import { EmptyState, ErrorState, Hairline, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { CHAT_LIST_LIMIT, useAgents } from "@/lib/hooks";
import { useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { inProject, useProjectIndex, useWorkspace, chatProject } from "@/lib/workspace";
import { space } from "@/lib/theme";

export default function Chats() {
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
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
  const data = useMemo(() => inProject(list.data ?? [], projectId, byId).filter((conv) => conv.origin !== "dream"), [list.data, projectId, byId]);
  const renderItem: ListRenderItem<Conversation> = useCallback(
    ({ item }) => {
      const id = projectId ? null : chatProject(item, byId);
      return <ChatItem conversation={item} agent={byId.get(item.agentId)} running={running.has(item.id)} project={id ? projects.get(id)?.project : undefined} />;
    },
    [byId, running, projectId, projects],
  );

  return (
    <>
      <Stack.Title large>Chats</Stack.Title>
      <Stack.SearchBar placeholder="Search chats" hideWhenScrolling={false} onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <HeaderActions actions={[{ icon: "compose", label: "New chat", onPress: () => router.push("/compose") }]} />
      <FlashList
        data={data}
        keyExtractor={(conv) => conv.id}
        renderItem={renderItem}
        extraData={running}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={Header}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          list.isLoading ? (
            <SkeletonRows count={8} />
          ) : list.isError ? (
            <ErrorState title="Couldn't load your chats" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : q ? (
            <EmptyState icon="search" title="Nothing found" body={`No chat mentions “${q}”.`} />
          ) : (
            <EmptyState
              icon="chats"
              title="No chats yet"
              body={
                project
                  ? `Chats in ${project.name} show up here. Start one and it works with the project's context.`
                  : workspace
                  ? `Chats in ${workspace.name} show up here. Start one and it runs with this workspace's context.`
                  : "Ask Godmode something and the conversation shows up here, on your computer too."
              }
            />
          )
        }
      />
    </>
  );
}

const Separator = () => <Hairline inset={76} />;

const Header = () => (
  <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}>
    <WorkspaceChip />
  </View>
);

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
