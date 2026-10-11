import { useQuery } from "@tanstack/react-query";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { fileNameSummary, taskEventText, type Agent, type Task, type TaskEvent, type TaskEventKind } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { Markdown } from "./markdown";
import { Skeleton, T, tap } from "./ui";
import { ApiError, api } from "@/lib/api";
import { shortTime, whenText } from "@/lib/format";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type Tone = "neutral" | "brand" | "warning" | "danger";

const ICONS: Record<TaskEventKind, IconName> = {
  status: "tasks",
  assigned: "person",
  archived: "archive",
  started: "play",
  waiting: "clock",
  delivered: "check",
  blocked: "warning",
  feedback: "chats",
  note: "pencil",
  pr_opened: "branch",
  pr_merged: "branch",
  pr_closed: "close",
  asked: "bell",
  answered: "chats",
};

const TONES: Partial<Record<TaskEventKind, Tone>> = { delivered: "brand", pr_merged: "brand", blocked: "danger", asked: "warning" };

/** Kinds whose text is shown under the line; a move or a start only when it carries one. */
const BODIED: readonly TaskEventKind[] = ["feedback", "note", "asked", "answered", "blocked", "waiting", "status", "started"];

const SHOWN = 30;
const CLIP = 132;
const SKELETON = ["72%", "56%", "64%"] as const;

/**
 * What happened on a ticket, oldest first: who filed it, moves, starts, deliveries, blocks with their reason, the
 * human's feedback, notes agents left, pull requests, questions and answers. The latest 30, earlier ones on request.
 */
