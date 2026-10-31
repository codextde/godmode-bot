import { useMutation, useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict, isSameDay } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import { findModel, type Agent, type Run, type RunStatus, type RunTrigger } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Icon, type IconName } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { openChat } from "@/components/rows";
import { CopyButton, RunLog } from "@/components/run-log";
import { formatDuration, formatElapsed, formatTokens, openRun, RunStatusBadge, TRIGGER_LABEL } from "@/components/run-row";
import { Badge, Button, Card, EmptyState, ErrorState, Hairline, LiveDot, LoadingState, Row, Skeleton, T, tap } from "@/components/ui";
import { ApiError, api, errorText } from "@/lib/api";
import { useModelCatalog } from "@/lib/composer";
import { activityText } from "@/lib/format";
import { useAgents, useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { fonts, radius, space, useColors } from "@/lib/theme";

const TRIGGER_ICON: Record<RunTrigger, IconName> = {
  chat: "chats",
  routine: "workflow",
  check: "gauge",
  dream: "moon",
  delegation: "subagent",
  manual: "hand",
  api: "link",
  task: "tasks",
  followup: "clock",
  heartbeat: "pulse",
  call: "call",
};

const PROMPT_FOLD = 600;

/** A run the lists already have, so the screen opens at once while the fresh copy loads. */
function listedRun(id: string): Run | undefined {
  for (const [, data] of queryClient.getQueriesData<Run[]>({ queryKey: qk.runs })) {
    const hit = Array.isArray(data) ? data.find((r) => r.id === id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

const unfinished = (status: RunStatus | undefined) => status === "running" || status === "queued";

/** Everything about one run, like the desktop's run sheet: who, what started it, what it took, its result and its log. */
export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const seed = useMemo(() => listedRun(id) ?? useLive.getState().runs[id]?.run, [id]);
  const liveStatus = useLive((s) => s.runs[id]?.run.status);
  const run = useQuery({
    queryKey: qk.run(id),
    queryFn: () => api.runs.get(id),
    placeholderData: seed,
    refetchInterval: (q) => (unfinished(liveStatus ?? q.state.data?.status) ? 5000 : false),
  });

  if (!run.data) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>Run</Stack.Title>
        {run.error instanceof ApiError && run.error.code === "device_forbidden" ? (
          <EmptyState icon="pulse" title="Runs aren't available yet" body="Update Godmode on your computer to see runs here." />
        ) : run.isError ? (
          <ErrorState title="Couldn't open this run" error={errorText(run.error)} onRetry={() => void run.refetch()} />
        ) : (
          <LoadingState label="Loading the run…" />
        )}
      </View>
    );
  }
  return <RunDetail run={run.data} />;
}

function RunDetail({ run }: { run: Run }) {
  const c = useColors();
  const { byId } = useAgents();
  const agent = byId.get(run.agentId);
  const live = useLive((s) => s.runs[run.id]);
  const status = live?.run.status ?? run.status;
  const running = status === "running";
  const cancellable = running || status === "queued" || status === "paused";
  const catalog = useModelCatalog();
  const modelLabel = run.model ? (findModel(catalog.data?.models ?? [], run.model)?.label ?? run.model) : "Default";
  // A paused run may wait for the human's answer: that, not Continue, is the way on.
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open, enabled: status === "paused" });
  const asked = status === "paused" ? questions.data?.find((q) => q.runId === run.id) : undefined;
  const [logOpen, setLogOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const when = run.startedAt ?? run.createdAt;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.runs });
  const cancel = useMutation({
    mutationFn: () => api.runs.cancel(run.id),
    onSuccess: refresh,
    onError: (err) => Alert.alert("Couldn't cancel the run", errorText(err)),
  });
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(run.conversationId),
    onSuccess: refresh,
    onError: (err) => Alert.alert("Couldn't continue", errorText(err)),
  });

  const confirmCancel = () =>
    Alert.alert("Cancel this run?", `${agent?.name ?? "The agent"} stops where it is.`, [
      { text: "Keep running", style: "cancel" },
      { text: "Cancel run", style: "destructive", onPress: () => cancel.mutate() },
    ]);
  const answer = () => {
    if (!asked) return;
    if (asked.taskId) router.push({ pathname: "/task/[id]", params: { id: asked.taskId } });
    else openChat(run.conversationId);
  };

  const tokensIn = run.usage ? run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens : null;
  const finished = run.finishedAt && !cancellable ? new Date(run.finishedAt) : null;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>Run</Stack.Title>

      <Card style={styles.hero} onPress={agent ? () => router.push({ pathname: "/agent/[id]", params: { id: agent.id } }) : undefined}>
        <CharacterAvatar agent={agent} size={48} running={running} />
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <T variant="headline" numberOfLines={1}>
            {agent?.name ?? "Run"}
          </T>
          <Row style={{ gap: 6, flexWrap: "wrap" }}>
            <RunStatusBadge run={run} status={status} waitingFor={asked ? (asked.kind === "approval" ? "approval" : "answer") : null} />
            <Badge label={TRIGGER_LABEL[run.trigger] ?? "Manual"} icon={<Icon name={TRIGGER_ICON[run.trigger] ?? "hand"} size={10} color={c.textMuted} />} />
            <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
              {formatDistanceToNowStrict(new Date(when), { addSuffix: true })}
            </T>
          </Row>
        </View>
        {agent ? <Icon name="chevron" size={13} color={c.textFaint} /> : null}
      </Card>

      {agent?.failedRunId === run.id ? <FailureNotice agent={agent} /> : null}

      {running ? <Working since={run.startedAt} activity={live?.activity ?? null} /> : null}

      <View style={{ gap: space.sm }}>
        {status === "paused" ? (
          asked ? (
            <Button title={`Answer in ${asked.taskId ? "the task" : "chat"}`} icon="reply" onPress={answer} />
          ) : (
            <Button title="Continue" icon="play" loading={resume.isPending} onPress={() => resume.mutate()} />
          )
        ) : null}
        <Button title="Open chat" icon="chats" variant="secondary" onPress={() => openChat(run.conversationId)} />
        {cancellable ? <Button title="Cancel run" icon="stop" variant="danger" loading={cancel.isPending} onPress={confirmCancel} /> : null}
      </View>

      <Card style={styles.facts}>
        <Fact label="Duration" value={running && run.startedAt ? <Elapsed since={run.startedAt} /> : formatDuration(run.durationMs)} />
        <Fact label="Turns" value={run.numTurns != null ? String(run.numTurns) : "—"} />
        <Fact label="Model" value={modelLabel} />
        <Fact
          label="Tokens in / out"
          value={run.usage ? `${formatTokens(tokensIn)} / ${formatTokens(run.usage.outputTokens)}` : "—"}
          detail={run.usage ? `${formatTokens(run.usage.cacheReadTokens)} cache read · ${formatTokens(run.usage.cacheWriteTokens)} cache write` : undefined}
        />
        <Fact label="Started" value={run.startedAt ? format(new Date(run.startedAt), "MMM d, HH:mm") : "—"} last={!finished} />
        {finished ? <Fact label="Ended" value={format(finished, run.startedAt && isSameDay(finished, new Date(run.startedAt)) ? "HH:mm" : "MMM d, HH:mm")} last /> : null}
      </Card>

      {run.parentRunId || run.routineId ? (
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          {run.parentRunId ? <HandedOverBy parentRunId={run.parentRunId} /> : null}
          {run.routineId ? (
            <Chip
              icon="workflow"
              onPress={() => {
                tap();
                router.push("/automations");
              }}
            >
              <T variant="footnote" muted>
                Started by an automation
              </T>
            </Chip>
          ) : null}
        </Row>
      ) : null}

      <Section title="Prompt" action={run.prompt ? <CopyButton text={run.prompt} label="Copy prompt" /> : undefined}>
        <Card style={styles.block}>
          {run.prompt ? (
            <>
              <T variant="subhead" selectable numberOfLines={promptOpen || run.prompt.length <= PROMPT_FOLD ? undefined : 8}>
                {run.prompt}
              </T>
              {run.prompt.length > PROMPT_FOLD ? (
                <Pressable hitSlop={8} onPress={() => setPromptOpen((o) => !o)} style={{ alignSelf: "flex-start" }}>
                  <T variant="footnote" style={{ fontWeight: "600" }}>
                    {promptOpen ? "Show less" : "Show all"}
                  </T>
                </Pressable>
              ) : null}
            </>
          ) : (
            <T variant="subhead" muted>
              (empty)
            </T>
          )}
        </Card>
      </Section>

      {run.error ? (
        <View style={[styles.error, { backgroundColor: c.dangerSoft }]}>
          <Row style={{ gap: 6 }}>
            <Icon name="warning" size={14} color={c.danger} />
            <T variant="subhead" color={c.danger} style={{ fontWeight: "500" }}>
              Error
            </T>
          </Row>
          <T variant="caption" selectable color={c.danger} style={styles.mono}>
            {run.error}
          </T>
        </View>
      ) : null}

      {run.result ? (
        <Section title="Result" done={status === "succeeded"} action={<CopyButton text={run.result} label="Copy result" />}>
          <Card style={styles.block}>
            <Markdown text={run.result} />
          </Card>
        </Section>
      ) : !running && !run.error ? (
        <View style={[styles.dashed, { borderColor: c.borderStrong }]}>
          <T variant="footnote" muted style={{ textAlign: "center" }}>
            {"This run didn't produce a final answer."}
          </T>
        </View>
      ) : null}

      <Card style={{ overflow: "hidden" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: logOpen }}
          onPress={() => {
            tap();
            setLogOpen((o) => !o);
          }}
          style={({ pressed }) => [styles.logHead, pressed && { backgroundColor: c.sunken }]}
        >
          <Icon name="doc" size={16} color={c.textMuted} />
          <T variant="callout" style={{ fontWeight: "500" }}>
            Raw log
          </T>
          <T variant="caption" muted style={{ flex: 1 }} numberOfLines={1}>
            stream-json events
          </T>
          <Icon name={logOpen ? "down" : "chevron"} size={12} color={c.textMuted} weight="semibold" />
        </Pressable>
        {logOpen ? (
          <View style={[styles.logBody, { borderTopColor: c.border }]}>
            <RunLog runId={run.id} live={running} />
          </View>
        ) : null}
      </Card>

      <Row style={{ gap: 4, paddingHorizontal: 4 }}>
        <T variant="caption" color={c.textFaint} selectable style={styles.mono}>
          {run.id}
        </T>
        <CopyButton text={run.id} label="Copy run ID" />
      </Row>
    </ScrollView>
  );
}

