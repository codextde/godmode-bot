import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useDeferredValue, useState } from "react";
import { RefreshControl, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Conversation } from "@godmode/shared";
import { failureText } from "@/components/agent-actions";
import { ConversationRow } from "@/components/rows";
import { SegmentedTabs } from "@/components/segmented-tabs";
import { EmptyState, ErrorState, Hairline, SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useRunningChats } from "@/lib/live";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

type Show = "active" | "archived";

const LIMIT = 200;

/** Every chat of one agent, like the desktop's Chats tab: found by their words, the archived ones a tap away. */
export default function AgentChats() {
  const { t } = useTranslation(["agents", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgents().byId.get(id);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("active");
  const q = useDeferredValue(search.trim());
  const archived = show === "archived";
  const list = useQuery({
    queryKey: qk.agentChats(id, q, archived),
    queryFn: () => api.conversations.list({ agentId: id, search: q || undefined, archived, limit: LIMIT }),
    placeholderData: keepPreviousData,
  });
  const pull = usePullRefresh(list.refetch);
  const running = useRunningChats();

  const renderItem: ListRenderItem<Conversation> = useCallback(
    ({ item, index }) => (
      <>
        {index > 0 && <Hairline inset={76} />}
        <ConversationRow conversation={item} agent={agent} running={running.has(item.id)} />
      </>
    ),
    [agent, running],
  );

  const chats = (list.data ?? []).filter((conv) => conv.origin !== "dream" && conv.origin !== "review");
  return (
    <>
      <Stack.Title>{t("chats.title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("chats.search")} hideWhenScrolling={false} onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <FlashList
        data={list.isLoading ? [] : chats}
        keyExtractor={(conv) => conv.id}
        renderItem={renderItem}
        extraData={running}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}>
            <SegmentedTabs
              label={t("chats.showLabel")}
              value={show}
              onChange={setShow}
              tabs={[
                { value: "active", label: t("chats.active") },
                { value: "archived", label: t("chats.archived") },
              ]}
            />
          </View>
        }
        ListEmptyComponent={
          list.isLoading ? (
            <SkeletonRows count={7} />
          ) : list.isError ? (
            <ErrorState title={t("chats.loadFailed")} error={failureText(list.error)} onRetry={() => void list.refetch()} />
          ) : q ? (
            <EmptyState icon="search" title={t("chats.noMatch", { query: q })} />
          ) : (
            <EmptyState
              icon={archived ? "archive" : "chats"}
              title={archived ? t("chats.noArchived") : t("chats.empty", { name: agent?.name ?? t("common:words.agent") })}
            />
          )
        }
      />
    </>
  );
}
