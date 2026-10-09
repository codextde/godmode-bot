import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { memo, useEffect, useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Attachment, Message, MessageBlock } from "@godmode/shared";
import { toolActivity } from "@godmode/shared";
import { FileChip } from "./attachments";
import { Icon } from "./icon";
import { Markdown } from "./markdown";
import { Row, T, tap } from "./ui";
import { toolLabel } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { radius, space, useColors } from "@/lib/theme";

type Step = Extract<MessageBlock, { type: "tool_use" | "thinking" }>;
type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;
type Part = { kind: "block"; block: MessageBlock } | { kind: "steps"; steps: Step[] } | { kind: "subagent"; block: ToolUse; children: MessageBlock[] };

const isSubagent = (block: MessageBlock) => block.type === "tool_use" && (block.name === "Task" || block.name === "Agent");

/** Consecutive tool calls and thinking collapse into one "steps" row; a subagent gets its own card with its work inside. */
function group(blocks: MessageBlock[]): Part[] {
  const parts: Part[] = [];
  const children = new Map<string, MessageBlock[]>();
  for (const block of blocks) {
    const parent = "parentToolUseId" in block ? block.parentToolUseId : null;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), block]);
  }
  for (const block of blocks) {
    if ("parentToolUseId" in block && block.parentToolUseId) continue;
    if (block.type === "tool_use" && isSubagent(block)) parts.push({ kind: "subagent", block, children: children.get(block.id) ?? [] });
    else if (block.type === "tool_use" || block.type === "thinking") {
      const last = parts[parts.length - 1];
      if (last?.kind === "steps") last.steps.push(block);
      else parts.push({ kind: "steps", steps: [block] });
    } else parts.push({ kind: "block", block });
  }
  return parts;
}

/**
 * Where a subagent stands. One in the background returns its tool call at once: its task says when it works and when it
 * is done, and its report comes with the task's end. Still running on a turn that ended means it was cut off.
 */
function subagentState(block: ToolUse, streaming: boolean) {
  const task = block.task;
  const background = task?.background ?? block.result?.startsWith("Async agent launched") ?? false;
  const status = task ? (task.status === "running" && !streaming ? "stopped" : task.status) : null;
  const running = status ? status === "running" : !background && streaming && block.result === undefined;
  const failed = status === "failed" || !!block.isError;
  const result = background ? task?.summary : block.result;
  return { task, background, status, running, failed, result };
}

const SOURCE_CAPTION = { automation: "Automation", delegation: "From another agent", task: "Board ticket" } as const;

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const c = useColors();
  // A turn the human didn't write keeps the neutral surface and says who it came from.
  const caption = message.source ? SOURCE_CAPTION[message.source] : null;
  const fg = caption ? c.text : c.onPrimary;
  return (
    <View style={[styles.userWrap, caption ? { alignItems: "flex-start" } : null]}>
      {caption ? (
        <T variant="caption" muted style={{ marginBottom: 4 }}>
          {caption}
        </T>
      ) : null}
      <Pressable onLongPress={() => copy(message.content)} style={[styles.user, { backgroundColor: caption ? c.sunken : c.primary }]}>
        <Files attachments={message.attachments} spaced={!!message.content} color={fg} />
        {message.content ? (
          <T variant="body" color={fg} selectable>
            {message.content}
          </T>
        ) : null}
      </Pressable>
    </View>
  );
});

export const AssistantMessage = memo(function AssistantMessage({ blocks, streaming, content }: { blocks: MessageBlock[]; streaming?: boolean; content?: string }) {
  const parts = group(blocks);
  const last = parts[parts.length - 1];
  return (
    <Pressable onLongPress={content ? () => copy(content) : undefined} style={styles.assistant}>
      {parts.length === 0 && streaming ? <Thinking /> : null}
      {parts.map((p, i) =>
        p.kind === "steps" ? (
          <Steps key={i} steps={p.steps} live={streaming && p === last} />
        ) : p.kind === "subagent" ? (
          <SubagentCard key={p.block.id} block={p.block} childBlocks={p.children} streaming={!!streaming} />
        ) : (
          <Block key={i} block={p.block} />
        ),
      )}
      {streaming ? <BackgroundAgents parts={parts} /> : null}
      {streaming && last?.kind === "block" && last.block.type === "text" ? <Caret /> : null}
    </Pressable>
  );
});

