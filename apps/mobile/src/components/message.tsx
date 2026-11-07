import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useRecyclingState } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { router } from "expo-router";
import { createContext, Fragment, memo, useContext, useEffect, useMemo } from "react";
import { Alert, LayoutAnimation, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Agent, Attachment, CharacterMood, CompactInfo, Message, MessageBlock } from "@godmode/shared";
import { BABY_FACE_SCALE, babyCharacter, defaultCharacter, isPlaceholderReply, readableModelId, reportPreview, shortenPaths, tokensLabel, toolActivity } from "@godmode/shared";
import { ArtifactCard } from "./artifact-card";
import { AttachmentPictures, isChatPicture } from "./attachment-pictures";
import { Character } from "./character";
import { DelegateCard, HandoffCard, MissingLoginCard, WorkflowCard } from "./chat-cards";
import { FileChip } from "./attachments";
import { CALL_STATUS, callName, openCall } from "./call-parts";
import { Icon, type IconName } from "./icon";
import { Markdown } from "./markdown";
import { McpAppSlots } from "./mcp-app-view";
import { MessageSource } from "./message-source";
import { ModChip } from "./mod-chip";
import { ChatScope, QuestionCard } from "./question-card";
import { RemoteImage } from "./remote-image";
import { MenuSheet, type HeaderMenuItem } from "./header-actions";
import { Row, T, tap } from "./ui";
import { api, errorText } from "@/lib/api";
import { cardKindOf, quoteOf, type CardKind } from "@/lib/chat-blocks";
import { quoteInto } from "@/lib/composer";
import { toolLabel } from "@/lib/format";
import { useChatPrefs, useLightAnimations } from "@/lib/chat-prefs";
import { useNow } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { qk } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";
import { fileEditOf, openToolCall, todoItems } from "@/lib/tool-details";
import { readAloud, stopReading, useReadAloud } from "@/lib/voice-mode";

type Step = Extract<MessageBlock, { type: "tool_use" | "thinking" }>;
type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;
type SubagentEntry = { block: ToolUse; children: MessageBlock[] };
type Part =
  | { kind: "block"; block: MessageBlock }
  | { kind: "steps"; steps: Step[] }
  | { kind: "card"; card: CardKind; block: ToolUse }
  | ({ kind: "subagent" } & SubagentEntry)
  | { kind: "subagents"; entries: SubagentEntry[] };
export type ParentAgent = Pick<Agent, "id" | "color" | "character">;

/** The stored message the steps below belong to: a step's whole output loads from there. */
export const StepSource = createContext<{ conversationId?: string; messageId?: string } | null>(null);

const isSubagent = (block: MessageBlock) => block.type === "tool_use" && (block.name === "Task" || block.name === "Agent");

/** The question card is the record of an ask; the call itself only shows when it failed. */
const ASK_TOOLS = new Set(["ask_human", "request_approval"]);
const isAsk = (block: MessageBlock) => block.type === "tool_use" && !block.isError && ASK_TOOLS.has(block.name.slice(block.name.lastIndexOf("__") + 2));

/**
 * Consecutive tool calls and thinking collapse into one "steps" row; a subagent gets its own card with its work inside,
 * and so do artifacts, handoffs, delegations, workflows and missing logins.
 */
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
    } else if (block.type === "tool_use" && cardKindOf(block.name)) parts.push({ kind: "card", card: cardKindOf(block.name)!, block });
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
export function subagentState(block: ToolUse, streaming: boolean) {
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

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const c = useColors();
  // A turn the human didn't write keeps the neutral surface and says who it came from.
  const started = !!message.source;
  const fg = started ? c.text : c.onPrimary;
  return (
    <View style={[styles.userWrap, started ? { alignItems: "flex-start" } : null]}>
      {started ? <MessageSource message={message} /> : null}
      <UserBubble attachments={message.attachments} text={message.content} conversationId={message.conversationId} background={started ? c.sunken : c.primary} color={fg} />
    </View>
  );
});

