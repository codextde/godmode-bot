import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { AutomationEvent, AutomationEventSource, AutomationEventStatus, Routine, RoutineNotify } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Group, SwitchRow } from "@/components/form";
import { HeaderActions, type HeaderMenuItem } from "@/components/header-actions";
import { Icon, type IconName } from "@/components/icon";
import { appName, runLabel, runRoutine, setRoutineEnabled, triggerText, TRIGGER_TITLES } from "@/components/routine-row";
import { openChat } from "@/components/rows";
import { runStatusLabel } from "@/components/run-row";
import { Badge, Button, Card, EmptyState, ErrorState, Hairline, LoadingState, Row, SectionTitle, SkeletonRows, T, tap, type Tone } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { isFailingRoutine } from "@/lib/desktop-parity";
import { whenText } from "@/lib/format";
import { useAgents, useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const EVENT_LIMIT = 50;

const EVENT_SOURCES: Record<AutomationEventSource, { label: string; icon: IconName }> = {
  schedule: { label: "Schedule", icon: "clock" },
  app: { label: "App event", icon: "layers" },
  webhook: { label: "Webhook", icon: "link" },
  condition: { label: "Condition met", icon: "eye" },
  manual: { label: "Manual", icon: "hand" },
};

const EVENT_STATUS: Record<AutomationEventStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "warning" },
  running: { label: "Running", tone: "brand" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
};

const NOTIFY_LABELS: Record<RoutineNotify, string> = {
  failures: "When a run fails",
  always: "After every run",
  never: "Never",
};

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

/** One automation, like the desktop's row and events sheet together: what starts it, when, what it does, and what happened lately. */
export default function AutomationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const routine = list.data?.find((r) => r.id === id);

  if (!routine) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>Automation</Stack.Title>
        {list.isLoading ? (
          <LoadingState label="Loading the automation…" />
        ) : (
          <ErrorState
            title={list.isError ? "Couldn't load this automation" : "Automation not found"}
            error={list.isError ? errorText(list.error) : "It may have been deleted."}
            onRetry={list.isError ? () => void list.refetch() : undefined}
          />
        )}
      </View>
    );
  }
  return <AutomationView routine={routine} refetchList={list.refetch} />;
}