function Files({ attachments, spaced, color }: { attachments: Attachment[]; spaced: boolean; color: string }) {
  if (!attachments.length) return null;
  return (
    <View style={[styles.files, spaced && { marginBottom: 8 }]}>
      {attachments.map((a, i) => (
        <FileChip key={`${a.path}-${i}`} name={a.name} mime={a.mime} size={a.size} color={color} />
      ))}
    </View>
  );
}

function copy(text: string) {
  if (!text) return;
  void Clipboard.setStringAsync(text);
  tap();
}

function Block({ block }: { block: MessageBlock }) {
  const c = useColors();
  switch (block.type) {
    case "text":
      return block.text.trim() ? <Markdown text={block.text} /> : null;
    case "error":
      return (
        <View style={[styles.callout, { backgroundColor: c.dangerSoft }]}>
          <Icon name="warning" size={15} color={c.danger} />
          <T variant="subhead" color={c.danger} style={{ flex: 1 }}>
            {block.text}
          </T>
        </View>
      );
    case "notice":
      return (
        <View style={[styles.callout, { backgroundColor: block.level === "warning" ? c.warningSoft : c.sunken }]}>
          <Icon name={block.level === "warning" ? "warning" : "bolt"} size={14} color={block.level === "warning" ? c.warning : c.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {block.text}
          </T>
        </View>
      );
    case "command":
      return (
        <View style={[styles.command, { backgroundColor: c.sunken }]}>
          <T variant="footnote" style={{ fontWeight: "600" }}>
            /{block.name} {block.args}
          </T>
          {block.output ? (
            <T variant="mono" muted numberOfLines={12}>
              {block.output}
            </T>
          ) : null}
        </View>
      );
    case "user_message":
      return (
        <View style={styles.userWrap}>
          <View style={[styles.user, { backgroundColor: c.primary }]}>
            <Files attachments={block.attachments} spaced={!!block.text} color={c.onPrimary} />
            {block.text ? (
              <T variant="body" color={c.onPrimary} selectable>
                {block.text}
              </T>
            ) : null}
          </View>
        </View>
      );
    case "question": {
      // Answered by writing into the chat: a suggested answer by its number or its words.
      const open = block.status === "open";
      const approval = block.kind === "approval";
      const status =
        block.status === "open"
          ? approval
            ? "Reply “approve” or “decline” below — or what to do instead."
            : block.options.length
              ? "Reply below with a number or your own answer."
              : "Reply below to answer."
          : block.status === "approved"
            ? `Approved${block.answer?.text ? ` — ${block.answer.text}` : ""}`
            : block.status === "declined"
              ? `Declined${block.answer?.text ? ` — ${block.answer.text}` : ""}`
              : block.status === "answered"
                ? `Answered: ${block.answer?.text ?? ""}`
                : "Withdrawn — the run was stopped before this was answered.";
      return (
        <View style={[styles.question, { backgroundColor: open ? c.warningSoft : c.sunken, borderColor: open ? c.warning : c.border }]}>
          <T variant="caption" color={open ? c.warning : c.textMuted} style={{ fontWeight: "600" }}>
            {approval ? "NEEDS YOUR OK" : "QUESTION"}
          </T>
          <T variant="body" style={{ fontWeight: "600" }} selectable>
            {block.title}
          </T>
          {block.body ? (
            <T variant="footnote" muted selectable>
              {approval ? `Why: ${block.body}` : block.body}
            </T>
          ) : null}
          {approval && block.affects ? (
            <T variant="footnote" muted selectable>
              Affects: {block.affects}
            </T>
          ) : null}
          {block.options.map((o, i) => (
            <T key={o.id} variant="subhead" style={{ opacity: !open && block.answer?.optionId !== o.id ? 0.55 : 1 }}>
              {i + 1}. {o.label}
              {o.recommended ? " (recommended)" : ""}
              {o.description ? ` — ${o.description}` : ""}
            </T>
          ))}
          <T variant="footnote" muted>
            {status}
          </T>
        </View>
      );
    }
    case "human_task": {
      const done = block.outcome === "done";
      return (
        <View style={[styles.callout, { backgroundColor: c.sunken, alignItems: "flex-start" }]}>
          <Icon name={done ? "check" : "close"} size={14} color={c.textMuted} style={{ marginTop: 2 }} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {done ? "You did" : "You couldn't do"} H-{block.number}: {block.title}
            </T>
            {block.note ? (
              <T variant="footnote" muted selectable>
                {block.note}
              </T>
            ) : null}
          </View>
        </View>
      );
    }
    case "pause": {
      // The question card says why a run stands still for an answer.
      if (block.reason === "question") return null;
      const limit = block.reason === "limit" || block.reason === "budget";
      const what = block.reason === "budget" ? "Held · budget used up" : limit ? `${block.limit ?? "Usage limit"} reached` : "Paused";
      return (
        <View style={[styles.callout, { backgroundColor: limit ? c.warningSoft : c.sunken }]}>
          <Icon name={limit ? "clock" : "pause"} size={14} color={limit ? c.warning : c.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {what.charAt(0).toUpperCase() + what.slice(1)}
            {block.resumedAt ? " · continued" : ""}
          </T>
        </View>
      );
    }
    default:
      return null;
  }
}

function SubagentCard({ block, childBlocks, streaming }: { block: ToolUse; childBlocks: MessageBlock[]; streaming: boolean }) {
  const c = useColors();
  const { task, background, status, running, failed, result } = subagentState(block, streaming);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? false;
  const input = (block.input && typeof block.input === "object" ? block.input : {}) as { description?: unknown; subagent_type?: unknown };
  const title = (typeof input.description === "string" && input.description) || task?.description || "Helper";
  const tools = childBlocks.filter((b): b is ToolUse => b.type === "tool_use");
  const steps = Math.max(tools.length, task?.toolUses ?? 0);
  const state = running ? task?.activity || "Working…" : failed ? "Failed" : status === "stopped" ? "Stopped" : "Done";
  const meta = [background ? "Background helper" : "Helper", state, steps > 0 ? `${steps} steps` : null, !running && task?.durationMs ? duration(task.durationMs) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={[styles.steps, { borderColor: failed ? c.danger : running ? c.brand : c.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen(!expanded);
        }}
        style={styles.stepsHeader}
      >
        <View style={[styles.stepIcon, { backgroundColor: failed ? c.dangerSoft : running ? c.brandSoft : c.sunken }]}>
          <Icon name="subagent" size={13} color={failed ? c.danger : running ? c.brandStrong : c.textMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "500" }}>
            {title}
          </T>
          <T variant="caption" muted numberOfLines={1} color={failed ? c.danger : undefined}>
            {meta}
          </T>
        </View>
        {running && task?.startedAt ? <Elapsed since={task.startedAt} /> : null}
        {running ? <Spinner /> : <Icon name="down" size={11} color={c.textFaint} style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }} />}
      </Pressable>
      {expanded && (
        <Animated.View entering={FadeIn.duration(160)} style={{ gap: 10, paddingTop: 4, paddingBottom: 12, paddingHorizontal: space.md }}>
          {tools.slice(-12).map((t, i) => (
            <ToolStep key={t.id ?? i} step={t} />
          ))}
          {tools.length > 12 ? (
            <T variant="caption" muted>
              and {tools.length - 12} earlier steps
            </T>
          ) : null}
          {result ? (
            <View style={[styles.report, { backgroundColor: c.sunken }]}>
              <T variant="eyebrow" muted>
                {background ? "Report" : "Result"}
              </T>
              <Markdown text={result.length > 6000 ? `${result.slice(0, 6000)}…` : result} />
            </View>
          ) : running && !tools.length ? (
            <Thinking />
          ) : null}
        </Animated.View>
      )}
    </View>
  );
}

