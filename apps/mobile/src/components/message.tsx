import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { memo, useEffect, useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Message, MessageBlock } from "@godmode/shared";
import { Icon } from "./icon";
import { Markdown } from "./markdown";
import { Row, T, tap } from "./ui";
import { activityText, toolLabel } from "@/lib/format";
import { radius, space, useColors } from "@/lib/theme";

type Step = Extract<MessageBlock, { type: "tool_use" | "thinking" }>;
type Part = { kind: "block"; block: MessageBlock } | { kind: "steps"; steps: Step[] };

/** Consecutive tool calls and thinking collapse into one "steps" row; subagent output stays inside its tool. */
function group(blocks: MessageBlock[]): Part[] {
  const parts: Part[] = [];
  for (const block of blocks) {
    if ("parentToolUseId" in block && block.parentToolUseId) continue;
    if (block.type === "tool_use" || block.type === "thinking") {
      const last = parts[parts.length - 1];
      if (last?.kind === "steps") last.steps.push(block);
      else parts.push({ kind: "steps", steps: [block] });
    } else parts.push({ kind: "block", block });
  }
  return parts;
}

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const c = useColors();
  return (
    <View style={styles.userWrap}>
      <Pressable onLongPress={() => copy(message.content)} style={[styles.user, { backgroundColor: c.primary }]}>
        <T variant="body" color={c.onPrimary} selectable>
          {message.content}
        </T>
        {message.attachments.length > 0 && (
          <T variant="caption" color={c.onPrimary} style={{ opacity: 0.7, marginTop: 4 }}>
            {message.attachments.map((a) => a.name).join(", ")}
          </T>
        )}
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
      {parts.map((p, i) => (p.kind === "steps" ? <Steps key={i} steps={p.steps} live={streaming && p === last} /> : <Block key={i} block={p.block} />))}
      {streaming && last?.kind === "block" && last.block.type === "text" ? <Caret /> : null}
    </Pressable>
  );
});

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
    default:
      return null;
  }
}

function Steps({ steps, live }: { steps: Step[]; live?: boolean }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const tools = steps.filter((s): s is Extract<Step, { type: "tool_use" }> => s.type === "tool_use");
  const latest = tools[tools.length - 1];
  const label = latest ? toolLabel(latest) : null;
  const failed = tools.some((t) => t.isError);
  const pending = live && latest && latest.result === undefined;
  const summary = pending ? activityText(`Using ${latest.name.replace(/^mcp__.+?__/, "")}`) : label ? label.title : "Thought it through";
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

function ToolStep({ step }: { step: Extract<Step, { type: "tool_use" }> }) {
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
  assistant: {
    gap: 12,
    paddingRight: 8,
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
