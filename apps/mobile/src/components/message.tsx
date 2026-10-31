import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useRecyclingState } from "@shopify/flash-list";
import { format } from "date-fns";
import { memo, useEffect, useMemo } from "react";
import { LayoutAnimation, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Agent, Attachment, CharacterMood, CompactInfo, Message, MessageBlock } from "@godmode/shared";
import { BABY_FACE_SCALE, babyCharacter, defaultCharacter, isPlaceholderReply, readableModelId, reportPreview, shortenPaths, tokensLabel, toolActivity } from "@godmode/shared";
import { Character } from "./character";
import { FileChip } from "./attachments";
import { CALL_STATUS, callName, openCall } from "./call-parts";
import { Icon, type IconName } from "./icon";
import { Markdown } from "./markdown";
import { QuestionCard } from "./question-card";
import { RemoteImage } from "./remote-image";
import { Row, T, tap } from "./ui";
import { toolLabel } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { dateLocale, t as translate } from "@/lib/i18n";
import { radius, space, useColors } from "@/lib/theme";

type Step = Extract<MessageBlock, { type: "tool_use" | "thinking" }>;
type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;
type SubagentEntry = { block: ToolUse; children: MessageBlock[] };
type Part = { kind: "block"; block: MessageBlock } | { kind: "steps"; steps: Step[] } | ({ kind: "subagent" } & SubagentEntry) | { kind: "subagents"; entries: SubagentEntry[] };
type ParentAgent = Pick<Agent, "id" | "color" | "character">;

const isSubagent = (block: MessageBlock) => block.type === "tool_use" && (block.name === "Task" || block.name === "Agent");

/** The question card is the record of an ask; the call itself only shows when it failed. */
const ASK_TOOLS = new Set(["ask_human", "request_approval"]);
const isAsk = (block: MessageBlock) => block.type === "tool_use" && !block.isError && ASK_TOOLS.has(block.name.slice(block.name.lastIndexOf("__") + 2));

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
    if (block.type === "text" && isPlaceholderReply(block.text)) continue;
    if (isAsk(block)) continue;
    if (block.type === "tool_use" && isSubagent(block)) {
      const entry = { block, children: children.get(block.id) ?? [] };
      const last = parts[parts.length - 1];
      if (last?.kind === "subagents") last.entries.push(entry);
      else if (last?.kind === "subagent") parts[parts.length - 1] = { kind: "subagents", entries: [{ block: last.block, children: last.children }, entry] };
      else parts.push({ kind: "subagent", ...entry });
    }
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
  const phase: Phase = running ? "running" : failed ? "failed" : status === "stopped" ? "stopped" : "done";
  return { task, background, status, running, failed, result, phase };
}

type Phase = "running" | "done" | "failed" | "stopped";

const PHASE_MOOD: Record<Phase, CharacterMood> = { running: "working", done: "happy", failed: "error", stopped: "sleeping" };

/** The compression divider already says what /compact did. */
function withoutCompactCard(blocks: MessageBlock[]): MessageBlock[] {
  if (!blocks.some((b) => b.type === "notice" && b.compacted)) return blocks;
  return blocks.filter((b) => !(b.type === "command" && b.name === "compact"));
}

const SOURCE_CAPTION = { automation: "message.source.automation", delegation: "message.source.delegation", task: "message.source.task", offer: "message.source.offer" } as const;

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const c = useColors();
  const { t } = useTranslation("components");
  // A turn the human didn't write keeps the neutral surface and says who it came from.
  const caption = message.source ? t(SOURCE_CAPTION[message.source]) : null;
  const fg = caption ? c.text : c.onPrimary;
  return (
    <View style={[styles.userWrap, caption ? { alignItems: "flex-start" } : null]}>
      {caption ? (
        <T variant="caption" muted style={{ marginBottom: 4 }}>
          {caption}
        </T>
      ) : null}
      <View style={[styles.user, { backgroundColor: caption ? c.sunken : c.primary }]}>
        <Files attachments={message.attachments} spaced={!!message.content} color={fg} />
        {message.content ? (
          <T variant="body" color={fg} selectable>
            {message.content}
          </T>
        ) : null}
      </View>
    </View>
  );
});