/** What the agent does right now and for how long. */
function Working({ since, activity }: { since: string | null; activity: string | null }) {
  const c = useColors();
  return (
    <Card style={[styles.working, { borderColor: c.brandSoft }]}>
      <LiveDot size={8} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="subhead" numberOfLines={1} style={{ fontWeight: "500" }}>
          {activityText(activity)}
        </T>
        {since ? (
          <Elapsed since={since} suffix=" elapsed" variant="caption" muted style={styles.mono} />
        ) : (
          <T variant="caption" muted>
            Starting…
          </T>
        )}
      </View>
    </Card>
  );
}

/** The live timer, ticking on its own so the rest of the screen doesn't re-render every second. */
function Elapsed({
  since,
  suffix = "",
  variant = "subhead",
  muted,
  style,
}: {
  since: string;
  suffix?: string;
  variant?: "subhead" | "caption";
  muted?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const now = useNow(1000);
  return (
    <T variant={variant} muted={muted} numberOfLines={1} style={[{ fontVariant: ["tabular-nums"] }, style]}>
      {`${formatElapsed(now - new Date(since).getTime())}${suffix}`}
    </T>
  );
}

function Fact({ label, value, detail, last }: { label: string; value: string | ReactElement; detail?: string; last?: boolean }) {
  return (
    <>
      <Row style={styles.fact}>
        <T variant="subhead" muted>
          {label}
        </T>
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-end" }}>
          {typeof value === "string" ? (
            <T variant="subhead" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
              {value}
            </T>
          ) : (
            value
          )}
          {detail ? (
            <T variant="caption" muted numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
              {detail}
            </T>
          ) : null}
        </View>
      </Row>
      {last ? null : <Hairline inset={space.lg} />}
    </>
  );
}

function Section({ title, action, done, children }: { title: string; action?: ReactNode; done?: boolean; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ gap: 6, paddingHorizontal: 4, minHeight: 30 }}>
        {done ? <Icon name="check" size={11} color={c.success} weight="bold" /> : null}
        <T variant="eyebrow" muted style={{ flex: 1 }}>
          {title}
        </T>
        {action}
      </Row>
      {children}
    </View>
  );
}