function AutomationView({ routine, refetchList }: { routine: Routine; refetchList: () => Promise<unknown> }) {
  const c = useColors();
  const id = routine.id;
  const { byId } = useAgents();
  const agent = byId.get(routine.agentId);
  const working = useLive((s) => Object.values(s.runs).some(({ run }) => run.routineId === id));
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useNow(30_000);
  const events = useQuery({
    queryKey: qk.routineEvents(id),
    queryFn: () => api.routines.events(id, EVENT_LIMIT),
    // Live-ish while something is still waiting or running.
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === "pending" || e.status === "running") ? 5000 : false),
  });

  const refetchEvents = events.refetch;
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) {
        void refetchList();
        void refetchEvents();
      }
      shown.current = true;
    }, [refetchList, refetchEvents]),
  );

  const t = routine.trigger;
  const status = routine.triggerStatus;
  const keepsChat = routine.reuseConversation && !!routine.conversationId;
  const editable = t.type === "schedule" || t.type === "condition";
  const edit = () => router.push({ pathname: "/automation-edit", params: { id } });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchList(), refetchEvents()]);
    } finally {
      setRefreshing(false);
    }
  };

  const run = () => {
    setStarting(true);
    void runRoutine(routine).finally(() => setStarting(false));
  };

  const remove = () =>
    Alert.alert(
      `Delete “${routine.name}”?`,
      `${t.type === "app" ? `Godmode stops listening for “${t.triggerName}” in ${appName(t.toolkit)}.` : t.type === "webhook" ? "Its webhook URL stops working." : "It won't run again."} Past runs and conversations stay in your history.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete automation",
          style: "destructive",
          onPress: () =>
            void api.routines
              .delete(id)
              .then(() => {
                router.back();
                void queryClient.invalidateQueries({ queryKey: qk.routines });
              })
              .catch((err) => Alert.alert("Couldn't delete automation", errorText(err))),
        },
      ],
    );

  const openEvent = (e: AutomationEvent) => {
    if (!e.runId) return;
    if (keepsChat) return openChat(routine.conversationId!);
    const runId = e.runId;
    queryClient
      .fetchQuery({ queryKey: qk.run(runId), queryFn: () => api.runs.get(runId) })
      .then((r) => openChat(r.conversationId))
      .catch((err) => Alert.alert("Couldn't open the chat", errorText(err)));
  };

  const menu: HeaderMenuItem[] = [
    ...(routine.conversationId ? [{ icon: "chats" as IconName, title: "Open chat", onPress: () => openChat(routine.conversationId!) }] : []),
    { icon: "trash", title: "Delete", destructive: true, onPress: remove },
  ];

  const next = routine.enabled && routine.nextRunAt ? `${whenText(routine.nextRunAt)} · ${ago(routine.nextRunAt)}` : routine.enabled ? "—" : "Paused";
  const last = routine.lastRunAt ? `${routine.lastStatus ? `${runStatusLabel(routine.lastStatus)} · ` : ""}${ago(routine.lastRunAt)}` : "Never";
  const lastCheck = t.type === "condition" && (status.observation || status.lastCheckAt);
  const shownEvents = events.data ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Stack.Title>{routine.name}</Stack.Title>
      <HeaderActions actions={[{ icon: "pencil", label: "Edit", onPress: edit }]} menu={menu} />

      <View style={styles.hero}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={agent ? `Open ${agent.name}` : undefined}
          disabled={!agent}
          onPress={() => {
            tap();
            router.push({ pathname: "/agent/[id]", params: { id: routine.agentId } });
          }}
        >
          <CharacterAvatar agent={agent} size={64} running={working} />
        </Pressable>
        <T variant="title" style={{ textAlign: "center" }}>
          {routine.name}
        </T>
        <Row style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          {working ? (
            <Badge label="Running now" tone="brand" live />
          ) : routine.enabled ? (
            <Badge label={isFailingRoutine(routine) ? "Failing" : "Active"} tone={isFailingRoutine(routine) ? "danger" : "success"} />
          ) : (
            <Badge label="Paused" />
          )}
          {routine.fillOnly ? <Badge label="Fill-only secrets" dot={false} /> : null}
        </Row>
        {agent ? (
          <T variant="subhead" muted style={{ textAlign: "center" }}>
            {agent.name}
          </T>
        ) : null}
        <Row style={{ gap: space.sm, alignSelf: "stretch", marginTop: space.sm }}>
          <Button
            title={runLabel(t.type)}
            icon="play"
            variant="secondary"
            loading={starting}
            disabled={!routine.enabled || working}
            onPress={run}
            style={{ flex: 1 }}
          />
          {keepsChat ? (
            <Button title="Open chat" icon="chats" onPress={() => openChat(routine.conversationId!)} style={{ flex: 1 }} />
          ) : (
            <Button title="Edit" icon="pencil" onPress={edit} style={{ flex: 1 }} />
          )}
        </Row>
      </View>

      {routine.enabled && (status.state === "error" || status.state === "pending") ? (
        <View style={[styles.notice, { backgroundColor: status.state === "error" ? c.dangerSoft : c.surface, borderColor: status.state === "error" ? c.danger : c.border }]}>
          <Icon name={status.state === "error" ? "warning" : "clock"} size={14} color={status.state === "error" ? c.danger : c.textMuted} />
          <T variant="footnote" color={status.state === "error" ? c.danger : c.textMuted} style={{ flex: 1 }}>
            {status.message ?? (status.state === "error" ? "The trigger isn't working." : "Setting up the trigger…")}
          </T>
        </View>
      ) : null}

      <Group title="Trigger" footer={editable ? undefined : "Change the trigger in Godmode on your computer."}>
        <Info label={TRIGGER_TITLES[t.type]} value={triggerText(routine)} />
        {t.type === "schedule" || t.type === "condition" ? <Info label={t.type === "condition" ? "Next check" : "Next run"} value={next} /> : null}
        <Info label="Last run" value={last} tone={routine.lastStatus === "failed" ? "danger" : undefined} />
        {routine.filter ? <Info label="Only when…" value={routine.filter} /> : null}
      </Group>

      {t.type === "condition" ? (
        <View>
          <SectionTitle title="Condition" />
          <Card style={styles.text}>
            <T variant="callout">When {t.condition}</T>
            {lastCheck ? (
              <View style={{ gap: 2, marginTop: space.sm }}>
                <T variant="eyebrow" muted>
                  Last check{status.lastCheckAt ? ` · ${ago(status.lastCheckAt)}` : ""}
                </T>
                <T variant="footnote" muted>
                  {status.observation ?? "Nothing noted yet."}
                </T>
              </View>
            ) : null}
          </Card>
        </View>
      ) : null}

      <View>
        <SectionTitle title="What it does" />
        <Card style={styles.text}>
          <T variant="callout">{routine.prompt}</T>
        </Card>
      </View>

      <Group title="Settings">
        <SwitchRow
          title="Enabled"
          detail={editable ? "Paused automations keep their settings but don't run." : "Paused automations keep their settings and ignore new events."}
          value={routine.enabled}
          onChange={(enabled) => setRoutineEnabled(routine, enabled)}
        />
        <Info label="Tell me" value={NOTIFY_LABELS[routine.notify]} />
        <Info label="Keep one chat" value={routine.reuseConversation ? "On" : "Off"} />
      </Group>

      <View>
        <SectionTitle title={shownEvents.length ? `Recent events · ${shownEvents.length}` : "Recent events"} />
        {events.isLoading ? (
          <Card>
            <SkeletonRows count={3} avatar={28} />
          </Card>
        ) : events.isError ? (
          <ErrorState title="Couldn't load events" error={errorText(events.error)} onRetry={() => void refetchEvents()} />
        ) : shownEvents.length === 0 ? (
          <EmptyEvents routine={routine} />
        ) : (
          <Card style={{ overflow: "hidden" }}>
            {shownEvents.map((e, i) => (
              <View key={e.id}>
                {i > 0 && <Hairline inset={space.lg + 28 + space.md} />}
                <EventRow event={e} onPress={e.runId ? () => openEvent(e) : undefined} />
              </View>
            ))}
          </Card>
        )}
        {shownEvents.length >= EVENT_LIMIT ? (
          <T variant="footnote" muted style={{ textAlign: "center", marginTop: space.sm }}>
            Showing the latest {EVENT_LIMIT} events.
          </T>
        ) : null}
      </View>

      <Button title="Delete automation" icon="trash" variant="danger" onPress={remove} />
    </ScrollView>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  const c = useColors();
  return (
    <View style={styles.info}>
      <T variant="footnote" muted>
        {label}
      </T>
      <T variant="callout" color={tone === "danger" ? c.danger : c.text}>
        {value}
      </T>
    </View>
  );
}

function EventRow({ event, onPress }: { event: AutomationEvent; onPress?: () => void }) {
  const c = useColors();
  const source = EVENT_SOURCES[event.source] ?? EVENT_SOURCES.manual;
  const status = EVENT_STATUS[event.status] ?? EVENT_STATUS.pending;
  return (
    <Pressable
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityHint={onPress ? "Opens the chat of this run" : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.event, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.eventIcon, { backgroundColor: c.sunken }]}>
        <Icon name={source.icon} size={13} color={c.textMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <T variant="subhead" style={{ fontWeight: "500" }} numberOfLines={2}>
          {event.title || source.label}
        </T>
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={status.label} tone={status.tone} live={event.status === "running"} />
          <T variant="caption" muted>
            {source.label} · {ago(event.createdAt)}
          </T>
        </Row>
        {event.note ? (
          <T variant="footnote" color={event.status === "failed" ? c.danger : c.textMuted}>
            {event.note}
          </T>
        ) : null}
      </View>
      {onPress ? <Icon name="chevron" size={11} color={c.textFaint} style={{ marginTop: 4 }} /> : null}
    </Pressable>
  );
}

function EmptyEvents({ routine }: { routine: Routine }) {
  const t = routine.trigger;
  const next = routine.enabled && routine.nextRunAt ? ago(routine.nextRunAt) : null;
  const copy =
    t.type === "schedule"
      ? { title: "No runs yet", body: next ? `The first run is ${next}.` : "Runs show up here when the schedule fires." }
      : t.type === "app"
        ? { title: "Waiting for the first event", body: `Godmode is listening for “${t.triggerName}” in ${appName(t.toolkit)}.` }
        : t.type === "condition"
          ? { title: "Not met yet", body: next ? `The next check is ${next}.` : "Once a check finds the condition true, it shows up here." }
          : { title: "No calls yet", body: "Call the webhook URL — or send a test event — and it shows up here." };
  return <EmptyState icon="inbox" title={copy.title} body={copy.body} style={{ marginHorizontal: 0 }} />;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  hero: {
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  info: {
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  text: {
    padding: space.lg,
  },
  event: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  eventIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