export const AssistantMessage = memo(function AssistantMessage({ blocks, streaming, content, agent }: { blocks: MessageBlock[]; streaming?: boolean; content?: string; agent?: ParentAgent }) {
  // A reply stored without blocks is its text.
  const parts = useMemo(() => group(blocks.length || !content ? withoutCompactCard(blocks) : [{ type: "text", text: content }]), [blocks, content]);
  const last = parts[parts.length - 1];
  return (
    <View style={styles.assistant}>
      {parts.length === 0 && streaming ? <Thinking /> : null}
      {parts.map((p, i) =>
        p.kind === "steps" ? (
          <Steps key={i} steps={p.steps} live={streaming && p === last} />
        ) : p.kind === "subagent" ? (
          <SubagentCard key={p.block.id} block={p.block} childBlocks={p.children} streaming={!!streaming} agent={agent} />
        ) : p.kind === "subagents" ? (
          <SubagentGroup key={p.entries[0]!.block.id} entries={p.entries} streaming={!!streaming} agent={agent} />
        ) : (
          <Block key={i} block={p.block} streaming={!!streaming} />
        ),
      )}
      {streaming ? <BackgroundAgents parts={parts} agent={agent} /> : null}
      {streaming && last?.kind === "block" && last.block.type === "text" ? <Caret /> : null}
      {!streaming && content?.trim() && parts.some((p) => p.kind !== "block" || p.block.type === "text") ? <CopyReply text={content} /> : null}
    </View>
  );
});

/** Long-press selects text, so the whole reply is copied from here, like the desktop's "Copy reply". */
function CopyReply({ text }: { text: string }) {
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const [copied, setCopied] = useRecyclingState(false, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied, setCopied]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t("common:actions.copied") : t("message.copyReply")}
      hitSlop={10}
      onPress={() => {
        void Clipboard.setStringAsync(text);
        tap();
        setCopied(true);
      }}
      style={({ pressed }) => [styles.copy, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name={copied ? "check" : "copy"} size={13} color={copied ? c.success : c.textFaint} />
      <T variant="caption" color={copied ? c.success : c.textFaint}>
        {copied ? t("common:actions.copied") : t("common:actions.copy")}
      </T>
    </Pressable>
  );
}

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

const RETRY_CAUSES = ["restart", "offline", "error", "background"] as const;

