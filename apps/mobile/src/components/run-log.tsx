import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Share, StyleSheet, View } from "react-native";
import { Segmented } from "./form";
import { Icon, type IconName } from "./icon";
import { Markdown } from "./markdown";
import { formatDuration, formatTokens } from "./run-row";
import { Badge, Button, LiveDot, Row, Skeleton, T, tap } from "./ui";
import { ApiError, api, errorText } from "@/lib/api";
import { formatCost } from "@/lib/desktop-parity";
import { toolLabel } from "@/lib/format";
import { qk } from "@/lib/query";
import { useSpendTracking } from "@/lib/setup";
import { fonts, radius, space, useColors } from "@/lib/theme";

type Json = Record<string, unknown>;

export type LogEntry =
  | { kind: "init"; raw: string; model: string; tools: number; mcp: { name: string; status: string }[]; cwd: string }
  | { kind: "text"; raw: string; text: string; sub: boolean }
  | { kind: "thinking"; raw: string; text: string }
  | { kind: "tool_use"; raw: string; id: string; name: string; input: unknown; sub: boolean }
  | { kind: "tool_result"; raw: string; toolUseId: string; content: string; isError: boolean; images: number }
  | {
      kind: "result";
      raw: string;
      subtype: string;
      isError: boolean;
      durationMs: number | null;
      costUsd: number | null;
      numTurns: number | null;
      tokensIn: number | null;
      tokensOut: number | null;
    }
  | { kind: "rate_limit"; raw: string; status: string; detail: string }
  | { kind: "system"; raw: string; subtype: string }
  | { kind: "stream"; raw: string; eventType: string }
  | { kind: "other"; raw: string; type: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function resultContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (Array.isArray(content)) {
    let images = 0;
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object") {
        const o = c as Json;
        if (o.type === "text") parts.push(str(o.text));
        else if (o.type === "image") images++;
        else parts.push(JSON.stringify(o));
      }
    }
    return { text: parts.join("\n"), images };
  }
  return { text: content == null ? "" : JSON.stringify(content, null, 2), images: 0 };
}

/** Turn Claude CLI stream-json lines into displayable entries (the desktop's run-log-viewer). */
export function parseRunLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    let ev: Json;
    try {
      ev = JSON.parse(raw);
    } catch {
      out.push({ kind: "other", raw, type: "text" });
      continue;
    }
    const type = str(ev.type);
    const sub = !!ev.parent_tool_use_id;
    if (type === "system" && ev.subtype === "init") {
      const mcp = Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as Json[]).map((m) => ({ name: str(m.name), status: str(m.status) })) : [];
      out.push({ kind: "init", raw, model: str(ev.model), tools: Array.isArray(ev.tools) ? ev.tools.length : 0, mcp, cwd: str(ev.cwd) });
    } else if (type === "system") {
      out.push({ kind: "system", raw, subtype: str(ev.subtype) || "system" });
    } else if (type === "assistant") {
      const content = ((ev.message as Json | undefined)?.content ?? []) as Json[];
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === "text" && str(block.text).trim()) out.push({ kind: "text", raw, text: str(block.text), sub });
        else if (block.type === "thinking") out.push({ kind: "thinking", raw, text: str(block.thinking) });
        else if (block.type === "redacted_thinking") out.push({ kind: "thinking", raw, text: "" });
        else if (block.type === "tool_use") out.push({ kind: "tool_use", raw, id: str(block.id), name: str(block.name), input: block.input, sub });
      }
    } else if (type === "user") {
      const content = ((ev.message as Json | undefined)?.content ?? []) as unknown;
      if (Array.isArray(content)) {
        for (const block of content as Json[]) {
          if (block?.type === "tool_result") {
            const { text: t, images } = resultContent(block.content);
            out.push({ kind: "tool_result", raw, toolUseId: str(block.tool_use_id), content: t, isError: !!block.is_error, images });
          } else if (block?.type === "text" && str(block.text).trim()) {
            out.push({ kind: "other", raw, type: "user" });
          }
        }
      } else if (typeof content === "string") {
        out.push({ kind: "other", raw, type: "user" });
      }
    } else if (type === "result" || (ev.total_cost_usd !== undefined && ev.duration_ms !== undefined)) {
      const usage = (ev.usage ?? {}) as Json;
      out.push({
        kind: "result",
        raw,
        subtype: str(ev.subtype) || str(ev.stop_reason) || "done",
        isError: !!ev.is_error,
        durationMs: num(ev.duration_ms),
        costUsd: num(ev.total_cost_usd),
        numTurns: num(ev.num_turns),
        tokensIn: num(usage.input_tokens),
        tokensOut: num(usage.output_tokens),
      });
    } else if (type === "rate_limit_event") {
      const info = (ev.rate_limit_info ?? {}) as Json;
      const windows = (info.unifiedWindows ?? {}) as Record<string, Json>;
      const detail = Object.entries(windows)
        .map(([k, w]) => `${k.replace("_", " ")} ${Math.round((num(w.utilization) ?? 0) * 100)}%`)
        .join(" · ");
      out.push({ kind: "rate_limit", raw, status: str(info.status) || "unknown", detail });
    } else if (type === "stream_event") {
      out.push({ kind: "stream", raw, eventType: str((ev.event as Json | undefined)?.type) || "event" });
    } else {
      out.push({ kind: "other", raw, type: type || "event" });
    }
  }
  return out;
}

