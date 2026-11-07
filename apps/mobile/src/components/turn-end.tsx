import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { router, type Href } from "expo-router";
import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { needsFix, retryHelps, retryModeOf, runEndOf, type ConversationWithMessages, type RetryMode, type Run, type RunEnd } from "@godmode/shared";
import { useFullAccess } from "./full-access";
import { Icon } from "./icon";
import { SignInSteps } from "./program-parts";
import { runRoutine } from "./routine-row";
import { T, tap } from "./ui";
import { api } from "@/lib/api";
import { useChatTask, useRoutine } from "@/lib/chat-source";
import { dateLocale } from "@/lib/i18n";
import { useClaudeLogin } from "@/lib/programs";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type Fix = { text: string; to?: Href; label?: string };

export interface EndedTurn {
  run: Run;
  end: RunEnd | null;
  mode: RetryMode;
  origin: ConversationWithMessages["origin"];
}

/** Where a turn that ended early goes on somewhere else: the person asked on Slack, Telegram or Teams. */
const ELSEWHERE = new Set(["slack", "telegram", "teams"]);
/** A dream, a review and an automation's check aren't turns to pick up. */
const NO_TURN = new Set(["dream", "review", "check"]);

/** The chat's latest turn, when it ended early and nothing else is about to happen in the chat (`ready`). */
export function useEndedTurn(conversation: ConversationWithMessages | undefined, ready: boolean): EndedTurn | null {
  const log = conversation?.origin === "dream" || conversation?.origin === "review";
  const last = ready && conversation && !log && !ELSEWHERE.has(conversation.origin) && !conversation.queue.length ? conversation.messages[conversation.messages.length - 1] : undefined;
  const runId = last?.role === "assistant" ? last.runId : null;
  const { data: run } = useQuery({
    queryKey: qk.run(runId ?? ""),
    queryFn: () => api.runs.get(runId!),
    enabled: !!runId,
    // Asked again once the turn is over: what's kept may be from while it ran.
    staleTime: 0,
    // While it waits to go on by itself, the time it names stays current.
    refetchInterval: (q) => (q.state.data?.retryAt ? 60_000 : false),
    retry: false,
  });
  if (!last || !conversation || !run || run.id !== runId) return null;
  if ((run.status !== "failed" && run.status !== "cancelled") || NO_TURN.has(run.trigger)) return null;
  return { run, end: runEndOf(run.error ?? ""), mode: retryModeOf(last.blocks) === "continue" && conversation.claudeSessionId ? "continue" : "again", origin: conversation.origin };
}