/** Helpers still at work in the background, at the foot of the turn: without this the chat would look idle. */
function BackgroundAgents({ parts }: { parts: Part[] }) {
  const c = useColors();
  const working = parts.flatMap((p) => (p.kind === "subagent" && subagentState(p.block, true).background && subagentState(p.block, true).running ? [p.block] : []));
  const last = parts[parts.length - 1];
  if (!working.length || (working.length === 1 && last?.kind === "subagent" && last.block === working[0])) return null;
  return (
    <Animated.View entering={FadeIn.duration(200)} style={[styles.background, { borderColor: c.border }]}>
      <Spinner />
      <T variant="footnote" muted style={{ flex: 1 }}>
        {working.length === 1 ? "1 helper is working in the background" : `${working.length} helpers are working in the background`}
      </T>
    </Animated.View>
  );
}

function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
      {duration(now - since)}
    </T>
  );
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function Steps({ steps, live }: { steps: Step[]; live?: boolean }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const tools = steps.filter((s): s is Extract<Step, { type: "tool_use" }> => s.type === "tool_use");
  const latest = tools[tools.length - 1];
  const label = latest ? toolLabel(latest) : null;
  const failed = tools.some((t) => t.isError);
  const pending = live && latest && latest.result === undefined;
  const summary = pending ? toolActivity(latest.name, latest.input).replace(/…$/, "") : label ? label.title : "Thought it through";
  const count = tools.length;

  return (
    <View style={[styles.steps, { borderColor: c.border }]}>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen((o) => !o);
        }}
        style={styles.stepsHeader}
      >
        <View style={[styles.stepIcon, { backgroundColor: c.sunken }]}>
          <Icon name={label?.icon ?? "sparkles"} size={13} color={failed ? c.warning : c.textMuted} />
        </View>
        <T variant="subhead" numberOfLines={1} style={{ flex: 1, fontWeight: "500" }}>
          {summary}
        </T>
        {count > 1 && (
          <T variant="caption" muted>
            {count} steps
          </T>
        )}
        {live ? <Spinner /> : <Icon name="down" size={11} color={c.textFaint} style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} />}
      </Pressable>
      {open && (
        <Animated.View entering={FadeIn.duration(160)} style={{ gap: 10, paddingTop: 4, paddingBottom: 10, paddingHorizontal: space.md }}>
          {steps.map((s, i) => (s.type === "thinking" ? <ThinkingStep key={i} text={s.text} /> : <ToolStep key={s.id ?? i} step={s} />))}
        </Animated.View>
      )}
    </View>
  );
}

