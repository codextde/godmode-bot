import { useRecyclingState } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useContext, useState } from "react";
import { ActivityIndicator, Alert, LayoutAnimation, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn } from "react-native-reanimated";
import type { CharacterMood, MessageBlock, Run, ToolTaskAgent } from "@godmode/shared";
import { readableModelId, tokensLabel } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { useFullAccess } from "./full-access";
import { Icon } from "./icon";
import { Markdown } from "./markdown";
import { ChatScope } from "./question-card";
import { Badge, LiveDot, T, tap } from "./ui";
import { api, errorText } from "@/lib/api";
import { agentAnswerOf, delegationOf, handoffChatOf } from "@/lib/chat-blocks";
import { useAgents } from "@/lib/hooks";
import { useChatRun, useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;

function openChat(id: string) {
  tap();
  router.push({ pathname: "/chat/[id]", params: { id } });
}

function toggle(set: (fn: (open: boolean) => boolean) => void) {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  set((open) => !open);
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/* Handoff */

/** Where the agent went on in a fresh chat: opens it. */
export function HandoffCard({ block, streaming }: { block: ToolUse; streaming: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const input = (block.input ?? {}) as { title?: unknown };
  const id = handoffChatOf(block);
  const pending = streaming && block.result === undefined && !block.isError;
  const failed = !!block.isError;
  const title = (typeof input.title === "string" && input.title) || t("chatCards.handoff.newChat");
  const open = id ? () => openChat(id) : undefined;
  return (
    <Animated.View entering={FadeIn.duration(180)}>
      <Pressable
        accessibilityRole={open ? "button" : undefined}
        accessibilityLabel={title}
        disabled={!open}
        onPress={open}
        style={({ pressed }) => [styles.link, { backgroundColor: c.surface, borderColor: failed ? c.danger : c.border }, pressed && { backgroundColor: c.sunken }]}
      >
        <View style={[styles.tile, { backgroundColor: c.brandSoft }]}>
          {pending ? <ActivityIndicator size="small" color={c.brandStrong} /> : <Icon name="handoff" size={19} color={c.brandStrong} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: 15 }}>
            {title}
          </T>
          <T variant="footnote" color={failed ? c.danger : c.textMuted} numberOfLines={2}>
            {failed ? block.result || t("chatCards.handoff.failed") : pending ? t("chatCards.handoff.starting") : t("chatCards.handoff.continued")}
          </T>
        </View>
        {open ? <Icon name="chevron" size={13} color={c.textFaint} /> : null}
      </Pressable>
    </Animated.View>
  );
}

/* Delegation */

/**
 * The run a delegation started. Its result names it; while the delegating run still waits for it, it is the run this
 * chat's run handed over to that agent with that task (only its own runs are candidates).
 */
function useHandedOverRun(block: ToolUse, streaming: boolean, agentId: string | undefined, task: string | undefined) {
  const scope = useContext(ChatScope);
  const chatRun = useChatRun(scope?.conversationId ?? "");
  const named = delegationOf(block.result);
  const refused = !!block.isError && !named;
  const parentRunId = !named && !refused && streaming && agentId ? chatRun?.id : undefined;
  const wanted = task?.trim();
  const matches = (r: Run) => r.parentRunId === parentRunId && r.agentId === agentId && (!wanted || r.prompt.trimEnd().endsWith(wanted));
  const children = useQuery({
    queryKey: [...qk.runs, "children", parentRunId ?? ""],
    queryFn: () => api.runs.list({ parentRunId, limit: 100 }),
    enabled: !!parentRunId,
    staleTime: 5_000,
  });
  const listed = parentRunId ? children.data?.find(matches) : undefined;
  const live = useLive((s) => {
    if (named) return s.runs[named.runId];
    if (!parentRunId) return undefined;
    return Object.values(s.runs).find((r) => matches(r.run));
  });
  const runId = named?.runId ?? live?.run.id ?? listed?.id;
  const detail = useQuery({ queryKey: qk.run(runId ?? ""), queryFn: () => api.runs.get(runId!), enabled: !!named, staleTime: 15_000 });
  const run = live?.run ?? detail.data ?? listed;
  return { runId, conversationId: named?.conversationId ?? run?.conversationId, run, activity: live?.activity ?? null, refused };
}

type Tone = "live" | "muted" | "success" | "warning" | "danger";

/** A task this agent handed to another one: who, what, how it goes; opens that agent's chat and stops it while it works. */
export function DelegateCard({ block, streaming }: { block: ToolUse; streaming: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const input = (block.input ?? {}) as { agentId?: string; task?: string; wait?: boolean };
  const { byId } = useAgents();
  const agent = input.agentId ? byId.get(input.agentId) : undefined;
  const { runId, conversationId, run, activity, refused } = useHandedOverRun(block, streaming, input.agentId, input.task);
  const [open, setOpen] = useRecyclingState(false, [block.id]);
  const [stopping, setStopping] = useState(false);
  const status = run?.status;
  const working = status === "running" || status === "queued";
  const pending = streaming && block.result === undefined && !block.isError;
  const result = block.result ?? "";

  const state: { text: string; tone: Tone } | null = refused
    ? { text: t("chatCards.delegate.refused"), tone: "danger" }
    : status === "running"
      ? { text: activity && activity !== "Starting…" ? activity : t("chatCards.delegate.working"), tone: "live" }
      : status === "queued"
        ? { text: t("chatCards.delegate.queued"), tone: "muted" }
        : status === "paused"
          ? { text: t("chatCards.delegate.paused"), tone: "warning" }
          : status === "succeeded"
            ? { text: t("chatCards.delegate.done"), tone: "success" }
            : status === "failed"
              ? { text: t("chatCards.delegate.failed"), tone: "danger" }
              : status === "cancelled"
                ? { text: t("chatCards.delegate.stopped"), tone: "muted" }
                : pending
                  ? { text: t("chatCards.delegate.handingOver"), tone: "live" }
                  : block.isError
                    ? { text: t("chatCards.delegate.failed"), tone: "danger" }
                    : block.result !== undefined
                      ? { text: input.wait === false ? t("chatCards.delegate.handedOver") : t("chatCards.delegate.done"), tone: "success" }
                      : null;
  const toneColor = state?.tone === "success" ? c.success : state?.tone === "danger" ? c.danger : state?.tone === "warning" ? c.warning : c.textMuted;
  const mood: CharacterMood = state?.tone === "live" ? "working" : state?.tone === "danger" ? "error" : state?.tone === "success" ? "happy" : "idle";
  const name = agent?.name ?? t("chatCards.delegate.anotherAgent");
  // Waiting for it, the call's result is its answer; handed over without waiting, the answer is the run's own.
  const answer = block.isError ? result : input.wait === false ? (status === "succeeded" ? (run?.result ?? "") : "") : result ? agentAnswerOf(result) : "";
  const failed = state?.tone === "danger";

  const stop = async () => {
    if (!runId || stopping) return;
    tap();
    setStopping(true);
    try {
      await api.runs.cancel(runId);
    } catch (err) {
      Alert.alert(t("chatCards.delegate.stopFailed"), errorText(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <Animated.View entering={FadeIn.duration(180)} style={[styles.box, { borderColor: failed ? c.danger : state?.tone === "live" ? c.brand : c.border }]}>
      <Pressable
        accessibilityRole={conversationId ? "button" : undefined}
        accessibilityLabel={`${t("chatCards.delegate.handedTo")} ${name}`}
        accessibilityHint={conversationId ? t("chatCards.delegate.openChat") : undefined}
        disabled={!conversationId}
        onPress={conversationId ? () => openChat(conversationId) : undefined}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.sunken }]}
      >
        <CharacterAvatar agent={agent} size={30} mood={mood} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="subhead" numberOfLines={1} muted>
            {t("chatCards.delegate.handedTo")}{" "}
            <T variant="subhead" style={{ fontWeight: "500" }}>
              {name}
            </T>
          </T>
          {state ? (
            <View style={styles.status}>
              {state.tone === "live" ? <LiveDot size={6} /> : state.tone === "success" ? <Icon name="check" size={10} color={c.success} weight="bold" /> : null}
              <T variant="caption" color={toneColor} numberOfLines={1} style={{ flexShrink: 1 }}>
                {state.text}
              </T>
            </View>
          ) : null}
        </View>
        {conversationId ? <Icon name="chevron" size={11} color={c.textFaint} weight="semibold" /> : null}
      </Pressable>
      {input.task ? (
        <T variant="footnote" muted numberOfLines={3} style={styles.task}>
          {input.task}
        </T>
      ) : null}
      {answer || (working && runId) ? (
        <View style={[styles.foot, { borderTopColor: c.border }]}>
          {answer ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => toggle(setOpen)} hitSlop={6} style={styles.footToggle}>
              <Icon name="chevron" size={10} color={c.textMuted} weight="semibold" style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }} />
              <T variant="caption" muted numberOfLines={1} style={{ fontWeight: "500", flexShrink: 1 }}>
                {block.isError ? t("chatCards.delegate.whatWentWrong") : agent ? t("chatCards.delegate.resultOf", { name: agent.name }) : t("chatCards.delegate.result")}
              </T>
            </Pressable>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {working && runId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chatCards.delegate.stopPart", { name })}
              disabled={stopping}
              onPress={() => void stop()}
              hitSlop={8}
              style={({ pressed }) => [styles.chip, { backgroundColor: c.sunken }, pressed && { opacity: 0.6 }]}
            >
              {stopping ? <ActivityIndicator size="small" color={c.textMuted} style={{ transform: [{ scale: 0.7 }] }} /> : <Icon name="stop" size={9} color={c.text} />}
              <T variant="caption" style={{ fontWeight: "500" }}>
                {t("common:actions.stop")}
              </T>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {open && answer ? (
        <Animated.View entering={FadeIn.duration(160)} style={styles.answer}>
          {block.isError ? (
            <T variant="mono" color={c.danger} selectable style={{ fontSize: 12 }}>
              {answer}
            </T>
          ) : (
            <Markdown text={answer.length > 8000 ? `${answer.slice(0, 8000)}…` : answer} />
          )}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/* Workflow */

/** Agents of a workflow by phase, phases in the order their first agent was queued. */
function agentPhases(agents: ToolTaskAgent[]): { phase: string; agents: ToolTaskAgent[] }[] {
  const phases = new Map<string, ToolTaskAgent[]>();
  for (const a of agents) phases.set(a.phase, [...(phases.get(a.phase) ?? []), a]);
  return Array.from(phases, ([phase, list]) => ({ phase, agents: list }));
}

function WorkflowAgent({ agent, live }: { agent: ToolTaskAgent; live: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  // An agent still queued or running when its workflow ended never finished.
  const running = live && agent.state === "running";
  const label = live || agent.state === "done" || agent.state === "failed" ? t(`chatCards.workflow.agent.${agent.state}`) : t("chatCards.workflow.notFinished");
  return (
    <View style={styles.agentRow} accessible accessibilityLabel={`${agent.label}, ${label}`}>
      <View style={styles.glyph}>
        {agent.state === "done" ? (
          <View style={[styles.doneDot, { backgroundColor: c.brand }]}>
            <Icon name="check" size={8} color={c.onPrimary} weight="bold" />
          </View>
        ) : agent.state === "failed" ? (
          <Icon name="closeCircle" size={14} color={c.danger} />
        ) : running ? (
          <LiveDot size={8} />
        ) : (
          <View style={[styles.hollow, { borderColor: c.textFaint }]} />
        )}
      </View>
      <T variant="footnote" numberOfLines={1} color={agent.state === "failed" ? c.danger : agent.state === "done" ? c.textMuted : c.text} style={{ flex: 1 }}>
        {agent.label}
      </T>
      {running && agent.lastTool ? (
        <T variant="mono" muted style={{ fontSize: 11 }}>
          {agent.lastTool}
        </T>
      ) : agent.tokens ? (
        <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
          {tokensLabel(agent.tokens)}
        </T>
      ) : null}
    </View>
  );
}

/** A Claude Code workflow: the agents it runs, by phase, kept up to date while it works. */
export function WorkflowCard({ block, streaming }: { block: ToolUse; streaming: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const task = block.task;
  const input = (block.input ?? {}) as { name?: unknown };
  const name = task?.description || (typeof input.name === "string" ? input.name : "");
  // A workflow still running on a turn that has ended was cut off with its run.
  const status = task ? (task.status === "running" && !streaming ? "stopped" : task.status) : null;
  const running = status ? status === "running" : streaming && block.result === undefined && !block.isError;
  const failed = status === "failed" || !!block.isError;
  const [open, setOpen] = useRecyclingState<boolean | null>(null, [block.id]);
  const agents = task?.agents ?? [];
  const expanded = (open ?? running) && agents.length > 0;
  const done = agents.filter((a) => a.state === "done").length;
  const state = failed
    ? t("chatCards.workflow.failed")
    : status === "running"
      ? task?.activity || t("chatCards.workflow.running")
      : status === "completed"
        ? t("chatCards.workflow.completed")
        : status === "stopped"
          ? t("chatCards.workflow.stopped")
          : running
            ? t("chatCards.workflow.starting")
            : block.result === undefined
              ? t("chatCards.workflow.noResult")
              : "";
  const stats = [
    agents.length > 0 ? t("chatCards.workflow.agents", { done, total: agents.length }) : null,
    task?.totalTokens ? tokensLabel(task.totalTokens) : null,
    task?.model ? readableModelId(task.model) : null,
    !running && task?.durationMs ? duration(task.durationMs) : null,
  ].filter((x): x is string => !!x);
  const meta = [name ? t("chatCards.workflow.workflow") : null, state, ...stats].filter(Boolean).join(" · ");

  return (
    <Animated.View entering={FadeIn.duration(180)} style={[styles.box, { borderColor: failed ? c.danger : running ? c.brand : c.border }]}>
      <Pressable
        accessibilityRole={agents.length ? "button" : undefined}
        accessibilityState={agents.length ? { expanded } : undefined}
        disabled={!agents.length}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen(!expanded);
        }}
        style={styles.head}
      >
        <View style={[styles.round, { backgroundColor: failed ? c.dangerSoft : c.dreamSoft }]}>
          {running ? <ActivityIndicator size="small" color={c.dream} style={{ transform: [{ scale: 0.75 }] }} /> : <Icon name="workflow" size={14} color={failed ? c.danger : c.dream} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "500" }}>
            {name || t("chatCards.workflow.workflow")}
          </T>
          {meta ? (
            <T variant="caption" muted numberOfLines={1} color={failed ? c.danger : undefined}>
              {meta}
            </T>
          ) : null}
        </View>
        {agents.length ? <Icon name="down" size={11} color={c.textFaint} style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }} /> : null}
      </Pressable>
      {block.isError && block.result ? (
        <T variant="mono" color={c.danger} numberOfLines={4} style={[styles.task, { fontSize: 12 }]}>
          {block.result}
        </T>
      ) : null}
      {expanded ? (
        <Animated.View entering={FadeIn.duration(160)} style={[styles.phases, { borderTopColor: c.border }]}>
          {agentPhases(agents).map(({ phase, agents: list }) => (
            <View key={phase || "-"} style={{ gap: 7 }}>
              {phase ? (
                <T variant="eyebrow" muted>
                  {phase}
                </T>
              ) : null}
              {list.map((a, i) => (
                <WorkflowAgent key={i} agent={a} live={status === "running"} />
              ))}
            </View>
          ))}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/* Missing login */

const MISSING_KIND = {
  missing_credential: "inbox:login.kind.missingCredential",
  invalid_credential: "inbox:login.kind.invalidCredential",
  missing_totp: "inbox:login.kind.missingTotp",
  missing_account: "inbox:login.kind.missingAccount",
  other: "inbox:login.kind.other",
} as const;

function hostOf(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** An agent couldn't log in somewhere: which service and why. The login is added on the computer, where the vault is. */
export function MissingLoginCard({ block }: { block: ToolUse }) {
  const c = useColors();
  const { t } = useTranslation(["components", "inbox"]);
  const input = (block.input ?? {}) as { service?: unknown; url?: unknown; kind?: unknown; reason?: unknown };
  const service = (typeof input.service === "string" && input.service) || hostOf(input.url);
  const kind = typeof input.kind === "string" && input.kind in MISSING_KIND ? (input.kind as keyof typeof MISSING_KIND) : "other";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  // With full access the inbox adds the login or links the 2FA code right there.
  const { fullAccess } = useFullAccess();
  return (
    <Animated.View entering={FadeIn.duration(180)}>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t("chatCards.missingLogin.openInbox")}
        onPress={() => {
          tap();
          router.push("/inbox");
        }}
        style={({ pressed }) => [styles.login, { backgroundColor: c.surface, borderColor: c.border }, pressed && { backgroundColor: c.sunken }]}
      >
        <View style={[styles.loginBar, { backgroundColor: c.warning }]} />
        <View style={[styles.square, { backgroundColor: c.warningSoft }]}>
          <Icon name="key" size={16} color={c.warning} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={{ gap: 4, alignItems: "flex-start" }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              {service ? t("chatCards.missingLogin.needLoginFor", { service }) : t("chatCards.missingLogin.needLogin")}
            </T>
            <Badge label={t(MISSING_KIND[kind])} tone="warning" dot={false} />
          </View>
          {reason ? (
            <T variant="footnote" muted>
              {reason}
            </T>
          ) : null}
          {fullAccess === false ? (
            <T variant="caption" muted>
              {t("inbox:login.addOnComputer")}
            </T>
          ) : null}
        </View>
        <Icon name="chevron" size={11} color={c.textFaint} weight="semibold" style={{ marginTop: 4 }} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: 10,
    paddingRight: space.md,
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  box: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  task: {
    paddingHorizontal: space.md,
    paddingBottom: 10,
    marginTop: -2,
  },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footToggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
  },
  answer: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  },
  round: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  phases: {
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  glyph: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  doneDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  hollow: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 1.25,
  },
  login: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.md,
    paddingLeft: space.md + 3,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  loginBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  square: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