function Strip({ text, children, busy }: { text: string; children?: ReactNode; busy?: boolean }) {
  const c = useColors();
  const actions = Children.toArray(children);
  const stacked = actions.length > 1;
  return (
    <View style={[styles.strip, stacked && styles.stacked, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.line}>
        {busy ? <ActivityIndicator size="small" color={c.textFaint} /> : <Icon name="warning" size={15} color={c.textMuted} />}
        <T variant="footnote" muted style={{ flex: 1 }} numberOfLines={4}>
          {text}
        </T>
        {stacked ? null : actions}
      </View>
      {stacked ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

export function StripAction({ label, onPress, busy }: { label: string; onPress: () => void; busy?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={busy} hitSlop={10} accessibilityRole="button" accessibilityState={{ busy: !!busy, disabled: !!busy }} style={{ opacity: busy ? 0.5 : 1 }}>
      <T variant="footnote" color={c.primary} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

/** Above the composer when the last turn ended early: why, and what picks it up (like the desktop's turn end). */
export function EndedStrip({
  ended,
  conversationId,
  agentId,
  agentName,
  onRetry,
  onCompress,
  busy,
}: {
  ended: EndedTurn;
  conversationId: string;
  agentId?: string;
  agentName: string;
  onRetry: () => void;
  onCompress: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { fullAccess } = useFullAccess();
  const { run, end, mode, origin } = ended;
  const retryLabel = mode === "continue" ? t("common:actions.continue") : t("common:actions.tryAgain");
  const retry = <StripAction label={retryLabel} onPress={onRetry} busy={busy} />;
  // The connection to Claude dropped, or Claude Code stopped with an error: Godmode continues by itself, a little later.
  const retryAt = run.retryAt ? format(new Date(run.retryAt), "p", { locale: dateLocale() }) : null;
  const why = run.retryCause === "error" ? t("thread.ended.errorStopped") : t("thread.ended.connectionDropped");

  if (origin === "task") return <TicketEnd conversationId={conversationId} />;
  if (run.trigger === "routine") return <AutomationEnd routineId={run.routineId} retry={retryAt ? { why, time: retryAt } : null} />;
  if (!retryHelps(end)) {
    return (
      <Strip text={t("thread.ended.tooLong", { name: agentName })}>
        <StripAction label={t("thread.ended.compress")} onPress={onCompress} />
        {agentId ? (
          <StripAction
            label={t("conv.newChat")}
            onPress={() => {
              tap();
              router.push({ pathname: "/compose", params: { agentId } });
            }}
          />
        ) : null}
      </Strip>
    );
  }
  if (end?.kind === "auth") {
    if (fullAccess) return <SignInAgain name={agentName} retry={retry} onSignedIn={onRetry} />;
    return <Strip text={t("thread.fix.signedOutComputer")}>{retry}</Strip>;
  }
  if (end && needsFix(end)) {
    const fix = fixFor(end, agentName, conversationId);
    return (
      <Strip text={fix.text}>
        {fix.to && fullAccess ? (
          <StripAction
            label={fix.label!}
            onPress={() => {
              tap();
              router.push(fix.to!);
            }}
          />
        ) : null}
        {retry}
      </Strip>
    );
  }
  const byHuman = end?.kind === "stopped" && end.byUser;
  const text = retryAt
    ? t("thread.ended.retryAuto", { why, name: agentName, time: retryAt })
    : mode === "continue"
      ? byHuman
        ? t("thread.ended.changedMind", { name: agentName })
        : t("thread.ended.picksUpHere", { name: agentName })
      : t("thread.ended.sendsYourAgain", { name: agentName });
  return <Strip text={text}>{retry}</Strip>;

  function fixFor(stop: RunEnd, name: string, id: string): Fix {
    switch (stop.kind) {
      case "cli":
        return { text: t("thread.fix.cli"), to: "/settings/health", label: t("thread.fix.openSystem") };
      case "vm":
        return { text: stop.off ? t("thread.fix.vmOff") : t("thread.fix.vmFailed"), to: "/settings/vms", label: stop.off ? t("thread.fix.vmSettings") : t("thread.fix.openVms") };
      case "folder":
        return { text: t("thread.fix.folder", { name }), to: { pathname: "/chat-options", params: { conversationId: id } }, label: t("conv.settings") };
      default:
        return { text: t("thread.fix.model") };
    }
  }
}

/** A ticket's chat, also one whose ticket is archived, goes on from the ticket. */
function TicketEnd({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation("chat");
  const task = useChatTask(conversationId, true);
  return (
    <Strip text={task ? t("thread.ended.ticketN", { n: task.number }) : t("thread.ended.ticket")}>
      <StripAction
        label={t("thread.ended.openTicket")}
        onPress={() => {
          tap();
          if (task) router.push({ pathname: "/task/[id]", params: { id: task.id } });
          else router.push("/archived-tasks");
        }}
      />
    </Strip>
  );
}

/** An automation's run is run again by the automation, so its own checks and history follow it. */
function AutomationEnd({ routineId, retry }: { routineId: string | null; retry: { why: string; time: string } | null }) {
  const { t } = useTranslation("chat");
  const routine = useRoutine(routineId);
  const [running, setRunning] = useState(false);
  if (!routine) return null;
  return (
    <Strip text={retry ? t("thread.ended.routineRetry", { ...retry, routine: routine.name }) : t("thread.ended.routineAgain", { routine: routine.name })}>
      {routine.enabled ? (
        <StripAction
          label={t("thread.ended.runNow")}
          busy={running}
          onPress={() => {
            setRunning(true);
            void runRoutine(routine).finally(() => setRunning(false));
          }}
        />
      ) : null}
      <StripAction
        label={t("thread.ended.openAutomation")}
        onPress={() => {
          tap();
          router.push({ pathname: "/automation/[id]", params: { id: routine.id } });
        }}
      />
    </Strip>
  );
}

/** Claude Code is signed out: sign in again from the chat, and the turn goes on by itself once Claude works again. */
function SignInAgain({ name, retry, onSignedIn }: { name: string; retry: ReactNode; onSignedIn: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "programs", "common"]);
  const continued = useRef(false);
  const goOn = useCallback(() => {
    if (continued.current) return;
    continued.current = true;
    onSignedIn();
  }, [onSignedIn]);
  const login = useClaudeLogin(true, goOn, { quiet: true });
  // The sign-in started here (one running elsewhere is only mentioned).
  const [mine, setMine] = useState(false);
  const status = login.status;
  if (mine && !login.waiting && !login.start.isPending) setMine(false);
  // Cleared some other way while the chat is open (a sign-in on the computer, another run that got an answer).
  const wasOut = useRef(false);
  useEffect(() => {
    if (status?.signedOut) wasOut.current = true;
    else if (wasOut.current && status?.signedOut === null) {
      wasOut.current = false;
      goOn();
    }
  }, [status?.signedOut, goOn]);

  if (status?.signedOut?.apiKey) {
    return (
      <Strip text={t("thread.fix.keyRefused")}>
        <StripAction
          label={t("thread.fix.apiKeys")}
          onPress={() => {
            tap();
            router.push("/settings/vault/api-keys");
          }}
        />
        {retry}
      </Strip>
    );
  }
  if (login.waiting && mine) {
    return (
      <View style={styles.steps}>
        <SignInSteps
          title={t("programs:signIn.title")}
          url={status?.url ?? null}
          submitting={login.submit.isPending}
          cancelling={login.cancel.isPending}
          onSubmit={login.send}
          onCancel={() => login.cancel.mutate()}
        />
        <T variant="caption" color={c.textFaint} style={{ paddingHorizontal: 4 }}>
          {t("thread.fix.goesOnSignedIn", { name })}
        </T>
      </View>
    );
  }
  if (login.waiting) return <Strip busy text={t("thread.fix.signingIn", { name })}>{null}</Strip>;
  if (status?.signedOut === null && status.state !== "failed") return <Strip text={t("thread.fix.worksAgain", { name })}>{retry}</Strip>;
  return (
    <Strip text={status?.state === "failed" && status.message ? t("thread.fix.signInFailed", { message: status.message }) : t("thread.fix.signedOut", { name })}>
      <StripAction
        label={status?.state === "failed" ? t("common:actions.tryAgain") : t("thread.fix.signInAgain")}
        busy={login.start.isPending}
        onPress={() => {
          tap();
          setMine(true);
          login.start.mutate();
        }}
      />
      {retry}
    </Strip>
  );
}

const styles = StyleSheet.create({
  strip: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  stacked: {
    gap: 8,
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.lg,
  },
  steps: {
    gap: 6,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
  },
});