const Block = memo(function Block({ block, streaming }: { block: MessageBlock; streaming: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
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
      if (block.compacted) return <CompactedDivider info={block.compacted} />;
      return (
        <View style={[styles.callout, { backgroundColor: block.level === "warning" ? c.warningSoft : block.level === "success" ? c.successSoft : c.sunken }]}>
          <Icon
            name={block.level === "warning" ? "warning" : block.level === "success" ? "check" : "bolt"}
            size={14}
            color={block.level === "warning" ? c.warning : block.level === "success" ? c.success : c.textMuted}
          />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {block.mod ? (
              <T variant="footnote" style={{ fontWeight: "600" }}>
                {block.mod}{" "}
              </T>
            ) : null}
            {block.text}
          </T>
        </View>
      );
    case "followup":
      return (
        <Marker
          icon="clock"
          text={block.reason === "now" ? t("message.followup.now") : block.reason === "late" ? t("message.followup.late") : t("message.followup.onTime")}
          detail={block.note}
          at={block.dueAt}
        />
      );
    case "retry": {
      const cause = RETRY_CAUSES.find((x) => x === (block.cause ?? "restart")) ?? "restart";
      const mode = block.mode === "continue" || block.mode === "again" ? block.mode : null;
      return (
        <Marker
          icon={block.mode === "continue" ? "play" : "refresh"}
          text={
            block.auto
              ? mode
                ? t(`message.retry.${cause}.${mode}`)
                : t("message.retry.pickedUpAgain")
              : block.mode === "continue"
                ? t("message.retry.continuedWhereStopped")
                : t("message.retry.triedAgain")
          }
          detail={block.masked ? t("message.retry.secretsMasked") : undefined}
          at={block.at}
        />
      );
    }
    case "moved":
      return <Marker icon="move" text={t("message.moved", { from: block.from, to: block.to })} detail={block.continued ? t("message.continuedThere") : undefined} at={block.at} />;
    case "call": {
      const name = callName({ contactName: block.contactName, number: block.number, direction: "outbound" });
      const status = block.status !== "done" && CALL_STATUS[block.status] ? t(`callParts.status.${block.status}`) : null;
      return (
        <Marker
          icon="call"
          text={block.status === "done" ? t("message.callEnded", { name }) : t("message.callEndedStatus", { name, status: status ?? "" })}
          detail={block.outcome || block.summary}
          at={block.at}
          onPress={() => openCall(block.callId)}
        />
      );
    }
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
          <T variant="caption" muted style={{ marginTop: 4, marginRight: 4 }}>
            {Number.isNaN(new Date(block.sentAt).getTime())
              ? t("message.pickedUpMidTask")
              : t("message.pickedUpMidTaskSent", { time: format(new Date(block.sentAt), "p", { locale: dateLocale() }) })}
          </T>
        </View>
      );
    case "question":
      return <QuestionCard question={block} streaming={streaming} />;
    case "human_task": {
      const done = block.outcome === "done";
      return (
        <View style={[styles.callout, { backgroundColor: c.sunken, alignItems: "flex-start" }]}>
          <Icon name={done ? "check" : "close"} size={14} color={c.textMuted} style={{ marginTop: 2 }} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {done ? t("message.humanTaskDone", { number: block.number, title: block.title }) : t("message.humanTaskNotDone", { number: block.number, title: block.title })}
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
      const limit = block.reason === "limit";
      const what = limit ? t("message.limitReached", { limit: block.limit ?? t("message.usageLimit") }) : t("message.paused");
      return (
        <View style={[styles.callout, { backgroundColor: limit ? c.warningSoft : c.sunken }]}>
          <Icon name={limit ? "clock" : "pause"} size={14} color={limit ? c.warning : c.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {what.charAt(0).toUpperCase() + what.slice(1)}
            {block.resumedAt ? ` · ${t("message.continued")}` : ""}
          </T>
        </View>
      );
    }
    default:
      return null;
  }
});

/**
 * Where the chat went on without the human: a follow-up the agent set, a turn that was picked up again, a move to
 * another computer, or a call that ended (it opens the call).
 */
function Marker({ icon, text, detail, at, onPress }: { icon: IconName; text: string; detail?: string; at: string; onPress?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <Pressable accessibilityRole={onPress ? "button" : undefined} disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.marker, pressed && { opacity: 0.6 }]}>
      <View style={[styles.markerLine, { backgroundColor: c.border }]} />
      <View style={{ alignItems: "center", gap: 2, maxWidth: "78%" }}>
        <Row style={{ gap: 6 }}>
          <Icon name={icon} size={11} color={c.textFaint} />
          <T variant="caption" muted style={{ fontWeight: "600" }}>
            {text} · {Date.now() - new Date(at).getTime() < 60_000 ? t("message.justNow") : format(new Date(at), t("message.markerDateFormat"), { locale: dateLocale() })}
          </T>
          {onPress ? <Icon name="chevron" size={9} color={c.textFaint} weight="semibold" /> : null}
        </Row>
        {detail ? (
          <T variant="caption" muted numberOfLines={2} style={{ textAlign: "center" }}>
            {detail}
          </T>
        ) : null}
      </View>
      <View style={[styles.markerLine, { backgroundColor: c.border }]} />
    </Pressable>
  );
}