function Chip({ icon, onPress, children }: { icon: IconName; onPress?: () => void; children: ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name={icon} size={12} color={c.textMuted} />
      {children}
      {onPress ? <Icon name="chevron" size={10} color={c.textFaint} /> : null}
    </Pressable>
  );
}

/** "Handed over by [face] Lena": opens the run that handed this one over. */
function HandedOverBy({ parentRunId }: { parentRunId: string }) {
  const c = useColors();
  const parent = useQuery({ queryKey: qk.run(parentRunId), queryFn: () => api.runs.get(parentRunId), retry: false });
  const { byId } = useAgents();
  const from = parent.data ? byId.get(parent.data.agentId) : undefined;
  if (parent.isLoading) return <Skeleton width={180} height={30} radius={radius.md} />;
  if (!parent.data) {
    return (
      <Chip icon="subagent">
        <T variant="footnote" muted>
          Handed over by an agent that no longer exists
        </T>
      </Chip>
    );
  }
  return (
    <Chip icon="subagent" onPress={() => openRun(parentRunId)}>
      <T variant="footnote" muted>
        Handed over by
      </T>
      {from ? (
        <>
          <CharacterAvatar agent={from} size={16} />
          <T variant="footnote" color={c.text} style={{ fontWeight: "500" }}>
            {from.name}
          </T>
        </>
      ) : (
        <T variant="footnote" muted>
          another agent
        </T>
      )}
    </Chip>
  );
}

