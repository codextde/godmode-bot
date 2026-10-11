import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, Stack } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import type { Agent, Conversation, Project } from "@godmode/shared";
import { ConversationRow } from "@/components/rows";
import { EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { chatProject, inProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string; hint?: string } | { kind: "chat"; key: string; conversation: Conversation; divided: boolean };

const LIMIT = 200;

/** Chats taken out of the list. Archiving stops nothing, so the ones with work ahead come first. */
export default function ArchivedChats() {
  const { id: workspaceId, projectId } = useWorkspace();
  const projects = useProjectIndex();
  const list = useQuery({ queryKey: qk.archivedChats(workspaceId), queryFn: () => api.conversations.list({ archived: true, limit: LIMIT, workspaceId }) });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const running = useRunningChats();

  const items = useMemo(() => {
    const chats = inProject(list.data ?? [], projectId, byId).filter((conv) => conv.origin !== "dream");
    const isGoing = (conv: Conversation) => running.has(conv.id) || !!conv.paused || !!conv.followup;
    const going = chats.filter(isGoing);
    const out: Item[] = [];
    const add = (group: Conversation[]) => group.forEach((conversation, i) => out.push({ kind: "chat", key: conversation.id, conversation, divided: i > 0 }));
    if (going.length) {
      out.push({ kind: "header", key: "h-going", title: "Still going", hint: "Archived, but the agent keeps working or comes back to them." });
      add(going);
      if (going.length < chats.length) out.push({ kind: "header", key: "h-archived", title: "Archived" });
    }
    add(chats.filter((conv) => !isGoing(conv)));
    return out;
  }, [list.data, projectId, byId, running]);

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

  return (
    <>
      <Stack.Title>Archived chats</Stack.Title>
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        extraData={running}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.sm }}>
              <SkeletonRows count={8} />
            </View>
          ) : list.isError ? (
            <ErrorState title="Couldn't load archived chats" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState icon="archive" title="No archived chats" body="Chats you archive land here. Long-press a chat to archive it." />
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

const refreshChats = () => void queryClient.invalidateQueries({ queryKey: qk.conversations });

/** Out of every cached archive right away; the refetch brings it back if the computer refused. */
function dropFromArchive(id: string) {
  queryClient.setQueriesData<Conversation[]>({ queryKey: [...qk.conversations, "archived"] }, (list) => list?.filter((conv) => conv.id !== id));
}

function unarchiveChat(id: string) {
  dropFromArchive(id);
  api.conversations
    .update(id, { archived: false })
    .catch((err) => Alert.alert("Couldn't unarchive the chat", errorText(err)))
    .finally(refreshChats);
}

function deleteChat(id: string) {
  Alert.alert("Delete this chat?", "It's removed on your computer too.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: () => {
        dropFromArchive(id);
        api.conversations
          .delete(id)
          .catch((err) => Alert.alert("Couldn't delete the chat", errorText(err)))
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
  const row = <ConversationRow conversation={conversation} agent={agent} running={running} project={project} />;
  if (process.env.EXPO_OS !== "ios") {
    return (
      <>
        {divided && <Hairline inset={76} />}
        <View style={styles.withAction}>
          <View style={{ flex: 1, minWidth: 0 }}>{row}</View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Unarchive ${conversation.title || "this chat"}`}
            hitSlop={8}
            onPress={() => {
              tap();
              unarchiveChat(conversation.id);
            }}
            style={({ pressed }) => [styles.action, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
          >
            <T variant="footnote" style={{ fontWeight: "600" }}>
              Unarchive
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
          {row}
        </View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        <Link.MenuAction title="Unarchive" icon="arrow.uturn.backward" onPress={() => unarchiveChat(conversation.id)} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={() => deleteChat(conversation.id)} />
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
