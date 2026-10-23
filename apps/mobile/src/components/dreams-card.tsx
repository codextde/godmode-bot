import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import type { Agent, Dream, DreamOverview, DreamStatus } from "@godmode/shared";
import { Group, LinkRow } from "./form";
import { Icon, type IconName } from "./icon";
import {
  ACTIVE_DREAM,
  CHANGE_KINDS,
  DreamStatusBadge,
  ROLLED_BACK,
  changeCounts,
  dreamWhen,
  entryCount,
  fileList,
  plural,
  reviewedLabel,
  shortChars,
  upcomingWhen,
} from "./dream-parts";
import { Button, Card, Hairline, SectionTitle, Skeleton, T, tap } from "./ui";
import { api, ApiError, errorText } from "@/lib/api";
import { elapsed } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { alpha, radius, space, useColors, type Colors } from "@/lib/theme";

const JOURNAL_PREVIEW = 3;

/** An older Godmode on the computer doesn't let the phone read it. */
const refused = (err: unknown) => err instanceof ApiError && (err.status === 403 || err.status === 404);

const LAST_DREAM: Partial<Record<DreamStatus, string>> = {
  failed: "Last dream failed",
  cancelled: "Last dream was cancelled",
  paused: "Last dream paused",
};

const NODE: Record<DreamStatus, { icon: IconName; color: (c: Colors) => string }> = {
  queued: { icon: "clock", color: (c) => c.textMuted },
  running: { icon: "moon", color: (c) => c.dream },
  succeeded: { icon: "moon", color: (c) => c.dream },
  failed: { icon: "warning", color: (c) => c.danger },
  cancelled: { icon: "closeCircle", color: (c) => c.textMuted },
  paused: { icon: "pause", color: (c) => c.warning },
  reverted: { icon: "unarchive", color: (c) => c.textMuted },
};

/** The desktop's dreams panel: whether the agent dreams and when next, "Dream now", and its dream journal. */
export function DreamsCard({ agent }: { agent: Agent }) {
  const c = useColors();
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: qk.dreams(agent.id),
    queryFn: () => api.dreams.overview(agent.id),
    refetchInterval: (query) => (query.state.data?.active ? 5_000 : 60_000),
    retry: (count, err) => !refused(err) && count < 2,
  });
  const start = useMutation({
    mutationFn: () => api.dreams.start(agent.id),
    onSuccess: (dream) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.setQueryData<DreamOverview>(qk.dreams(agent.id), (old) =>
        old ? { ...old, active: dream, dreams: [dream, ...old.dreams.filter((d) => d.id !== dream.id)] } : old,
      );
      void queryClient.invalidateQueries({ queryKey: qk.dreams(agent.id) });
      void queryClient.invalidateQueries({ queryKey: qk.agentMemory(agent.id) });
    },
    onError: (err) => {
      Alert.alert("Couldn't start a dream", errorText(err));
      void queryClient.invalidateQueries({ queryKey: qk.dreams(agent.id) });
    },
  });

  if (q.isError && refused(q.error)) return null;
  const o = q.data;
  if (o && !o.enabled && !o.active && !o.dreams.length) {
    return (
      <Group title="Dreaming">
        <LinkRow icon="moon" title="Off" detail="Dreaming is off — turn it on in Settings → Memory" onPress={() => router.push("/settings/memory")} />
      </Group>
    );
  }
  const active = o?.active ?? null;
  const dreams = o?.dreams ?? [];
  const shown = showAll ? dreams : dreams.slice(0, JOURNAL_PREVIEW);
  const older = dreams.length - JOURNAL_PREVIEW;

  return (
    <View>
      <SectionTitle title="Dreaming" />
      <Card style={{ overflow: "hidden" }}>
        <View style={styles.head}>
          <View style={{ flexDirection: "row", gap: space.md }}>
            <View style={[styles.tile, { backgroundColor: active ? c.dreamSoft : c.sunken, borderColor: active ? alpha(c.dream, 0.3) : c.border }]}>
              <Icon name="moon" size={17} color={c.dream} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3, justifyContent: "center" }}>
              {q.isLoading ? (
                <>
                  <Skeleton width="80%" height={13} />
                  <Skeleton width="55%" height={13} />
                </>
              ) : q.isError ? (
                <T variant="footnote" color={c.danger}>
                  {`Couldn't load dreams: ${errorText(q.error)}`}
                </T>
              ) : o ? (
                <StatusLines overview={o} agent={agent} />
              ) : null}
            </View>
          </View>
          <Button
            title="Dream now"
            icon="sparkles"
            variant="secondary"
            disabled={!o || !!active || !agent.enabled}
            loading={start.isPending}
            onPress={() => start.mutate()}
          />
        </View>

        {o ? (
          dreams.length ? (
            <View>
              <Hairline />
              <T variant="eyebrow" muted style={styles.eyebrow}>
                Dream journal
              </T>
              {shown.map((d, i) => (
                <View key={d.id}>
                  {i > 0 && <Hairline inset={space.lg + 26 + space.md} />}
                  <JournalRow dream={d} />
                </View>
              ))}
              {older > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    tap();
                    setShowAll((v) => !v);
                  }}
                  style={({ pressed }) => [styles.more, { borderTopColor: c.border }, pressed && { backgroundColor: c.sunken }]}
                >
                  <Icon name={showAll ? "up" : "down"} size={11} color={c.textMuted} weight="semibold" />
                  <T variant="footnote" muted style={{ fontWeight: "500" }}>
                    {showAll ? "Show fewer" : `Show ${plural(older, "older dream")}`}
                  </T>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <View>
              <Hairline />
              <T variant="footnote" muted style={{ padding: space.lg }}>
                Every dream lands here: what {agent.name} reviewed, what it changed in its memory and why — with a line-by-line diff.
              </T>
            </View>
          )
        ) : null}
      </Card>
    </View>
  );
}