/** The raw log; none yet (a queued run) reads as empty. */
async function fetchLog(id: string): Promise<string> {
  try {
    const res = (await api.runs.log(id)) as unknown;
    return typeof res === "string" ? res : JSON.stringify(res);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return "";
    throw err;
  }
}

const PAGE = 100;
const MAX_TEXT = 20_000;
const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 90);
type Tools = Map<string, { name: string; input: unknown }>;

/** A run's stream-json log as readable steps (or raw), newest at the bottom; refreshes every few seconds while `live`. */
export function RunLog({ runId, live = false }: { runId: string; live?: boolean }) {
  const c = useColors();
  const spendTracking = useSpendTracking();
  const [mode, setMode] = useState<"steps" | "raw">("steps");
  const [showStream, setShowStream] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // A finished run's log doesn't change; a live one is fetched again every few seconds, never on other runs' events.
  const log = useQuery({ queryKey: qk.runLog(runId), queryFn: () => fetchLog(runId), refetchInterval: live ? 10_000 : false, staleTime: live ? 0 : Infinity });
  const { refetch } = log;
  const wasLive = useRef(live);
  useEffect(() => {
    // The run just ended: its last lines came after the last fetch.
    if (wasLive.current && !live) void refetch();
    wasLive.current = live;
  }, [live, refetch]);
  const text = log.data ?? "";
  const entries = useMemo(() => parseRunLog(text), [text]);
  const tools = useMemo(() => {
    const m: Tools = new Map();
    for (const e of entries) if (e.kind === "tool_use") m.set(e.id, { name: e.name, input: e.input });
    return m;
  }, [entries]);
  const streamCount = useMemo(() => entries.filter((e) => e.kind === "stream").length, [entries]);
  const visible = useMemo(() => entries.flatMap((entry, at) => (showStream || entry.kind !== "stream" ? [{ entry, at }] : [])), [entries, showStream]);

  if (log.isLoading) {
    return (
      <View style={{ gap: space.sm }} accessibilityRole="progressbar" accessibilityLabel="Loading the log">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} height={28} radius={radius.md} />
        ))}
      </View>
    );
  }
  if (log.isError) return <Note text={`Couldn't load the log: ${errorText(log.error)}`} />;
  if (!entries.length) return <Note text="No log lines yet." />;

  return (
    <View style={{ gap: space.md }}>
      <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
        <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
          {`${entries.length} events`}
        </T>
        {live ? (
          <Row style={{ gap: 5 }}>
            <LiveDot size={6} />
            <T variant="caption" color={c.brandStrong} style={{ fontWeight: "500" }}>
              Live
            </T>
          </Row>
        ) : null}
        {streamCount > 0 && mode === "steps" ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: showStream }}
            hitSlop={6}
            onPress={() => {
              tap();
              setShowStream((v) => !v);
            }}
          >
            <Badge label={`Streaming deltas (${streamCount})`} tone={showStream ? "brand" : "neutral"} dot={false} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <CopyButton text={text} label="Copy raw log" />
        <IconButton
          icon="share"
          label="Share raw log"
          onPress={() => void Share.share({ message: text, title: `run-${runId}.jsonl` }).catch(() => undefined)}
        />
      </Row>
      <Segmented
        options={[
          { value: "steps", label: "Steps" },
          { value: "raw", label: "Raw" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === "raw" ? (
        <Pre text={text} />
      ) : (
        <View style={[styles.steps, { borderColor: c.border }]}>
          {visible.slice(0, limit).map(({ entry, at }) => (
            <LogRow key={at} entry={entry} tools={tools} spendTracking={spendTracking} />
          ))}
        </View>
      )}
      {mode === "steps" && visible.length > limit ? (
        <Button
          title={`Show ${Math.min(PAGE, visible.length - limit)} more of ${visible.length - limit}`}
          variant="outline"
          onPress={() => setLimit((l) => l + PAGE)}
        />
      ) : null}
    </View>
  );
}