function SubagentAvatar({ agent, phase, size, seed }: { agent?: ParentAgent; phase: Phase; size: number; seed: string }) {
  const base = agent?.id ?? "agent";
  const character = useMemo(() => babyCharacter(agent?.character ?? defaultCharacter(base)), [agent?.character, base]);
  return <Character character={character} color={agent?.color ?? "violet"} mood={PHASE_MOOD[phase]} size={size} seed={seed} faceScale={BABY_FACE_SCALE} />;
}

function useSubagentView(block: ToolUse, childBlocks: MessageBlock[], streaming: boolean) {
  const { t } = useTranslation("components");
  const state = subagentState(block, streaming);
  const { task, phase, result } = state;
  const input = (block.input && typeof block.input === "object" ? block.input : {}) as { description?: unknown; subagent_type?: unknown; model?: unknown };
  const title = (typeof input.description === "string" && input.description) || task?.description || t("message.helper.helper");
  const type = typeof input.subagent_type === "string" && input.subagent_type !== "general-purpose" ? input.subagent_type : null;
  const model = task?.model ?? (typeof input.model === "string" ? input.model : null);
  const tools = childBlocks.filter((b): b is ToolUse => b.type === "tool_use");
  const steps = Math.max(tools.length, task?.toolUses ?? 0);
  const preview = result ? reportPreview(result) : "";
  const status =
    phase === "running"
      ? shortenPaths(task?.activity ?? "") || t("message.helper.working")
      : phase === "failed"
        ? preview || t("message.helper.failed")
        : phase === "stopped"
          ? t("message.helper.stopped")
          : preview || t("message.helper.done");
  const stats = [steps > 0 ? t("message.steps", { count: steps }) : null, task?.totalTokens ? tokensLabel(task.totalTokens) : null, model ? readableModelId(model) : null].filter(
    (x): x is string => !!x,
  );
  return { ...state, title, type, tools, status, stats };
}

function SubagentDetail({ tools, result, background, running }: { tools: ToolUse[]; result?: string; background: boolean; running: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <Animated.View entering={FadeIn.duration(160)} style={{ gap: 10, paddingTop: 4, paddingBottom: 12, paddingHorizontal: space.md }}>
      {tools.slice(-12).map((step, i) => (
        <ToolStep key={step.id ?? i} step={step} />
      ))}
      {tools.length > 12 ? (
        <T variant="caption" muted>
          {t("message.earlierSteps", { count: tools.length - 12 })}
        </T>
      ) : null}
      {result ? (
        <View style={[styles.report, { backgroundColor: c.sunken }]}>
          <T variant="eyebrow" muted>
            {background ? t("message.helper.report") : t("message.helper.result")}
          </T>
          <Markdown text={result.length > 6000 ? `${result.slice(0, 6000)}…` : result} />
        </View>
      ) : running && !tools.length ? (
        <Thinking />
      ) : null}
    </Animated.View>
  );
}

const SubagentCard = memo(function SubagentCard({ block, childBlocks, streaming, agent }: { block: ToolUse; childBlocks: MessageBlock[]; streaming: boolean; agent?: ParentAgent }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const view = useSubagentView(block, childBlocks, streaming);
  const { task, background, running, failed, phase } = view;
  const [open, setOpen] = useRecyclingState<boolean | null>(null, [block.id]);
  const expanded = open ?? false;
  const meta = [background ? t("message.helper.background") : t("message.helper.helper"), view.type, view.status, ...view.stats, !running && task?.durationMs ? duration(task.durationMs) : null]
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
        <SubagentAvatar agent={agent} phase={phase} size={30} seed={block.id} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "500" }}>
            {view.title}
          </T>
          <T variant="caption" muted numberOfLines={1} color={failed ? c.danger : undefined}>
            {meta}
          </T>
        </View>
        {running && task?.startedAt ? <Elapsed since={task.startedAt} /> : null}
        <Icon name="down" size={11} color={c.textFaint} style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }} />
      </Pressable>
      {expanded && <SubagentDetail tools={view.tools} result={view.result} background={background} running={running} />}
    </View>
  );
});

