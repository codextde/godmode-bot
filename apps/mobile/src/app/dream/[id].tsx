import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatBytes, type DreamDetail, type DreamFileChange, type DreamWorkspaceChange } from "@godmode/shared";
import { ACTIVE_DREAM, ChangeKindChip, DreamReasonBadge, DreamStatusBadge, ROLLED_BACK, dreamWhen, reviewedLabel } from "@/components/dream-parts";
import { Icon, type IconName } from "@/components/icon";
import { Badge, Card, ErrorState, Hairline, LoadingState, Row, SectionTitle, T, tap } from "@/components/ui";
import { api, ApiError, errorText, UPDATE_DESKTOP_MESSAGE } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { diffFile, foldContext, type DiffLine, type FileDiff } from "@/lib/line-diff";
import { qk } from "@/lib/query";
import { alpha, fonts, radius, space, useColors, type Colors } from "@/lib/theme";

/** Rows rendered per file before "Show everything" (a new or deleted note can be long). */
const MAX_ROWS = 400;

/** One dream, read-only like the desktop's review: what the agent says it did, and a line diff of every file it changed. */
export default function DreamScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({
    queryKey: qk.dream(id),
    queryFn: () => api.dreams.get(id),
    refetchInterval: (query) => (query.state.data && ACTIVE_DREAM.includes(query.state.data.status) ? 5_000 : false),
  });

  if (!q.data) {
    const tooOld = q.error instanceof ApiError && (q.error.code === "device_forbidden" || q.error.status === 403);
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>Dream</Stack.Title>
        {q.isError ? (
          <ErrorState title="Couldn't open this dream" error={tooOld ? UPDATE_DESKTOP_MESSAGE : errorText(q.error)} onRetry={tooOld ? undefined : () => void q.refetch()} />
        ) : (
          <LoadingState label="Loading the dream…" />
        )}
      </View>
    );
  }
  return <DreamView dream={q.data} />;
}

function DreamView({ dream: d }: { dream: DreamDetail }) {
  const c = useColors();
  const agentName = useAgents().byId.get(d.agentId)?.name ?? "The agent";
  const files = useMemo(() => d.fileChanges.map((f) => ({ file: f, diff: diffFile(f.before, f.after) })), [d.fileChanges]);
  const totals = files.reduce((t, f) => ({ added: t.added + f.diff.added, removed: t.removed + f.diff.removed }), { added: 0, removed: 0 });
  const rolledBack = ROLLED_BACK.includes(d.status);
  const note =
    d.status === "reverted"
      ? "This dream was undone — the files are back the way they were before it."
      : d.canRevert
        ? "Undo a dream in Godmode on your computer."
        : d.files.length && !ACTIVE_DREAM.includes(d.status)
          ? "The memory changed after this dream, so it can't be undone automatically."
          : null;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>Dream</Stack.Title>
      <View style={{ gap: space.sm, paddingTop: space.md }}>
        <Row style={{ gap: 6 }}>
          <Icon name="moon" size={13} color={c.dream} />
          <T variant="eyebrow" muted>
            Dream · {dreamWhen(d.createdAt)}
          </T>
        </Row>
        <T variant="title">What {agentName} changed</T>
        <T variant="subhead" muted>
          {d.summary || reviewedLabel(d)}
        </T>
        <Row style={{ gap: 6, flexWrap: "wrap", marginTop: 2 }}>
          <DreamStatusBadge status={d.status} />
          <DreamReasonBadge reason={d.reason} />
          {files.length ? (
            <T variant="caption" style={{ fontFamily: fonts.mono, marginLeft: 2 }}>
              <T variant="caption" color={c.success} style={{ fontFamily: fonts.mono }}>{`+${totals.added}`}</T>{" "}
              <T variant="caption" color={c.danger} style={{ fontFamily: fonts.mono }}>{`−${totals.removed}`}</T>
            </T>
          ) : null}
        </Row>
        {d.summary ? (
          <T variant="footnote" muted>
            {reviewedLabel(d)}
          </T>
        ) : null}
        {note ? (
          <Row style={{ gap: 6, marginTop: 2 }}>
            <Icon name={d.status === "reverted" ? "unarchive" : "display"} size={12} color={c.textMuted} />
            <T variant="footnote" muted style={{ flex: 1 }}>
              {note}
            </T>
          </Row>
        ) : null}
      </View>

      {d.status !== "succeeded" && d.error ? (
        <View style={[styles.callout, d.status === "failed" ? { backgroundColor: c.dangerSoft, borderColor: alpha(c.danger, 0.2) } : { backgroundColor: c.sunken, borderColor: c.border }]}>
          <Icon name={d.status === "failed" ? "warning" : d.status === "paused" ? "pause" : "dot"} size={13} color={d.status === "failed" ? c.danger : c.textMuted} style={{ marginTop: 2 }} />
          <T variant="footnote" color={d.status === "failed" ? c.danger : c.textMuted} style={{ flex: 1 }}>
            {d.error}
          </T>
        </View>
      ) : null}

      <View>
        <SectionTitle title={rolledBack ? "What it attempted" : "The agent's notes"} />
        <Card style={{ padding: space.lg, gap: space.md }}>
          {rolledBack && d.changes.length > 0 ? (
            <Row style={{ gap: 6 }}>
              <Icon name="refresh" size={11} color={c.textMuted} />
              <T variant="caption" muted style={{ fontWeight: "500" }}>
                {d.files.length ? "Rolled back where possible" : "Rolled back — nothing was kept"}
              </T>
            </Row>
          ) : null}
          {d.changes.length ? (
            d.changes.map((ch, i) => (
              <View key={i} style={{ gap: 4, opacity: rolledBack ? 0.7 : 1 }}>
                <ChangeKindChip kind={ch.kind} />
                <T variant="footnote" style={rolledBack ? { textDecorationLine: "line-through" } : undefined}>
                  {ch.text}
                </T>
              </View>
            ))
          ) : (
            <T variant="footnote" muted>
              {`${agentName} didn't describe its changes — the diff shows exactly what it wrote.`}
            </T>
          )}
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionTitle title="Changes" />
        {files.length ? (
          files.map((f) => <FileChangeCard key={f.file.path} file={f.file} diff={f.diff} />)
        ) : (
          <Card style={{ padding: space.lg }}>
            <T variant="footnote" muted style={{ textAlign: "center" }}>
              {rolledBack ? "Nothing from this dream is left in the memory files." : "This dream didn't change any memory files."}
            </T>
          </Card>
        )}
      </View>

      {d.workspace.length > 0 ? <WorkspaceMoves moves={d.workspace} stuck={rolledBack} /> : null}
    </ScrollView>
  );
}

