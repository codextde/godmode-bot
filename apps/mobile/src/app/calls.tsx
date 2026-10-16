import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { memo, useCallback } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { isCallActive, type Agent, type PhoneCall } from "@godmode/shared";
import { CallStatusBadge, callListQuery, callName, formatCallTime, openCall } from "@/components/call-parts";
import { CharacterAvatar } from "@/components/character";
import { Icon } from "@/components/icon";
import { EmptyState, ErrorState, Hairline, Row, SkeletonRows, T } from "@/components/ui";
import { ApiError, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

/** Calls agents made and took: who they talked to, how it went. Placed in Godmode on the computer. */
export default function Calls() {
  const list = useQuery(callListQuery);
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const calls = list.data ?? [];
  const live = calls.filter(isCallActive).length;

  const renderItem: ListRenderItem<PhoneCall> = useCallback(
    ({ item, index }) => (
      <>
        {index > 0 && <Hairline inset={72} />}
        <CallRow call={item} agent={item.agentId ? byId.get(item.agentId) : undefined} />
      </>
    ),
    [byId],
  );

  return (
    <>
      <Stack.Title>Calls</Stack.Title>
      <FlashList
        data={list.isLoading ? [] : calls}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        extraData={byId}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          live ? (
            <T variant="footnote" muted style={styles.note}>
              {live === 1 ? "1 call is on the line right now. Its transcript and summary arrive as soon as it ends." : `${live} calls are on the line right now. Their transcripts and summaries arrive as soon as they end.`}
            </T>
          ) : null
        }
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={40} />
            </View>
          ) : list.error instanceof ApiError && list.error.code === "device_forbidden" ? (
            <EmptyState icon="call" title="Calls aren't available yet" body="Update Godmode on your computer to see calls here." />
          ) : list.isError ? (
            <ErrorState title="Couldn't load your calls" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState
              icon="call"
              title="No calls yet"
              body="Agents can phone a business to book an appointment, follow up with a lead, or call you when a question can't wait. Calls are set up in Godmode on your computer."
            />
          )
        }
      />
    </>
  );
}

const CallRow = memo(function CallRow({ call: c, agent }: { call: PhoneCall; agent?: Agent }) {
  const colors = useColors();
  const inbound = c.direction === "inbound";
  const agentName = agent?.name ?? c.agentName;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${inbound ? "Incoming" : "Outgoing"} call with ${callName(c)}`}
      onPress={() => openCall(c.id)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.sunken }]}
    >
      <View style={[styles.tile, { backgroundColor: colors.sunken }]}>
        <Icon name={inbound ? "callIn" : "callOut"} size={17} color={inbound ? colors.skyMark : colors.brandStrong} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>
            {callName(c)}
          </T>
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {shortTime(c.createdAt)}
          </T>
        </Row>
        <T variant="footnote" muted numberOfLines={1}>
          {c.outcome || c.goal || (inbound ? "Incoming call" : "No goal given")}
        </T>
        <Row style={{ gap: space.sm, marginTop: 3 }}>
          <CallStatusBadge status={c.status} />
          {c.durationSecs != null ? (
            <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
              {formatCallTime(c.durationSecs)}
            </T>
          ) : null}
          {agentName ? (
            <Row style={{ gap: 5, flexShrink: 1 }}>
              {agent ? <CharacterAvatar agent={agent} size={16} /> : null}
              <T variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
                {agentName}
              </T>
            </Row>
          ) : null}
        </Row>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  note: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 13,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
