import { useMutation, useQuery } from "@tanstack/react-query";
import { format, isThisYear, isToday, isYesterday } from "date-fns";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import {
  heartbeatIntervalText,
  normalizeHeartbeat,
  type Agent,
  type AgentHeartbeat,
  type AgentHeartbeatState,
  type HeartbeatBeat,
  type HeartbeatOutcome,
} from "@godmode/shared";
import { plural, upcomingWhen } from "./dream-parts";
import { Group, LinkRow } from "./form";
import { Icon } from "./icon";
import { openChat } from "./rows";
import { Button, Card, Hairline, SectionTitle, SkeletonRows, T, tap } from "./ui";
import { api, ApiError, errorText } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { alpha, radius, space, useColors, type Colors } from "@/lib/theme";

const BEATS_PREVIEW = 5;

/** An older Godmode on the computer doesn't let the phone read it. */
const refused = (err: unknown) => err instanceof ApiError && (err.status === 403 || err.status === 404);

const openSettings = (agent: Agent) => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } });

/**
 * The desktop's heartbeat tab, read-only apart from "Wake now": where it stands, when it beats next and its last beats.
 * Off, it is one quiet row into the agent's settings, where the heartbeat is set up.
 */
export function HeartbeatCard({ agent }: { agent: Agent }) {
  const hb = normalizeHeartbeat(agent.heartbeat);
  if (!hb.enabled) {
    return (
      <Group title="Heartbeat">
        <LinkRow
          icon="pulse"
          title="Off"
          detail={`Wakes ${agent.name} on its own rhythm to move its tickets forward and run its checklist.`}
          onPress={() => openSettings(agent)}
        />
      </Group>
    );
  }
  return <HeartbeatOn agent={agent} hb={hb} />;
}