function ToolStep({ step }: { step: ToolUse }) {
  const c = useColors();
  const label = toolLabel(step);
  const [more, setMore] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => step.result && setMore((m) => !m)}>
        <Row style={{ gap: 8, alignItems: "flex-start" }}>
          <Icon name={label.icon} size={13} color={step.isError ? c.warning : c.textMuted} style={{ marginTop: 3 }} />
          <View style={{ flex: 1 }}>
            <T variant="footnote" style={{ fontWeight: "500" }}>
              {label.title}
            </T>
            {label.detail ? (
              <T variant="caption" muted numberOfLines={2}>
                {label.detail}
              </T>
            ) : null}
          </View>
        </Row>
      </Pressable>
      {step.image ? <Image source={{ uri: `data:image/png;base64,${step.image}` }} style={[styles.shot, { backgroundColor: c.sunken }]} contentFit="contain" /> : null}
      {more && step.result ? (
        <T variant="mono" muted numberOfLines={16} style={[styles.result, { backgroundColor: c.sunken }]}>
          {step.result.slice(0, 2000)}
        </T>
      ) : null}
    </View>
  );
}

function ThinkingStep({ text }: { text: string }) {
  const c = useColors();
  return (
    <Row style={{ gap: 8, alignItems: "flex-start" }}>
      <Icon name="sparkles" size={13} color={c.dream} style={{ marginTop: 3 }} />
      <T variant="footnote" muted style={{ flex: 1, fontStyle: "italic" }} numberOfLines={8}>
        {text.trim() || "Thinking"}
      </T>
    </Row>
  );
}

function Thinking() {
  return (
    <Row style={{ gap: 8 }}>
      <Spinner />
      <T variant="subhead" muted>
        Thinking…
      </T>
    </Row>
  );
}

function Spinner() {
  const c = useColors();
  const v = useSharedValue(0.3);
  useEffect(() => {
    v.value = withRepeat(withSequence(withTiming(1, { duration: 600 }), withTiming(0.3, { duration: 600 })), -1);
  }, [v]);
  const style = useAnimatedStyle(() => ({ opacity: v.value }));
  return (
    <Animated.View style={[{ flexDirection: "row", gap: 3 }, style]}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: c.brand }} />
      ))}
    </Animated.View>
  );
}

function Caret() {
  const c = useColors();
  const v = useSharedValue(1);
  useEffect(() => {
    v.value = withRepeat(withSequence(withTiming(0, { duration: 450 }), withTiming(1, { duration: 450 })), -1);
  }, [v]);
  const style = useAnimatedStyle(() => ({ opacity: v.value }));
  return <Animated.View style={[{ width: 9, height: 18, borderRadius: 2, backgroundColor: c.brand, marginTop: -4 }, style]} />;
}

const styles = StyleSheet.create({
  userWrap: {
    alignItems: "flex-end",
    paddingLeft: 48,
  },
  user: {
    borderRadius: 22,
    borderBottomRightRadius: 8,
    borderCurve: "continuous",
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  files: {
    gap: 6,
    marginHorizontal: -7,
    marginTop: -2,
  },
  assistant: {
    gap: 12,
    paddingRight: 8,
  },
  question: {
    gap: 6,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  command: {
    gap: 6,
    padding: space.md,
    borderRadius: radius.sm,
  },
  steps: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  stepsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  stepIcon: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  report: {
    gap: 6,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  background: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
  },
  shot: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: radius.sm,
  },
  result: {
    padding: 10,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
});
