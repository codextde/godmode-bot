import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useCallback, useMemo } from "react";
import { Alert, RefreshControl, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AutomationEvent, Routine } from "@godmode/shared";
import { EventRow } from "@/components/automation-event";
import { openChat } from "@/components/rows";
import { EmptyState, ErrorState, Hairline, SkeletonRows, T } from "@/components/ui";
import { api, ApiError, errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

const LIMIT = 100;

/** Opens the chat the event's run worked in: the automation's own, or the run's. */
function openEvent(event: AutomationEvent, routine: Routine | undefined, failed: string) {
  if (!event.runId) return;
  if (routine?.reuseConversation && routine.conversationId) return openChat(routine.conversationId);
  const runId = event.runId;
  queryClient
    .fetchQuery({ queryKey: qk.run(runId), queryFn: () => api.runs.get(runId) })
    .then((r) => openChat(r.conversationId))
    .catch((err) => Alert.alert(failed, errorText(err)));
}

/** What started, skipped or failed every automation lately, newest first (read-only). */
export default function AutomationEvents() {
  const { t } = useTranslation("automations");
  const events = useQuery({ queryKey: qk.automationEvents, queryFn: () => api.automationEvents(LIMIT) });
  const routines = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const byId = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r])), [routines.data]);
  const pull = usePullRefresh(() => Promise.all([events.refetch(), routines.refetch()]));
  const list = events.data ?? [];

  const renderItem: ListRenderItem<AutomationEvent> = useCallback(
    ({ item }) => {
      const routine = byId.get(item.routineId);
      return <EventRow event={item} automation={routine?.name} onPress={item.runId ? () => openEvent(item, routine, t("events.openFailed")) : undefined} />;
    },
    [byId, t],
  );

  return (
    <>
      <Stack.Title>{t("events.menu")}</Stack.Title>
      <FlashList
        data={list}
        keyExtractor={(e) => e.id}
        renderItem={renderItem}
        extraData={byId}
        ItemSeparatorComponent={Separator}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListFooterComponent={
          list.length >= LIMIT ? (
            <T variant="footnote" muted style={{ textAlign: "center", padding: space.lg }}>
              {t("events.latest", { count: LIMIT })}
            </T>
          ) : null
        }
        ListEmptyComponent={
          events.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={8} avatar={28} />
            </View>
          ) : events.error instanceof ApiError && events.error.code === "device_forbidden" ? (
            <EmptyState icon="workflow" title={t("events.unavailableTitle")} body={t("events.unavailableBody")} />
          ) : events.isError ? (
            <ErrorState title={t("events.loadFailed")} error={errorText(events.error)} onRetry={() => void events.refetch()} />
          ) : (
            <EmptyState icon="workflow" title={t("events.emptyTitle")} body={t("events.emptyBody")} />
          )
        }
      />
    </>
  );
}

const Separator = () => <Hairline inset={space.lg + 28 + space.md} />;