function HeartbeatOn({ agent, hb }: { agent: Agent; hb: AgentHeartbeat }) {
  const c = useColors();
  const now = useNow(30_000);
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: qk.heartbeat(agent.id),
    queryFn: () => api.agents.heartbeat(agent.id),
    refetchInterval: 60_000,
    retry: (count, err) => !refused(err) && count < 2,
  });
  const next = q.data?.nextAt ?? null;
  // Refetch right after the next beat.
  useEffect(() => {
    if (!next) return;
    const wait = Date.parse(next) - Date.now() + 5_000;
    if (wait <= 0 || wait > 2_147_483_647) return;
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: qk.heartbeat(agent.id) }), wait);
    return () => clearTimeout(timer);
  }, [next, agent.id]);

  const beat = useMutation({
    mutationFn: () => api.agents.beat(agent.id),
    onSuccess: (b) => {
      queryClient.setQueryData<AgentHeartbeatState>(qk.heartbeat(agent.id), (old) => (old ? { ...old, beats: [b, ...old.beats.filter((x) => x.id !== b.id)] } : old));
      void queryClient.invalidateQueries({ queryKey: qk.heartbeat(agent.id) });
      void queryClient.invalidateQueries({ queryKey: qk.runs });
      if (b.outcome === "failed") Alert.alert("The beat couldn't start", b.summary);
      else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (err) => Alert.alert(`Couldn't wake ${agent.name}`, errorText(err)),
  });

  if (q.isError && refused(q.error)) {
    return (
      <Group title="Heartbeat">
        <LinkRow icon="pulse" title="On" detail={statusLine(agent, hb, undefined, now)} onPress={() => openSettings(agent)} />
      </Group>
    );
  }

  const live = agent.enabled;
  const items = groupBeats(q.data?.beats ?? []);
  const shown = showAll ? items : items.slice(0, BEATS_PREVIEW);
  const older = items.length - BEATS_PREVIEW;

  return (
    <View>
      <SectionTitle title="Heartbeat" />
      <Card style={{ overflow: "hidden" }}>
        <View style={styles.head}>
          <View style={styles.headRow}>
            <View style={[styles.tile, live ? { backgroundColor: c.brandSoft, borderColor: alpha(c.brand, 0.25) } : { backgroundColor: c.sunken, borderColor: c.border }]}>
              <Icon name="pulse" size={17} color={live ? c.brandStrong : c.textMuted} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              {q.isError ? (
                <T variant="footnote" color={c.danger}>
                  {`Couldn't load the heartbeat: ${errorText(q.error)}`}
                </T>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <View style={[styles.dot, { backgroundColor: live ? c.brand : alpha(c.textMuted, 0.4) }]} />
                  <T variant="subhead" muted={!live} style={{ flex: 1, fontWeight: live ? "500" : "400" }}>
                    {statusLine(agent, hb, q.data, now)}
                  </T>
                </View>
              )}
              <T variant="footnote" muted>
                Wakes {agent.name} on its own rhythm to move its tickets forward and run its checklist — and leaves a trail.
              </T>
            </View>
          </View>
          {q.isError ? <Button title="Try again" icon="refresh" variant="outline" onPress={() => void q.refetch()} /> : null}
          <Button title="Wake now" icon="bolt" variant="secondary" disabled={!agent.enabled} loading={beat.isPending} onPress={() => beat.mutate()} />
          {!agent.enabled ? (
            <T variant="caption" muted style={{ textAlign: "center" }}>
              Switch {agent.name} on first
            </T>
          ) : null}
        </View>

        <Hairline />
        <T variant="eyebrow" muted style={styles.eyebrow}>
          Recent beats
        </T>
        {q.isLoading ? (
          <SkeletonRows count={2} avatar={0} />
        ) : !items.length ? (
          <T variant="footnote" muted style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, paddingTop: space.xs }}>
            {q.data?.nextAt && agent.enabled ? `No beats yet — the first one comes ${upcomingWhen(q.data.nextAt)}.` : "No beats yet."}
          </T>
        ) : (
          <View style={{ paddingBottom: older > 0 ? 0 : space.xs }}>
            {shown.map((item, i) => (
              <View key={item.kind === "quiet" ? item.beats[0]!.id : item.beat.id}>
                {i > 0 && <Hairline inset={space.lg + 10 + space.md} />}
                {item.kind === "quiet" ? <QuietRow beats={item.beats} /> : <BeatRow beat={item.beat} />}
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
                  {showAll ? "Show fewer" : `Show ${older} older`}
                </T>
              </Pressable>
            ) : null}
          </View>
        )}
      </Card>
    </View>
  );
}

/** "Beats every hour · 08:00–18:00 · weekdays · next at 10:30". */
function statusLine(agent: Agent, hb: AgentHeartbeat, state: AgentHeartbeatState | undefined, now: number): string {
  const parts = [`Beats ${heartbeatIntervalText(hb.intervalMinutes)}`];
  if (hb.hours) parts.push(`${hourLabel(hb.hours.from)}–${hourLabel(hb.hours.to)}`);
  if (hb.weekdays) parts.push("weekdays");
  if (!agent.enabled) parts.push(`waits while ${agent.name} is switched off`);
  else if (state?.nextAt) parts.push(nextLabel(state.nextAt, now));
  else if (state) parts.push("no hour to wake in");
  return parts.join(" · ");
}

function nextLabel(iso: string, now: number): string {
  const d = new Date(iso);
  if (d.getTime() <= now) return "due now";
  return isToday(d) ? `next at ${format(d, "HH:mm")}` : `next ${upcomingWhen(iso, now)}`;
}

function hourLabel(hour: number): string {
  return `${String(hour % 24).padStart(2, "0")}:00`;
}

/** "10:30" today, "Yesterday, 10:30", "Mon, Oct 5, 10:30". */
function beatTime(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return `Yesterday, ${format(d, "HH:mm")}`;
  return format(d, isThisYear(d) ? "EEE, MMM d, HH:mm" : "MMM d, yyyy, HH:mm");
}

const OUTCOME: Record<HeartbeatOutcome, { label: string; dot: (c: Colors) => string }> = {
  woke: { label: "Woke", dot: (c) => c.brand },
  quiet: { label: "Quiet", dot: (c) => alpha(c.textMuted, 0.4) },
  skipped: { label: "Skipped", dot: (c) => c.warning },
  failed: { label: "Failed", dot: (c) => c.danger },
};