function SubagentRow({ entry, streaming, agent }: { entry: SubagentEntry; streaming: boolean; agent?: ParentAgent }) {
  const c = useColors();
  const { block, children } = entry;
  const view = useSubagentView(block, children, streaming);
  const { task, background, running, failed, phase } = view;
  const [open, setOpen] = useRecyclingState(false, [block.id]);
  const meta = [view.type, view.status].filter(Boolean).join(" · ");

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen(!open);
        }}
        style={styles.subagentRow}
      >
        <SubagentAvatar agent={agent} phase={phase} size={24} seed={block.id} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="footnote" numberOfLines={1} style={{ fontWeight: "500" }}>
            {view.title}
          </T>
          <T variant="caption" muted numberOfLines={1} color={failed ? c.danger : undefined}>
            {meta}
          </T>
        </View>
        <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
          {running && task?.startedAt ? null : task?.durationMs ? duration(task.durationMs) : null}
        </T>
        {running && task?.startedAt ? <Elapsed since={task.startedAt} /> : null}
        <Icon name="down" size={10} color={c.textFaint} style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} />
      </Pressable>
      {open && <SubagentDetail tools={view.tools} result={view.result} background={background} running={running} />}
    </View>
  );
}

function AvatarStack({ blocks, agent, size, streaming }: { blocks: ToolUse[]; agent?: ParentAgent; size: number; streaming: boolean }) {
  const c = useColors();
  const shown = blocks.slice(0, 4);
  return (
    <View style={{ flexDirection: "row" }}>
      {shown.map((b, i) => (
        <View key={b.id} style={{ marginLeft: i > 0 ? -size / 3 : 0, zIndex: shown.length - i, borderRadius: size, backgroundColor: c.surface }}>
          <SubagentAvatar agent={agent} phase={subagentState(b, streaming).phase} size={size} seed={b.id} />
        </View>
      ))}
    </View>
  );
}

const SubagentGroup = memo(function SubagentGroup({ entries, streaming, agent }: { entries: SubagentEntry[]; streaming: boolean; agent?: ParentAgent }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const states = entries.map((e) => subagentState(e.block, streaming));
  const count = (phase: Phase) => states.filter((s) => s.phase === phase).length;
  const working = count("running");
  const anyFailed = count("failed") > 0;
  const summary = (["running", "done", "failed", "stopped"] as const)
    .filter((phase) => count(phase) > 0)
    .map((phase) => t(`message.subagents.${phase}`, { count: count(phase) }))
    .join(" · ");

  return (
    <View style={[styles.steps, { borderColor: working > 0 ? c.brand : anyFailed ? c.danger : c.border }]}>
      <View style={styles.stepsHeader}>
        <AvatarStack blocks={entries.map((e) => e.block)} agent={agent} size={26} streaming={streaming} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "500" }}>
            {t("message.subagents.helpers", { count: entries.length })}
          </T>
          <T variant="caption" muted numberOfLines={1}>
            {summary}
          </T>
        </View>
      </View>
      {working > 0 ? (
        <View style={[styles.progressTrack, { backgroundColor: c.border }]}>
          <View style={[styles.progressFill, { backgroundColor: c.brand, width: `${((entries.length - working) / entries.length) * 100}%` }]} />
        </View>
      ) : null}
      <View style={{ paddingVertical: 4 }}>
        {entries.map((e) => (
          <SubagentRow key={e.block.id} entry={e} streaming={streaming} agent={agent} />
        ))}
      </View>
    </View>
  );
});