function StatusLines({ overview: o, agent }: { overview: DreamOverview; agent: Agent }) {
  const c = useColors();
  const minExchanges = useSettings().data?.memory?.dreaming?.minNewExchanges;
  const active = o.active;

  if (active) {
    const queued = active.status === "queued";
    return (
      <>
        <T variant="subhead" color={c.dream} style={{ fontWeight: "600" }}>
          {queued ? "Waiting to dream…" : "Dreaming…"}
          {!queued ? <DreamElapsed since={active.startedAt ?? active.createdAt} /> : null}
        </T>
        <T variant="footnote" muted>
          {reviewedLabel(active)}
        </T>
        {queued ? (
          <T variant="footnote" muted>
            {`Starts as soon as ${agent.name} has finished what it's doing.`}
          </T>
        ) : null}
      </>
    );
  }

  const last = o.dreams.find((d) => !ACTIVE_DREAM.includes(d.status));
  const lastAt = last ? new Date(last.finishedAt ?? last.createdAt) : null;
  const threshold = Math.max(1, minExchanges ?? 1);
  const { exchanges, conversations } = o.pending;
  const lastText =
    last && lastAt
      ? `${LAST_DREAM[last.status] ?? "Last dream"} ${formatDistanceToNowStrict(lastAt, { addSuffix: true })}${
          last.status === "paused" ? (last.reason === "size" ? " — the next scheduled dream takes over" : ` — it continues when ${agent.name} is idle`) : ""
        }${last.status === "reverted" ? " (undone)" : ""}`
      : "Hasn't dreamt yet";
  const nextText = !o.enabled
    ? "Dreaming is off — turn it on in Settings → Memory"
    : o.nextDreamAt
      ? `Next dream ${upcomingWhen(o.nextDreamAt)}`
      : "No upcoming dream — check the schedule in Settings → Memory";

  return (
    <>
      <T variant="subhead" style={{ fontWeight: "500" }}>
        {lastText}
      </T>
      <T variant="footnote" muted>
        {nextText}
      </T>
      {!agent.enabled ? (
        <T variant="footnote" muted>
          {agent.name} is switched off — switch it on to let it dream.
        </T>
      ) : exchanges > 0 ? (
        <T variant="footnote" muted>
          <T variant="footnote" style={{ fontWeight: "500" }}>
            {plural(exchanges, "new exchange")}
          </T>{" "}
          in {plural(conversations, "chat")} waiting{o.enabled && exchanges < threshold ? ` — the next scheduled dream needs ${threshold}` : ""}
        </T>
      ) : (
        <T variant="footnote" muted>
          {last ? "Nothing new since the last dream." : "Nothing to dream about yet — chat with the agent first."}
        </T>
      )}
    </>
  );
}

