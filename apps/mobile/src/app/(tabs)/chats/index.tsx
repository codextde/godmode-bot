import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { useDeferredValue, useMemo, useState } from "react";
import { Alert, FlatList, RefreshControl, View } from "react-native";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { ConversationRow } from "@/components/rows";
import { EmptyState, ErrorState, Hairline, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
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
    queryFn: () => api.conversations.list({ search: q || undefined, limit: 200, workspaceId }),
  });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const runs = useLive((s) => s.runs);
  const running = useMemo(() => new Set(Object.values(runs).map((r) => r.run.conversationId)), [runs]);
  const data = inProject(list.data ?? [], projectId, byId).filter((conv) => conv.origin !== "dream");
  const projectOf = (conv: Conversation) => {
    if (projectId) return undefined;
    const id = chatProject(conv, byId);
    return id ? projects.get(id)?.project : undefined;
  };

  return (
    <>
      <Stack.Title large>Chats</Stack.Title>
      <Stack.SearchBar placeholder="Search chats" hideWhenScrolling={false} onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <HeaderActions actions={[{ icon: "compose", label: "New chat", onPress: () => router.push("/compose") }]} />
      <FlatList
        data={data}
        keyExtractor={(conv) => conv.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}>
            <WorkspaceChip />
          </View>
        }
        ItemSeparatorComponent={() => <Hairline inset={76} />}
        renderItem={({ item }) => <ChatItem conversation={item} agent={byId.get(item.agentId)} running={running.has(item.id)} project={projectOf(item)} />}
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

function ChatItem({ conversation, agent, running, project }: { conversation: Conversation; agent?: Agent; running: boolean; project?: Project }) {
  const update = useMutation({
    mutationFn: (patch: { pinned?: boolean; archived?: boolean }) => api.conversations.update(conversation.id, patch),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.conversations }),
    onError: (err) => Alert.alert("Couldn't change the chat", errorText(err)),
  });
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
}