function BackgroundAgents({ parts, agent }: { parts: Part[]; agent?: ParentAgent }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const entries = parts.flatMap((p) => (p.kind === "subagent" ? [p.block] : p.kind === "subagents" ? p.entries.map((e) => e.block) : []));
  const working = entries.filter((b) => {
    const s = subagentState(b, true);
    return s.background && s.running;
  });
  const last = parts[parts.length - 1];
  const inLast = last?.kind === "subagent" ? [last.block] : last?.kind === "subagents" ? last.entries.map((e) => e.block) : [];
  if (!working.length || working.every((b) => inLast.includes(b))) return null;
  return (
    <Animated.View entering={FadeIn.duration(200)} style={[styles.background, { borderColor: c.border }]}>
      <AvatarStack blocks={working} agent={agent} size={20} streaming />
      <T variant="footnote" muted style={{ flex: 1 }}>
        {t("message.helpersInBackground", { count: working.length })}
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

const Steps = memo(function Steps({ steps, live }: { steps: Step[]; live?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [open, setOpen] = useRecyclingState(false, [steps.find((s) => s.type === "tool_use")?.id ?? (steps[0]?.type === "thinking" ? steps[0].text.slice(0, 40) : "")]);
  const tools = steps.filter((s): s is Extract<Step, { type: "tool_use" }> => s.type === "tool_use");
  const latest = tools[tools.length - 1];
  const label = latest ? toolLabel(latest) : null;
  const failed = tools.some((x) => x.isError);
  const pending = live && latest && latest.result === undefined;
  const summary = pending ? toolActivity(latest.name, latest.input).replace(/…$/, "") : label ? label.title : t("message.thoughtItThrough");
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
            {t("message.steps", { count })}
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
});

const ToolStep = memo(function ToolStep({ step }: { step: ToolUse }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const label = toolLabel(step);
  const [more, setMore] = useRecyclingState(false, [step.id]);
  const todos = step.name === "TodoWrite" ? todoItems(step.input) : null;
  const edit = more ? fileEdit(step) : null;
  const expandable = !!step.result || step.name === "Edit" || step.name === "MultiEdit" || step.name === "Write";
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => expandable && setMore((m) => !m)} accessibilityRole={expandable ? "button" : undefined} accessibilityState={expandable ? { expanded: more } : undefined}>
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
      {todos?.length ? (
        <View style={{ gap: 4, paddingLeft: 21 }}>
          {todos.slice(0, 12).map((t, i) => (
            <Row key={i} style={{ gap: 8, alignItems: "flex-start" }}>
              <Icon
                name={t.status === "completed" ? "check" : t.status === "in_progress" ? "play" : "minus"}
                size={10}
                color={t.status === "completed" ? c.brandStrong : t.status === "in_progress" ? c.text : c.textFaint}
                weight="bold"
                style={{ marginTop: 4 }}
              />
              <T
                variant="footnote"
                muted={t.status !== "in_progress"}
                style={[{ flex: 1 }, t.status === "completed" && { textDecorationLine: "line-through" }, t.status === "in_progress" && { fontWeight: "600" }]}
              >
                {t.content}
              </T>
            </Row>
          ))}
        </View>
      ) : null}
      {step.imageUrl ? (
        <RemoteImage path={step.imageUrl} alt={t("message.screenshot")} />
      ) : step.image ? (
        <Image source={{ uri: imageUri(step.image) }} style={[styles.shot, { backgroundColor: c.sunken }]} contentFit="contain" cachePolicy="none" />
      ) : null}
      {edit ? (
        <View style={[styles.result, { backgroundColor: c.sunken, gap: 1 }]}>
          {edit.lines.map((line, i) => (
            <T key={i} variant="mono" numberOfLines={1} color={line.kind === "add" ? c.brandStrong : line.kind === "remove" ? c.danger : c.textFaint} style={{ fontSize: 12 }}>
              {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
              {line.text}
            </T>
          ))}
        </View>
      ) : more && step.result ? (
        <T variant="mono" muted numberOfLines={16} style={[styles.result, { backgroundColor: c.sunken }]}>
          {step.result.slice(0, 2000)}
          {step.resultTruncated || step.result.length > 2000 ? "…" : ""}
        </T>
      ) : null}
    </View>
  );
});

function imageUri(image: string): string {
  if (image.startsWith("data:")) return image;
  const mime = image.startsWith("/9j/") ? "image/jpeg" : image.startsWith("R0lG") ? "image/gif" : image.startsWith("UklG") ? "image/webp" : "image/png";
  return `data:${mime};base64,${image}`;
}

/** Plan items of a TodoWrite call. */
function todoItems(input: unknown): { content: string; status: string }[] | null {
  const todos = input && typeof input === "object" ? (input as { todos?: unknown }).todos : null;
  if (!Array.isArray(todos)) return null;
  return todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ content: String(t.content ?? t.activeForm ?? t.subject ?? ""), status: typeof t.status === "string" ? t.status : "pending" }));
}