/** " · 1m 04s", ticking while the dream runs. */
function DreamElapsed({ since }: { since: string }) {
  const now = useNow(1000);
  return <T variant="subhead" muted style={{ fontWeight: "400" }}>{` · ${elapsed(since, now)}`}</T>;
}

/** What a dream changed, in one line: "3 added · 2 updated · MEMORY.md 7.8k → 6.1k". */
function changeLine(d: Dream): { text: string; danger?: boolean } | null {
  if (d.status === "failed" && d.error) return { text: d.error, danger: true };
  if (ROLLED_BACK.includes(d.status)) {
    if (d.changes.length) return { text: d.files.length ? "Attempted — rolled back where possible" : "Attempted — rolled back, nothing was kept" };
    return d.error ? { text: d.error } : null;
  }
  if (ACTIVE_DREAM.includes(d.status)) return null;
  const parts = changeCounts(d).map(({ kind, n }) => `${n} ${CHANGE_KINDS[kind].label.toLowerCase()}`);
  if (!parts.length && d.files.length) parts.push(fileList(d.files));
  if (d.memoryChars && shortChars(d.memoryChars.before) !== shortChars(d.memoryChars.after)) {
    parts.push(`MEMORY.md ${shortChars(d.memoryChars.before)} → ${shortChars(d.memoryChars.after)}`);
  }
  if (d.workspace.length) parts.push(entryCount(d.workspace.length));
  if (parts.length) return { text: parts.join(" · ") };
  return d.status === "succeeded" ? { text: "Memory was already in good shape — nothing to rewrite." } : null;
}

function JournalRow({ dream: d }: { dream: Dream }) {
  const c = useColors();
  const node = NODE[d.status] ?? NODE.queued;
  const rolledBack = ROLLED_BACK.includes(d.status);
  const line = changeLine(d);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Dream of ${dreamWhen(d.createdAt)}`}
      onPress={() => {
        tap();
        router.push({ pathname: "/dream/[id]", params: { id: d.id } });
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.node, { borderColor: c.border, backgroundColor: d.status === "running" ? c.dreamSoft : c.surface }]}>
        <Icon name={node.icon} size={12} color={node.color(c)} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T variant="subhead" style={{ flex: 1, fontWeight: "500" }} numberOfLines={1}>
            {dreamWhen(d.createdAt)}
          </T>
          <DreamStatusBadge status={d.status} />
        </View>
        <T variant="footnote" muted={rolledBack || !d.summary} numberOfLines={2}>
          {d.summary || (ACTIVE_DREAM.includes(d.status) ? "Consolidating memory…" : reviewedLabel(d))}
        </T>
        {line ? (
          <T variant="caption" color={line.danger ? c.danger : c.textMuted} numberOfLines={1}>
            {line.text}
          </T>
        ) : null}
      </View>
      <Icon name="chevron" size={11} color={c.textFaint} style={{ alignSelf: "center" }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: {
    padding: space.lg,
    gap: space.md,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  eyebrow: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  node: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