const LogRow = memo(function LogRow({ entry, tools, spendTracking }: { entry: LogEntry; tools: Tools; spendTracking: boolean }) {
  const c = useColors();
  switch (entry.kind) {
    case "init":
      return (
        <Step icon="power" title="Session started" raw={entry.raw}>
          <T variant="footnote" muted>
            {`${entry.model || "model"} · ${entry.tools} tools`}
            {entry.mcp.length > 0 ? ` · MCP: ${entry.mcp.map((m) => `${m.name}${m.status && m.status !== "connected" ? ` (${m.status})` : ""}`).join(", ")}` : ""}
          </T>
        </Step>
      );
    case "text":
      return (
        <Step icon="text" title={entry.sub ? "Subagent said" : "Assistant"} raw={entry.raw} defaultOpen>
          <Markdown text={entry.text} />
        </Step>
      );
    case "thinking":
      return (
        <Step icon="brain" iconColor={c.textMuted} title="Thinking" summary={entry.text ? oneLine(entry.text) : "redacted"} raw={entry.raw}>
          <T variant="footnote" muted style={entry.text ? undefined : { fontStyle: "italic" }}>
            {entry.text || "Thinking is redacted."}
          </T>
        </Step>
      );
    case "tool_use": {
      const meta = toolLabel({ type: "tool_use", id: entry.id, name: entry.name, input: entry.input });
      return (
        <Step icon={meta.icon} title={meta.title} summary={meta.detail ?? entry.name} raw={entry.raw} badge={entry.sub ? "subagent" : undefined}>
          <Pre text={formatToolInput(entry.input)} />
        </Step>
      );
    }
    case "tool_result": {
      const tool = tools.get(entry.toolUseId);
      const title = tool ? toolLabel({ type: "tool_use", id: entry.toolUseId, name: tool.name, input: tool.input }).title : "Tool result";
      return (
        <Step
          icon={entry.isError ? "closeCircle" : "reply"}
          iconColor={entry.isError ? c.danger : c.textMuted}
          title={entry.isError ? `Failed: ${title}` : `Result · ${title}`}
          summary={entry.images ? `${entry.images} image${entry.images > 1 ? "s" : ""}` : oneLine(entry.content)}
          raw={entry.raw}
          tone={entry.isError ? "error" : undefined}
        >
          <Pre text={entry.content || (entry.images ? "(image result)" : "(empty)")} />
        </Step>
      );
    }
    case "result":
      return (
        <Step
          icon={entry.isError ? "closeCircle" : "checkCircle"}
          iconColor={entry.isError ? c.danger : c.success}
          title={entry.isError ? `Finished with error (${entry.subtype})` : "Finished"}
          raw={entry.raw}
          tone={entry.isError ? "error" : "success"}
        >
          <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
            {formatDuration(entry.durationMs)}
            {spendTracking && entry.costUsd != null ? ` · ${formatCost(entry.costUsd)}` : ""}
            {entry.numTurns != null ? ` · ${entry.numTurns} turns` : ""}
            {entry.tokensIn != null ? ` · ${formatTokens(entry.tokensIn)} in / ${formatTokens(entry.tokensOut)} out` : ""}
          </T>
        </Step>
      );
    case "rate_limit":
      return <Step icon="gauge" iconColor={c.textMuted} title={`Rate limit: ${entry.status}`} summary={entry.detail} raw={entry.raw} muted />;
    case "system":
      return <Step icon="slider" iconColor={c.textMuted} title={`System · ${entry.subtype}`} raw={entry.raw} muted />;
    case "stream":
      return <Step icon="doc" iconColor={c.textMuted} title={`stream · ${entry.eventType}`} raw={entry.raw} muted />;
    case "other":
      return <Step icon="doc" iconColor={c.textMuted} title={entry.type} summary={entry.raw.slice(0, 90)} raw={entry.raw} muted />;
  }
});