type DiffLine = { kind: "add" | "remove" | "fold"; text: string };

const DIFF_LINES = 40;

/** What a file edit took out and put in, as the first lines of each: enough to see the change on a phone. */
function fileEdit(step: ToolUse): { lines: DiffLine[] } | null {
  const input = (step.input && typeof step.input === "object" ? step.input : {}) as { old_string?: unknown; new_string?: unknown; content?: unknown; edits?: unknown };
  const lines: DiffLine[] = [];
  const push = (kind: "add" | "remove", text: unknown) => {
    if (typeof text !== "string" || !text) return;
    for (const line of text.split("\n")) lines.push({ kind, text: line });
  };
  if (step.name === "Edit") {
    push("remove", input.old_string);
    push("add", input.new_string);
  } else if (step.name === "Write") push("add", input.content);
  else if (step.name === "MultiEdit" && Array.isArray(input.edits)) {
    for (const [i, e] of (input.edits as { old_string?: unknown; new_string?: unknown }[]).entries()) {
      if (i > 0) lines.push({ kind: "fold", text: "⋯" });
      push("remove", e?.old_string);
      push("add", e?.new_string);
    }
  } else return null;
  if (!lines.length) return null;
  const more = lines.length - DIFF_LINES;
  return { lines: more > 0 ? [...lines.slice(0, DIFF_LINES), { kind: "fold", text: `⋯ ${translate("components:message.moreLines", { count: more })}` }] : lines };
}

function ThinkingStep({ text }: { text: string }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <Row style={{ gap: 8, alignItems: "flex-start" }}>
      <Icon name="sparkles" size={13} color={c.dream} style={{ marginTop: 3 }} />
      <T variant="footnote" muted style={{ flex: 1, fontStyle: "italic" }} numberOfLines={8}>
        {text.trim() || t("message.thinkingStep")}
      </T>
    </Row>
  );
}

function Thinking() {
  const { t } = useTranslation("components");
  return (
    <Row style={{ gap: 8 }}>
      <Spinner />
      <T variant="subhead" muted>
        {t("message.thinking")}
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
  copy: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    marginTop: -4,
    marginLeft: -8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  question: {
    gap: 6,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  compacted: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  compactedLine: { flex: 1, height: StyleSheet.hairlineWidth },
  compactedPill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
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
  subagentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  progressTrack: {
    height: 2,
    marginHorizontal: space.md,
    borderRadius: 1,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 1,
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
  marker: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 2,
  },
  markerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
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

/** Where the chat was summarized: a quiet divider, earlier messages stay readable above it. */
function CompactedDivider({ info }: { info: CompactInfo }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const sizes = info.preTokens !== null && info.postTokens !== null ? ` · ${tokensLabel(info.preTokens)} → ${tokensLabel(info.postTokens)}` : "";
  return (
    <View style={styles.compacted} accessibilityRole="text">
      <View style={[styles.compactedLine, { backgroundColor: c.border }]} />
      <View style={[styles.compactedPill, { borderColor: c.border, backgroundColor: c.surface }]}>
        <Icon name="layers" size={12} color={c.success} />
        <T variant="caption" muted>
          <T variant="caption" style={{ fontWeight: "600" }}>
            {info.auto ? t("message.compressedAuto") : t("message.compressed")}
          </T>
          {sizes}
        </T>
      </View>
      <View style={[styles.compactedLine, { backgroundColor: c.border }]} />
    </View>
  );
}
