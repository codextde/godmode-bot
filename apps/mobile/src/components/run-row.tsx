import { router } from "expo-router";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, Run, RunStatus, RunTrigger } from "@godmode/shared";
import { formatUsd } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Badge, Row, T, tap, type Tone } from "./ui";
import { activityText, shortTime } from "@/lib/format";
import { useRunActivity } from "@/lib/live";
import { useSpendTracking } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

/** The desktop's labels and tones (run-status.tsx). */
const STATUS_META: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "brand" },
  paused: { label: "Paused", tone: "warning" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function runStatusLabel(status: RunStatus): string {
  return STATUS_META[status]?.label ?? status;
}

/** What started a run, in the desktop's words. */
export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  chat: "Chat",
  routine: "Automation",
  check: "Condition check",
  dream: "Dream",
  delegation: "Delegation",
  manual: "Manual",
  api: "API",
  task: "Task",
  followup: "Follow-up",
  heartbeat: "Heartbeat",
  call: "Phone call",
};

/** A run still ahead of its end: working, or waiting for its turn. */
export function isLiveRun(run: Pick<Run, "status">): boolean {
  return run.status === "running" || run.status === "queued";
}

function firstLine(text: string | null | undefined, max = 120): string {
  const line = (text ?? "").split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "850ms", "12s", "3m 04s", "1h 12m" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Live timer format: 0:07, 1:23, 1:02:03 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** "850", "12.3k", "120k", "1.2M" */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The run's own screen: status, what it took, its result and its log. */
export function openRun(id: string) {
  tap();
  router.push({ pathname: "/run/[id]", params: { id } });
}

/**
 * `status`: the live one when it is fresher than the run's. A paused run that waits for the human says so (`waitingFor`,
 * else what a run list says about its pause).
 */
export function RunStatusBadge({ run, status = run.status, waitingFor }: { run: Run; status?: RunStatus; waitingFor?: "answer" | "approval" | null }) {
  const asked = waitingFor ?? (run.pause?.reason === "question" ? (run.pause.question?.kind === "approval" ? "approval" : "answer") : null);
  if (status === "paused" && asked) return <Badge label={asked === "approval" ? "Needs your OK" : "Needs your answer"} tone="warning" />;
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return <Badge label={meta.label} tone={meta.tone} live={status === "running"} />;
}

/** One run in a list: what was asked, how it went, who did it, what started it and what it took. Tapping it opens the run. */
export const RunRow = memo(function RunRow({ run, agent }: { run: Run; agent?: Agent }) {
  const c = useColors();
  const live = isLiveRun(run);
  // Only a row that is working listens for what its agent does right now.
  const activity = useRunActivity(live ? run.id : undefined);
  const spendTracking = useSpendTracking();
  const finished = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
  const meta = [
    agent?.name ?? "Agent",
    TRIGGER_LABEL[run.trigger] ?? "Manual",
    shortTime(run.createdAt),
    finished && run.durationMs != null ? formatDuration(run.durationMs) : null,
    spendTracking && run.costUsd ? formatUsd(run.costUsd) : null,
  ].filter(Boolean);
  const error = run.status === "failed" ? firstLine(run.error, 200) : "";

  return (
    <Pressable onPress={() => openRun(run.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      <CharacterAvatar agent={agent} size={40} running={run.status === "running"} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="callout" numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: "500", letterSpacing: -0.16 }}>
            {firstLine(run.prompt) || "No prompt"}
          </T>
          <RunStatusBadge run={run} />
        </Row>
        <T variant="footnote" muted numberOfLines={1}>
          {meta.join(" · ")}
        </T>
        {error ? (
          <T variant="footnote" color={c.danger} numberOfLines={1}>
            {error}
          </T>
        ) : live ? (
          <T variant="footnote" color={c.brandStrong} numberOfLines={1}>
            {run.status === "queued" ? "Waiting to start" : activityText(activity)}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
});