function FileChangeCard({ file, diff }: { file: DreamFileChange; diff: FileDiff }) {
  const c = useColors();
  const state = file.before === null ? "created" : file.after === null ? "deleted" : "edited";
  const empty =
    state === "created"
      ? "Created an empty file."
      : state === "deleted"
        ? "Deleted an empty file."
        : diff.finalNewline
          ? `Only the newline at the end of the file was ${diff.finalNewline}.`
          : "No line changes.";
  return (
    <Card style={{ overflow: "hidden" }}>
      <Row style={styles.fileHead}>
        <Icon name="doc" size={14} color={state === "created" ? c.success : state === "deleted" ? c.danger : c.textMuted} />
        <T variant="caption" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12.5 }}>
          {file.path}
        </T>
        {state !== "edited" ? <Badge label={state === "created" ? "New file" : "Deleted"} tone={state === "created" ? "success" : "danger"} dot={false} /> : null}
        <T variant="caption" style={{ fontFamily: fonts.mono }}>
          <T variant="caption" color={c.success} style={{ fontFamily: fonts.mono }}>{`+${diff.added}`}</T>{" "}
          <T variant="caption" color={c.danger} style={{ fontFamily: fonts.mono }}>{`−${diff.removed}`}</T>
        </T>
      </Row>
      <Hairline />
      {diff.lines.length ? (
        <DiffView lines={diff.lines} finalNewline={diff.finalNewline} />
      ) : (
        <T variant="footnote" muted style={{ padding: space.lg, fontStyle: "italic" }}>
          {empty}
        </T>
      )}
    </Card>
  );
}