/** This run is why the agent says "Last run failed": the human can let that go. */
function FailureNotice({ agent }: { agent: Agent }) {
  const c = useColors();
  const dismiss = useMutation({
    mutationFn: () => api.agents.dismissFailure(agent.id),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.agent(next.id), next);
      queryClient.setQueryData<Agent[]>(qk.agents, (list) => list?.map((a) => (a.id === next.id ? next : a)));
      void queryClient.invalidateQueries({ queryKey: qk.agents });
    },
    onError: (err) => Alert.alert("Couldn't dismiss it", errorText(err)),
  });
  return (
    <View style={[styles.notice, { backgroundColor: c.dangerSoft }]}>
      <Icon name="warning" size={15} color={c.danger} />
      <T variant="footnote" style={{ flex: 1 }}>
        {`This is why ${agent.name} shows “Last run failed”.`}
      </T>
      <Pressable
        accessibilityRole="button"
        disabled={dismiss.isPending}
        hitSlop={8}
        onPress={() => {
          tap();
          dismiss.mutate();
        }}
        style={({ pressed }) => ({ opacity: dismiss.isPending ? 0.5 : pressed ? 0.6 : 1 })}
      >
        <T variant="footnote" style={{ fontWeight: "600" }}>
          Dismiss
        </T>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 80,
    gap: space.lg,
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
  },
  working: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
  },
  facts: {
    paddingVertical: 2,
  },
  fact: {
    gap: space.md,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
  },
  block: {
    padding: space.lg,
    gap: space.sm,
  },
  error: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 17,
  },
  dashed: {
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderStyle: "dashed",
  },
  logHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.lg,
  },
  logBody: {
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
  },
});