const RUN_STATE: Record<string, string> = {
  queued: "Waiting to start",
  running: "Working through it…",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Stopped",
};

type BeatItem = { kind: "beat"; beat: HeartbeatBeat } | { kind: "quiet"; beats: HeartbeatBeat[] };

/** Runs of consecutive quiet beats fold into one row. */
function groupBeats(beats: HeartbeatBeat[]): BeatItem[] {
  const out: BeatItem[] = [];
  for (const b of beats) {
    const last = out[out.length - 1];
    if (b.outcome === "quiet" && last?.kind === "quiet") last.beats.push(b);
    else out.push(b.outcome === "quiet" ? { kind: "quiet", beats: [b] } : { kind: "beat", beat: b });
  }
  return out.map((item) => (item.kind === "quiet" && item.beats.length === 1 ? { kind: "beat", beat: item.beats[0]! } : item));
}

/** Markdown flattened to one readable line for the preview. */
function plainText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function BeatRow({ beat: b }: { beat: HeartbeatBeat }) {
  const c = useColors();
  const meta = OUTCOME[b.outcome] ?? OUTCOME.quiet;
  const runState = b.runStatus && b.runStatus !== "succeeded" ? RUN_STATE[b.runStatus] : undefined;
  const checklist = b.runId
    ? ["Checklist", runState].filter(Boolean).join(" · ")
    : null;
  const chat = b.conversationId;
  return (
    <Pressable
      disabled={!chat}
      accessibilityRole={chat ? "button" : undefined}
      onPress={() => chat && openChat(chat)}
      style={({ pressed }) => [styles.beat, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.beatDot, { backgroundColor: meta.dot(c) }]} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <T variant="subhead" style={{ fontWeight: "500", fontVariant: ["tabular-nums"] }}>
            {beatTime(b.createdAt)}
          </T>
          <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={1}>
            {meta.label}
            {b.reason === "now" ? " · Wake now" : ""}
          </T>
        </View>
        {b.summary ? (
          <T variant="footnote" muted={b.outcome === "quiet"} numberOfLines={3}>
            {b.summary}
          </T>
        ) : null}
        {b.changes > 0 ? (
          <T variant="caption" muted>
            {plural(b.changes, "change")} since the beat before
          </T>
        ) : null}
        {checklist ? (
          <View style={[styles.checklist, { backgroundColor: c.sunken }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="list" size={12} color={c.textMuted} />
              <T variant="caption" color={b.runStatus === "failed" ? c.danger : c.textMuted} style={{ flex: 1, fontWeight: "500" }} numberOfLines={1}>
                {checklist}
              </T>
            </View>
            {b.result ? (
              <T variant="footnote" muted numberOfLines={2}>
                {plainText(b.result)}
              </T>
            ) : null}
          </View>
        ) : null}
      </View>
      {chat ? <Icon name="chevron" size={11} color={c.textFaint} style={{ alignSelf: "center" }} /> : null}
    </Pressable>
  );
}

function QuietRow({ beats }: { beats: HeartbeatBeat[] }) {
  const c = useColors();
  const newest = new Date(beats[0]!.createdAt);
  const oldest = beats[beats.length - 1]!.createdAt;
  const sameDay = newest.toDateString() === new Date(oldest).toDateString();
  return (
    <View style={styles.beat}>
      <View style={[styles.beatDot, { backgroundColor: OUTCOME.quiet.dot(c) }]} />
      <T variant="footnote" muted style={{ flex: 1 }}>
        <T variant="footnote" style={{ fontWeight: "500" }}>
          Quiet
        </T>
        {` · ${beats.length} beats · ${beatTime(oldest)}–${sameDay ? format(newest, "HH:mm") : beatTime(beats[0]!.createdAt)}`}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    padding: space.lg,
    gap: space.md,
  },
  headRow: {
    flexDirection: "row",
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
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  eyebrow: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 2,
  },
  beat: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  beatDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 5,
  },
  checklist: {
    marginTop: 4,
    gap: 2,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
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