/** One collapsible line of the log; open, it shows its details and can show its raw JSON. */
function Step({
  icon,
  iconColor,
  title,
  summary,
  children,
  raw,
  defaultOpen = false,
  muted,
  tone,
  badge,
}: {
  icon: IconName;
  iconColor?: string;
  title: string;
  summary?: string;
  children?: ReactNode;
  raw: string;
  defaultOpen?: boolean;
  muted?: boolean;
  tone?: "error" | "success";
  badge?: string;
}) {
  const c = useColors();
  const [open, setOpen] = useState(defaultOpen);
  const [showRaw, setShowRaw] = useState(false);
  return (
    <View style={[styles.step, tone === "error" && { backgroundColor: c.dangerSoft }, tone === "success" && { backgroundColor: c.successSoft }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.stepHead, pressed && { opacity: 0.6 }]}
      >
        <Icon name={open ? "down" : "chevron"} size={10} color={c.textFaint} weight="semibold" />
        <Icon name={icon} size={13} color={iconColor ?? c.text} />
        <T variant="footnote" numberOfLines={1} style={{ flex: 1, minWidth: 0 }} color={muted ? c.textMuted : c.text}>
          <T variant="footnote" color={muted ? c.textMuted : c.text} style={muted ? undefined : { fontWeight: "500" }}>
            {title}
          </T>
          {summary && !open ? <T variant="footnote" muted>{`  ${summary}`}</T> : null}
        </T>
        {badge ? <Badge label={badge} dot={false} /> : null}
      </Pressable>
      {open ? (
        <View style={styles.stepBody}>
          {children}
          <Pressable hitSlop={6} onPress={() => setShowRaw((r) => !r)} style={{ alignSelf: "flex-start" }}>
            <T variant="caption" muted>
              {showRaw ? "Hide raw JSON" : "Raw JSON"}
            </T>
          </Pressable>
          {showRaw ? <Pre text={prettyJson(raw)} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function prettyJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function Pre({ text }: { text: string }) {
  const c = useColors();
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (${text.length - MAX_TEXT} more characters)` : text;
  return (
    <View style={[styles.pre, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
      <T variant="caption" selectable style={styles.mono}>
        {clipped}
      </T>
    </View>
  );
}

function Note({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={[styles.note, { borderColor: c.borderStrong }]}>
      <T variant="footnote" muted>
        {text}
      </T>
    </View>
  );
}

function IconButton({ icon, label, onPress, color }: { icon: IconName; label: string; onPress: () => void; color?: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name={icon} size={14} color={color ?? c.textMuted} />
    </Pressable>
  );
}

/** Copies `text`; a check says it worked. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? "Copied" : label}
      color={copied ? c.success : undefined}
      onPress={() => {
        void Clipboard.setStringAsync(text);
        setCopied(true);
      }}
    />
  );
}

const styles = StyleSheet.create({
  steps: {
    borderLeftWidth: 1,
    paddingLeft: space.xs,
    gap: 2,
  },
  step: {
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  stepHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 34,
    paddingHorizontal: space.sm,
  },
  stepBody: {
    gap: space.sm,
    paddingLeft: 40,
    paddingRight: space.sm,
    paddingBottom: space.sm,
  },
  pre: {
    padding: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 17,
  },
  note: {
    padding: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: 1,
    borderStyle: "dashed",
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