function DiffView({ lines, finalNewline }: { lines: DiffLine[]; finalNewline: FileDiff["finalNewline"] }) {
  const c = useColors();
  const blocks = useMemo(() => foldContext(lines), [lines]);
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
  const [everything, setEverything] = useState(false);

  // Render until the row budget runs out, then stop — later blocks (folds included) collapse into one note.
  const rows: ReactNode[] = [];
  let budget = everything ? Infinity : MAX_ROWS;
  let notShown = 0;
  blocks.forEach((b, i) => {
    if (budget <= 0) {
      notShown += b.lines.length;
      return;
    }
    if (b.type === "fold" && !unfolded.has(i)) {
      budget -= 1;
      rows.push(
        <Pressable
          key={i}
          accessibilityRole="button"
          onPress={() => {
            tap();
            setUnfolded((s) => new Set(s).add(i));
          }}
          style={({ pressed }) => [styles.note, { backgroundColor: pressed ? c.accent : c.surfaceAlt, borderColor: c.border }]}
        >
          <Icon name="scroll" size={11} color={c.textMuted} />
          <T variant="caption" muted>
            Show {b.lines.length} unchanged lines
          </T>
        </Pressable>,
      );
      return;
    }
    const shown = b.lines.slice(0, budget);
    notShown += b.lines.length - shown.length;
    budget -= shown.length;
    shown.forEach((l, k) => rows.push(<DiffRow key={`${i}:${k}`} line={l} />));
  });

  return (
    <View style={{ paddingVertical: 4 }}>
      {rows}
      {notShown > 0 ? (
        <View style={[styles.note, { backgroundColor: c.surfaceAlt, borderColor: c.border, justifyContent: "space-between" }]}>
          <T variant="caption" muted>
            {notShown.toLocaleString()} more lines not shown
          </T>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setEverything(true)}>
            <T variant="caption" style={{ fontWeight: "600" }}>
              Show everything
            </T>
          </Pressable>
        </View>
      ) : finalNewline ? (
        <View style={[styles.note, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
          <T variant="caption" muted>
            {finalNewline === "added" ? "Newline added at end of file" : "No newline at end of file anymore"}
          </T>
        </View>
      ) : null}
    </View>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const c = useColors();
  const add = line.kind === "add";
  const del = line.kind === "del";
  const mark = add ? alpha(c.success, 0.2) : alpha(c.danger, 0.15);
  return (
    <View
      accessibilityLabel={`${add ? "Added: " : del ? "Removed: " : ""}${line.text}`}
      style={[styles.diffRow, add && { backgroundColor: alpha(c.success, 0.07) }, del && { backgroundColor: alpha(c.danger, 0.055) }]}
    >
      <View style={[styles.bar, { backgroundColor: add ? c.success : del ? alpha(c.danger, 0.7) : "transparent" }]} />
      <Text style={[styles.code, styles.sign, { color: add ? c.success : del ? c.danger : "transparent" }]}>{add ? "+" : del ? "−" : " "}</Text>
      <Text style={[styles.code, { flex: 1, color: line.kind === "same" ? c.textMuted : c.text }]}>
        {line.parts
          ? line.parts.map((p, i) =>
              p.changed ? (
                <Text key={i} style={{ backgroundColor: mark, textDecorationLine: del ? "line-through" : "none" }}>
                  {p.text}
                </Text>
              ) : (
                <Text key={i}>{p.text}</Text>
              ),
            )
          : line.text || " "}
      </Text>
    </View>
  );
}

const MOVE_META: Record<DreamWorkspaceChange["action"], { label: string; icon: IconName; color: (c: Colors) => string }> = {
  move: { label: "sorted", icon: "move", color: (c) => c.sky },
  rewrite: { label: "rewritten", icon: "pencil", color: (c) => c.violet },
  discard: { label: "discarded", icon: "trash", color: (c) => c.rose },
};

/** How the dream tidied the workspace; after a rollback, what couldn't be moved back. */
function WorkspaceMoves({ moves, stuck }: { moves: DreamWorkspaceChange[]; stuck: boolean }) {
  const c = useColors();
  const counts = (["move", "rewrite", "discard"] as const)
    .map((action) => ({ action, n: moves.filter((m) => m.action === action).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${MOVE_META[x.action].label}`);
  return (
    <View>
      <SectionTitle title={stuck ? "Couldn't be put back" : "Workspace"} />
      <Card style={{ overflow: "hidden" }}>
        <T variant="footnote" muted style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}>
          {counts.join(" · ")}
        </T>
        {moves.map((m, i) => {
          const meta = MOVE_META[m.action];
          return (
            <View key={`${m.from}-${i}`}>
              <Hairline inset={space.lg} />
              <Row style={styles.move}>
                <Icon name={meta.icon} size={12} color={meta.color(c)} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="caption" numberOfLines={1} style={{ fontFamily: fonts.mono }}>
                    {m.from}
                  </T>
                  <T variant="caption" muted numberOfLines={1} style={m.action === "move" ? { fontFamily: fonts.mono } : undefined}>
                    {m.action === "move" ? `→ ${m.to}` : m.action === "rewrite" ? `${formatBytes(m.bytes)} now` : "removed after a week"}
                  </T>
                </View>
              </Row>
            </View>
          );
        })}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  callout: {
    flexDirection: "row",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  fileHead: {
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  diffRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingRight: space.md,
  },
  bar: {
    width: 2,
    alignSelf: "stretch",
  },
  sign: {
    width: 18,
    textAlign: "center",
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  move: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
  },
});