export const TaskTimeline = memo(function TaskTimeline({ task, agents }: { task: Task; agents: Agent[] | undefined }) {
  const events = useQuery({ queryKey: qk.taskEvents(task.id), queryFn: () => api.tasks.events(task.id) });
  const [all, setAll] = useState(false);
  // A computer on an older Godmode keeps no timeline: who filed it is all there is to show.
  const none = events.error instanceof ApiError && (events.error.status === 404 || events.error.code === "device_forbidden");
  const list = events.data;
  const hidden = all || !list ? 0 : Math.max(0, list.length - SHOWN);
  const shown = useMemo(() => (list && hidden ? list.slice(hidden) : (list ?? [])), [list, hidden]);
  const filer =
    task.createdBy === "user"
      ? "You"
      : task.createdBy === "system"
        ? "Godmode"
        : (agents?.find((a) => `agent:${a.id}` === task.createdBy)?.name ?? "An agent that no longer exists");

  if (!list && !none) {
    if (events.isError) {
      return (
        <View style={styles.failed}>
          <T variant="footnote" muted style={{ flexShrink: 1 }}>
            {"Couldn't load the activity."}
          </T>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try loading the activity again"
            hitSlop={10}
            onPress={() => {
              tap();
              void events.refetch();
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <T variant="footnote" style={{ fontWeight: "600" }}>
              Try again
            </T>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Loading the activity">
        {SKELETON.map((width) => (
          <Skeleton key={width} width={width} height={14} />
        ))}
      </View>
    );
  }

  return (
    <View accessibilityRole="list" style={{ paddingHorizontal: 4 }}>
      <Line icon="plus" text={`${filer} filed it`} at={task.createdAt} last={!shown.length && !hidden} />
      {hidden > 0 && (
        <Line icon="more">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${hidden} earlier ${hidden === 1 ? "event" : "events"}`}
            hitSlop={10}
            onPress={() => {
              tap();
              setAll(true);
            }}
            style={({ pressed }) => [styles.earlier, { opacity: pressed ? 0.6 : 1 }]}
          >
            <T variant="subhead" muted style={{ fontWeight: "600" }}>
              Show earlier ({hidden})
            </T>
          </Pressable>
        </Line>
      )}
      {shown.map((e, i) => (
        <EventRow key={e.id} event={e} current={e.kind === "delivered" && sameResult(e.body, task.summary)} last={i === shown.length - 1} />
      ))}
    </View>
  );
});

/** `current`: a delivery whose result is the one the ticket shows above. */
const EventRow = memo(function EventRow({ event: e, current, last }: { event: TaskEvent; current: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const text = taskEventText(e, { you: "You", youObject: "you", when: whenText });
  const tone = TONES[e.kind];

  if (e.kind === "delivered") {
    const meta = [
      e.data.durationMs ? `${Math.max(1, Math.round(e.data.durationMs / 60_000))}m` : null,
      e.data.costUsd ? `$${e.data.costUsd.toFixed(2)}` : null,
      current ? "the result above" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <Line icon={ICONS[e.kind]} tone={tone} text={text} strong at={e.createdAt} last={last}>
        {meta ? (
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {meta}
          </T>
        ) : null}
        {!current && e.body ? <Toggle open={open} onPress={() => setOpen((v) => !v)} more="Show this result" less="Hide this result" /> : null}
        {!current && e.body && open ? <Body text={e.body} whole /> : null}
      </Line>
    );
  }

  return (
    <Line icon={ICONS[e.kind] ?? "tasks"} tone={tone} text={text} strong={e.kind === "feedback" || e.kind === "asked"} at={e.createdAt} last={last}>
      {e.body && BODIED.includes(e.kind) ? (
        <Body text={e.body} note={e.kind === "feedback" && e.data.files.length > 0 ? `Files: ${fileNameSummary(e.data.files)}` : undefined} />
      ) : null}
    </Line>
  );
});

/** One step on the rail: its dot, what happened and when, and what belongs under it. */
function Line({ icon, tone = "neutral", text, strong, at, last, children }: { icon: IconName; tone?: Tone; text?: string; strong?: boolean; at?: string; last?: boolean; children?: ReactNode }) {
  const c = useColors();
  const tones = {
    neutral: { bg: c.sunken, fg: c.textMuted },
    brand: { bg: c.brandSoft, fg: c.brandStrong },
    warning: { bg: c.warningSoft, fg: c.warning },
    danger: { bg: c.dangerSoft, fg: c.danger },
  }[tone];
  return (
    <View style={styles.line}>
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: tones.bg }]}>
          <Icon name={icon} size={11} color={tones.fg} weight="semibold" />
        </View>
        {!last && <View style={[styles.thread, { backgroundColor: c.borderStrong }]} />}
      </View>
      <View style={[styles.step, !last && { paddingBottom: space.lg }]}>
        {text ? (
          <View style={styles.head}>
            <T variant="subhead" style={[{ flex: 1 }, strong && { fontWeight: "600" }]}>
              {text}
            </T>
            <T variant="caption" muted style={styles.time}>
              {shortTime(at)}
            </T>
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );
}

/** An event's text in a quiet box; a long one is cut until it's asked for (`whole`: never cut). */
function Body({ text, note, whole }: { text: string; note?: string; whole?: boolean }) {
  const c = useColors();
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.box, { backgroundColor: c.sunken }]}>
      <View style={!whole && !open && styles.clipped}>
        <View onLayout={whole ? undefined : (e) => setTall(e.nativeEvent.layout.height > CLIP + 1)}>
          <Markdown text={text} />
        </View>
      </View>
      {note ? (
        <T variant="caption" muted>
          {note}
        </T>
      ) : null}
      {tall ? <Toggle open={open} onPress={() => setOpen((v) => !v)} more="Show more" less="Show less" /> : null}
    </View>
  );
}

function Toggle({ open, onPress, more, less }: { open: boolean; onPress: () => void; more: string; less: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      hitSlop={10}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
    >
      <T variant="footnote" muted style={{ fontWeight: "600" }}>
        {open ? less : more}
      </T>
      <Icon name={open ? "up" : "down"} size={10} color={c.textMuted} weight="semibold" />
    </Pressable>
  );
}

/** The board's copy of a result is cut short and ends in "…". */
function sameResult(body: string, summary: string | null): boolean {
  if (!summary) return false;
  return body === summary || (summary.endsWith("…") && body.startsWith(summary.slice(0, -1)));
}

const styles = StyleSheet.create({
  loading: {
    gap: space.md,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  failed: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: 4,
  },
  line: {
    flexDirection: "row",
    gap: space.md,
  },
  rail: {
    width: 22,
    alignItems: "center",
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  thread: {
    flex: 1,
    width: 1.5,
    marginVertical: 3,
    borderRadius: 1,
  },
  step: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    minHeight: 22,
    paddingTop: 1.5,
  },
  time: {
    lineHeight: 19,
    fontVariant: ["tabular-nums"],
  },
  earlier: {
    minHeight: 22,
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  box: {
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  clipped: {
    maxHeight: CLIP,
    overflow: "hidden",
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
  },
});
