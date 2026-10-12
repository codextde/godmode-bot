import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, Run, RunStatus, RunTrigger } from "@godmode/shared";
import { formatUsd } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { openChat } from "./rows";
import { Badge, Row, T } from "./ui";
import { activityText, shortTime } from "@/lib/format";
import { useRunActivity } from "@/lib/live";
import { radius, space, useColors } from "@/lib/theme";

type Tone = "neutral" | "brand" | "warning" | "danger";

const STATUS_META: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "brand" },
  paused: { label: "Paused", tone: "neutral" },
  succeeded: { label: "Done", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
};

/** What started a run, in the desktop's words. */
export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  chat: "Chat",
  routine: "Automation",
  check: "Condition check",
  dream: "Dream",
  delegation: "Handed over",
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
function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function RunStatusBadge({ run }: { run: Run }) {
  // A paused run that waits for the human says so.
  const question = run.status === "paused" && run.pause?.reason === "question" ? (run.pause.question?.kind ?? "question") : null;
  if (question) return <Badge label={question === "approval" ? "Needs your OK" : "Needs your answer"} tone="warning" />;
  const meta = STATUS_META[run.status] ?? STATUS_META.queued;
  return <Badge label={meta.label} tone={meta.tone} live={run.status === "running"} />;
}

/** One run in a list: what was asked, how it went, who did it, what started it and what it took. Tapping it opens its chat. */
export const RunRow = memo(function RunRow({ run, agent }: { run: Run; agent?: Agent }) {
  const c = useColors();
  const live = isLiveRun(run);
  // Only a row that is working listens for what its agent does right now.
  const activity = useRunActivity(live ? run.id : undefined);
  const finished = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
  const meta = [
    agent?.name ?? "Agent",
    TRIGGER_LABEL[run.trigger] ?? "Manual",
    shortTime(run.createdAt),
    finished && run.durationMs != null ? duration(run.durationMs) : null,
    run.costUsd ? formatUsd(run.costUsd) : null,
  ].filter(Boolean);
  const error = run.status === "failed" ? firstLine(run.error, 200) : "";

  return (
    <Pressable onPress={() => openChat(run.conversationId)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      <CharacterAvatar agent={agent} size={40} running={run.status === "running"} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>
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
          <T variant="footnote" color={c.brandStrong} numberOfLines={1} style={{ fontWeight: "500" }}>
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