/** What the human sent: pictures as thumbnails above the bubble, other files and the text in it. */
function UserBubble({ attachments, text, conversationId, background, color }: { attachments: Attachment[]; text: string; conversationId?: string; background: string; color: string }) {
  const c = useColors();
  const pictures = conversationId ? attachments.filter(isChatPicture) : [];
  const files = pictures.length ? attachments.filter((a) => !pictures.includes(a)) : attachments;
  return (
    <>
      {pictures.length && conversationId ? (
        <View style={{ marginBottom: files.length || text ? 6 : 0 }}>
          <AttachmentPictures
            files={pictures}
            conversationId={conversationId}
            fallback={(f) => (
              <View key={f.path} style={[styles.pictureChip, { backgroundColor: c.sunken }]}>
                <FileChip name={f.name} mime={f.mime} size={f.size} color={c.text} />
              </View>
            )}
          />
        </View>
      ) : null}
      {files.length || text ? (
        <View style={[styles.user, { backgroundColor: background }]}>
          <Files attachments={files} spaced={!!text} color={color} />
          {text ? (
            <T variant="body" color={color} selectable>
              {text}
            </T>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  id,
  runId,
  blocks,
  streaming,
  content,
  agent,
}: {
  id?: string;
  runId?: string | null;
  blocks: MessageBlock[];
  streaming?: boolean;
  content?: string;
  agent?: ParentAgent;
}) {
  // A reply stored without blocks is its text.
  const parts = useMemo(() => group(blocks.length || !content ? withoutCompactCard(blocks) : [{ type: "text", text: content }]), [blocks, content]);
  const last = parts[parts.length - 1];
  const scope = useContext(ChatScope);
  const conversationId = scope?.conversationId;
  const source = useMemo(() => ({ conversationId, messageId: id }), [conversationId, id]);
  return (
    <StepSource.Provider value={source}>
    <View style={styles.assistant}>
      {parts.length === 0 && streaming ? <Thinking /> : null}
      {parts.map((p, i) =>
        p.kind === "steps" ? (
          <Fragment key={i}>
            <Steps steps={p.steps} live={streaming && p === last} />
            <McpAppSlots steps={p.steps} />
          </Fragment>
        ) : p.kind === "card" ? (
          <ToolCard key={p.block.id} kind={p.card} block={p.block} streaming={!!streaming} />
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
      {!streaming && content?.trim() && parts.some((p) => p.kind !== "block" || p.block.type === "text") ? <ReplyActions id={id} runId={runId} text={content} /> : null}
    </View>
    </StepSource.Provider>
  );
});

function ToolCard({ kind, block, streaming }: { kind: CardKind; block: ToolUse; streaming: boolean }) {
  switch (kind) {
    case "artifact":
      return <ArtifactCard block={block} streaming={streaming} />;
    case "handoff":
      return <HandoffCard block={block} streaming={streaming} />;
    case "delegate":
      return <DelegateCard block={block} streaming={streaming} />;
    case "workflow":
      return <WorkflowCard block={block} streaming={streaming} />;
    case "missing-login":
      return <MissingLoginCard block={block} />;
  }
}

/**
 * Long-press selects text, so the whole reply is copied from here, like the desktop's "Copy reply"; in a chat it is also
 * quoted into the message being written.
 */
function ReplyActions({ id, runId, text }: { id?: string; runId?: string | null; text: string }) {
  const scope = useContext(ChatScope);
  return (
    <View style={styles.actions}>
      <CopyReply text={text} />
      {scope && !scope.readOnly ? <QuoteReply text={text} conversationId={scope.conversationId} /> : null}
      <ReadReply reply={id ?? text} text={text} />
      {scope && id && !(scope.readOnly && !runId) ? <ReplyMore id={id} runId={runId} conversationId={scope.conversationId} readOnly={scope.readOnly} /> : null}
    </View>
  );
}

/** Stays out of the way: how the run behind the reply went, and quoting only a part of it. */
function ReplyMore({ id, runId, conversationId, readOnly }: { id: string; runId?: string | null; conversationId: string; readOnly?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [open, setOpen] = useRecyclingState(false, [id]);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("message.moreOnReply")}
        hitSlop={10}
        onPress={() => {
          tap();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.more, pressed && { backgroundColor: c.sunken }]}
      >
        <Icon name="more" size={14} color={c.textFaint} />
      </Pressable>
      {open ? <ReplyMoreSheet id={id} runId={runId} conversationId={conversationId} readOnly={readOnly} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ReplyMoreSheet({ id, runId, conversationId, readOnly, onClose }: { id: string; runId?: string | null; conversationId: string; readOnly?: boolean; onClose: () => void }) {
  const { t } = useTranslation("components");
  const run = useQuery({ queryKey: qk.run(runId ?? ""), queryFn: () => api.runs.get(runId!), enabled: !!runId, staleTime: 5 * 60_000, retry: false });
  const items: HeaderMenuItem[] = readOnly ? [] : [{ icon: "quote", title: t("message.quotePart"), onPress: () => router.push({ pathname: "/reply-text", params: { conversationId, messageId: id } }) }];
  const data = run.data;
  const tokens = data?.usage
    ? t("message.runTokens", { input: tokensLabel(data.usage.inputTokens), output: tokensLabel(data.usage.outputTokens), cached: tokensLabel(data.usage.cacheReadTokens) })
    : null;
  const title = !runId ? undefined : data ? [data.durationMs != null ? duration(data.durationMs) : null, data.model ? readableModelId(data.model) : null].filter(Boolean).join(" · ") : run.isError ? t("message.runFailed") : t("message.runLoading");
  const body = data ? [data.numTurns != null ? t("message.runTurns", { count: data.numTurns }) : null, tokens].filter(Boolean).join(" · ") : undefined;
  return <MenuSheet items={items} title={title} body={body} open onClose={onClose} />;
}

function useFlash(key: string): [boolean, () => void] {
  const [on, setOn] = useRecyclingState(false, [key]);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setOn(false), 1400);
    return () => clearTimeout(timer);
  }, [on, setOn]);
  return [on, () => setOn(true)];
}

function CopyReply({ text }: { text: string }) {
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const [copied, flash] = useFlash(text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t("common:actions.copied") : t("message.copyReply")}
      hitSlop={10}
      onPress={() => {
        void Clipboard.setStringAsync(text);
        tap();
        flash();
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

/** "> the reply" below whatever is being written in this chat's composer. */
function QuoteReply({ text, conversationId }: { text: string; conversationId: string }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [quoted, flash] = useFlash(text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={quoted ? t("message.quoted") : t("message.quoteReply")}
      hitSlop={10}
      onPress={() => {
        quoteInto(conversationId, quoteOf(text));
        tap();
        flash();
      }}
      style={({ pressed }) => [styles.copy, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name={quoted ? "check" : "quote"} size={13} color={quoted ? c.success : c.textFaint} />
      <T variant="caption" color={quoted ? c.success : c.textFaint}>
        {quoted ? t("message.quoted") : t("message.quote")}
      </T>
    </Pressable>
  );
}

/** Reads the reply out, or stops; only with Read replies aloud on in Settings → General and voice on in Settings → Voice. */
function ReadReply({ reply, text }: { reply: string; text: string }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const voice = useSettings().data?.voice;
  const reading = useReadAloud((s) => s.key === reply);
  const on = useChatPrefs((s) => s.readReplies);
  if (!on || !voice?.enabled) return null;
  const label = reading ? t("message.stopReading") : t("message.readAloud");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={() => {
        tap();
        if (reading) stopReading();
        else readAloud(text, voice, reply).catch((err: unknown) => Alert.alert(t("message.readFailed"), errorText(err)));
      }}
      style={({ pressed }) => [styles.copy, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name={reading ? "stop" : "speaker"} size={13} color={reading ? c.text : c.textFaint} />
      <T variant="caption" color={reading ? c.text : c.textFaint}>
        {reading ? t("message.stop") : t("message.read")}
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
  const scope = useContext(ChatScope);
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
          {block.mod ? <ModChip name={block.mod} /> : null}
          <T variant="footnote" muted style={{ flex: 1 }}>
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
          <UserBubble attachments={block.attachments} text={block.text} conversationId={scope?.conversationId} background={c.primary} color={c.onPrimary} />
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
  const now = useNow(30_000);
  return (
    <Pressable accessibilityRole={onPress ? "button" : undefined} disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.marker, pressed && { opacity: 0.6 }]}>
      <View style={[styles.markerLine, { backgroundColor: c.border }]} />
      <View style={{ alignItems: "center", gap: 2, maxWidth: "78%" }}>
        <Row style={{ gap: 6 }}>
          <Icon name={icon} size={11} color={c.textFaint} />
          <T variant="caption" muted style={{ fontWeight: "600" }}>
            {text} · {now - new Date(at).getTime() < 60_000 ? t("message.justNow") : format(new Date(at), t("message.markerDateFormat"), { locale: dateLocale() })}
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

export function SubagentAvatar({ agent, phase, size, seed }: { agent?: ParentAgent; phase: Phase; size: number; seed: string }) {
  const base = agent?.id ?? "agent";
  const character = useMemo(() => babyCharacter(agent?.character ?? defaultCharacter(base)), [agent?.character, base]);
  return <Character character={character} color={agent?.color ?? "violet"} mood={PHASE_MOOD[phase]} size={size} seed={seed} faceScale={BABY_FACE_SCALE} />;
}

export function useSubagentView(block: ToolUse, childBlocks: MessageBlock[], streaming: boolean) {
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

/** A subagent's whole work, step by step, on a sheet of its own. */
export function openSubagent(conversationId: string, id: string) {
  tap();
  router.push({ pathname: "/subagent", params: { conversationId, id } });
}

function SubagentDetail({ id, tools, result, background, running }: { id: string; tools: ToolUse[]; result?: string; background: boolean; running: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const scope = useContext(ChatScope);
  return (
    <Animated.View entering={FadeIn.duration(160)} style={{ gap: 10, paddingTop: 4, paddingBottom: 12, paddingHorizontal: space.md }}>
      {scope && (tools.length || result) ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => openSubagent(scope.conversationId, id)}
          style={({ pressed }) => [styles.transcript, { backgroundColor: c.sunken }, pressed && { opacity: 0.6 }]}
        >
          <Icon name="text" size={12} color={c.textMuted} />
          <T variant="caption" style={{ flex: 1, fontWeight: "500" }}>
            {tools.length > 12 ? t("message.helper.allSteps", { count: tools.length }) : t("message.helper.transcript")}
          </T>
          <Icon name="chevron" size={9} color={c.textFaint} weight="semibold" />
        </Pressable>
      ) : null}
      {tools.slice(-12).map((step, i) => (
        <ToolStep key={step.id ?? i} step={step} />
      ))}
      {tools.length > 12 && !scope ? (
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
      {expanded && <SubagentDetail id={block.id} tools={view.tools} result={view.result} background={background} running={running} />}
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
      {open && <SubagentDetail id={block.id} tools={view.tools} result={view.result} background={background} running={running} />}
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

export function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
      {duration(now - since)}
    </T>
  );
}

export function duration(ms: number): string {
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
  // Settings → General → Tool calls: Compact folds the group into one muted line.
  const compact = useChatPrefs((s) => s.toolCalls === "compact");
  const light = useLightAnimations();

  return (
    <View style={compact ? undefined : [styles.steps, { borderColor: c.border }]}>
      <Pressable
        onPress={() => {
          if (!light) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen((o) => !o);
        }}
        style={compact ? styles.stepsCompact : styles.stepsHeader}
      >
        {compact ? (
          <Icon name={label?.icon ?? "sparkles"} size={12} color={failed ? c.warning : c.textFaint} />
        ) : (
          <View style={[styles.stepIcon, { backgroundColor: c.sunken }]}>
            <Icon name={label?.icon ?? "sparkles"} size={13} color={failed ? c.warning : c.textMuted} />
          </View>
        )}
        <T variant={compact ? "footnote" : "subhead"} muted={compact} numberOfLines={1} style={compact ? { flexShrink: 1 } : { flex: 1, fontWeight: "500" }}>
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
        <Animated.View
          entering={light ? undefined : FadeIn.duration(160)}
          style={compact ? styles.stepsCompactList : { gap: 10, paddingTop: 4, paddingBottom: 10, paddingHorizontal: space.md }}
        >
          {steps.map((s, i) => (s.type === "thinking" ? <ThinkingStep key={i} text={s.text} /> : <ToolStep key={s.id ?? i} step={s} />))}
        </Animated.View>
      )}
    </View>
  );
});

export const ToolStep = memo(function ToolStep({ step }: { step: ToolUse }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const source = useContext(StepSource);
  const label = toolLabel(step);
  const todos = step.name === "TodoWrite" ? todoItems(step.input) : null;
  const pictured = !!step.imageUrl || !!step.image;
  // A screenshot without words is all there is to see of the step.
  const opens = !pictured || !!step.isError || !!step.result?.trim() || !!fileEditOf(step);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        disabled={!opens}
        accessibilityRole={opens ? "button" : undefined}
        onPress={() => {
          tap();
          openToolCall(step, source?.conversationId, source?.messageId);
        }}
        style={({ pressed }) => pressed && { opacity: 0.6 }}
      >
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
    </View>
  );
});

function imageUri(image: string): string {
  if (image.startsWith("data:")) return image;
  const mime = image.startsWith("/9j/") ? "image/jpeg" : image.startsWith("R0lG") ? "image/gif" : image.startsWith("UklG") ? "image/webp" : "image/png";
  return `data:${mime};base64,${image}`;
}

export function ThinkingStep({ text }: { text: string }) {
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

export function Thinking() {
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
  const light = useLightAnimations();
  const v = useSharedValue(0.3);
  useEffect(() => {
    v.value = light ? 1 : withRepeat(withSequence(withTiming(1, { duration: 600 }), withTiming(0.3, { duration: 600 })), -1);
  }, [v, light]);
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
  const light = useLightAnimations();
  const v = useSharedValue(1);
  useEffect(() => {
    v.value = light ? 1 : withRepeat(withSequence(withTiming(0, { duration: 450 }), withTiming(1, { duration: 450 })), -1);
  }, [v, light]);
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
  pictureChip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.xl,
    borderCurve: "continuous",
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
  actions: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 2,
    marginTop: -4,
    marginLeft: -8,
  },
  copy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  more: {
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
  stepsCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 2,
  },
  stepsCompactList: {
    gap: 10,
    paddingTop: 8,
    paddingBottom: 4,
    paddingLeft: 19,
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
  transcript: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.sm,
    borderCurve: "continuous",
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
