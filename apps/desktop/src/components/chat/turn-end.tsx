import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Agent, ConversationWithMessages, Message, RetryMode, Run } from "@godmode/shared";
import { needsFix, retryHelps, retryModeOf, runEndOf, type RunEnd } from "@godmode/shared";
import { ArrowUpRight, FoldVertical, LogIn, MessageSquarePlus, Play, RotateCcw, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useStartAgentChat } from "@/components/agents/agent-actions";
import { useRunRoutine } from "@/components/agents/routine-item";
import { ClaudeSignInSteps, maySignIn, useClaudeLogin } from "@/components/onboarding/claude-sign-in";
import { api, ApiRequestError, errorMessage, isLicenseRequired } from "@/lib/api";
import { useRoutines, useTasks } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { intlLocale, t } from "@/i18n";

const PLATFORM_ORIGINS = new Set(["slack", "telegram", "teams"]);

/** Where the fix for a turn that can't just be tried again lives. */
function fixFor(end: RunEnd, agentName: string): { text: string; to?: string; label?: string } {
  switch (end.kind) {
    case "cli":
      return { text: t("chat:turnEnd.fix.cli"), to: "/settings/system", label: t("chat:turnEnd.fix.openSystem") };
    case "vm":
      return end.off
        ? { text: t("chat:turnEnd.fix.vmOff"), to: "/settings/vms", label: t("chat:turnEnd.fix.vmSettings") }
        : { text: t("chat:turnEnd.fix.vmFailed"), to: "/vms", label: t("chat:turnEnd.fix.openVms") };
    case "folder":
      return { text: t("chat:turnEnd.fix.folder", { name: agentName }) };
    default:
      return { text: t("chat:turnEnd.fix.model") };
  }
}

/**
 * Under the chat's latest turn when it ended early (failed, timed out, stopped, cut off by a restart): one click to
 * pick it up — continue where it stopped, or send the message again when Claude never got it. A ticket's chat points to
 * the ticket, a chat on Slack or Telegram to where the person asked.
 */
export function TurnEnd({ conversation, message, agent }: { conversation: ConversationWithMessages; message: Message; agent?: Agent }) {
  const { t } = useTranslation(["chat", "common"]);
  const qc = useQueryClient();
  const { data: run } = useQuery({
    queryKey: qk.run(message.runId!),
    queryFn: () => api.runs.get(message.runId!),
    staleTime: 60_000,
    // While it waits to go on by itself, the time it names stays current.
    refetchInterval: (q) => (q.state.data?.retryAt ? 60_000 : false),
    retry: false,
  });
  const { data: tasks = [] } = useTasks("all");
  const { data: routines = [] } = useRoutines();
  const chat = useStartAgentChat();
  const runRoutine = useRunRoutine();
  const name = agent?.name ?? t("turnEnd.theAgent");
  const compress = useMutation({
    mutationFn: () => api.conversations.send(conversation.id, { content: "/compress" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversation(conversation.id) }),
    onError: (err) => toast.error(t("turnEnd.compressError"), { description: errorMessage(err) }),
  });
  const retry = useMutation({
    mutationFn: () => api.conversations.retry(conversation.id, message.runId!),
    onSuccess: (res) => {
      qc.setQueryData<ConversationWithMessages>(qk.conversation(conversation.id), (old) =>
        !old
          ? old
          : {
              ...old,
              messages: old.messages.some((m) => m.id === res.message.id) ? old.messages : [...old.messages, res.message],
              activeRunId: old.activeRunId ?? (res.run.status === "queued" || res.run.status === "running" ? res.run.id : null),
            },
      );
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (err) => {
      // Something else moved the chat on meanwhile: show it.
      if (err instanceof ApiRequestError && err.code === "stale") void qc.invalidateQueries({ queryKey: qk.conversation(conversation.id) });
      if (isLicenseRequired(err)) return;
      toast.error(err instanceof ApiRequestError && err.status === 409 ? t("turnEnd.cantPickUp") : t("turnEnd.couldntPickUp"), { description: errorMessage(err) });
    },
  });

  if (!run || (run.status !== "failed" && run.status !== "cancelled")) return null;
  if (run.trigger === "dream" || run.trigger === "check" || PLATFORM_ORIGINS.has(conversation.origin)) return null;
  // The connection to Claude dropped, or Claude Code stopped with an error: Godmode continues by itself, a little later.
  const retryAt = run.retryAt ? new Date(run.retryAt).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }) : null;
  const why = run.retryCause === "error" ? t("turnEnd.errorStopped") : t("turnEnd.connectionDropped");

  // A ticket's chat (also one whose ticket is archived) goes on from the ticket.
  if (conversation.origin === "task") {
    const task = tasks.find((x) => x.conversationId === conversation.id);
    return (
      <Row>
        <span className="min-w-0">{task ? t("turnEnd.ticketN", { n: task.number }) : t("turnEnd.ticket")}</span>
        <Button size="xs" variant="outline" asChild>
          <Link to={task ? `/tasks?task=${task.id}` : "/tasks?view=archived"}>
            {t("messages.openTicket")} <ArrowUpRight />
          </Link>
        </Button>
      </Row>
    );
  }

  // An automation's run is run again by the automation, so its own checks and history follow it.
  if (run.trigger === "routine") {
    const routine = routines.find((r) => r.id === run.routineId);
    if (!routine) return null;
    return (
      <Row>
        <span className="min-w-0">
          {retryAt ? t("turnEnd.routineRetry", { why, routine: routine.name, time: retryAt }) : t("turnEnd.routineAgain", { routine: routine.name })}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" disabled={runRoutine.isPending || !routine.enabled} aria-busy={runRoutine.isPending} onClick={() => runRoutine.mutate(routine)}>
            {runRoutine.isPending ? <Spinner /> : <Play className="fill-current" />} {t("turnEnd.runNow")}
          </Button>
          <Button size="xs" variant="ghost" asChild>
            <Link to={`/automations?edit=${routine.id}`}>
              <Workflow /> {t("turnEnd.openAutomation")}
            </Link>
          </Button>
        </span>
      </Row>
    );
  }

  const end = runEndOf(run.error ?? "");
  if (!retryHelps(end)) {
    return (
      <Row>
        <span className="min-w-0">{t("turnEnd.tooLong", { name })}</span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" disabled={compress.isPending} aria-busy={compress.isPending} onClick={() => compress.mutate()}>
            {compress.isPending ? <Spinner /> : <FoldVertical />} {t("turnEnd.compress")}
          </Button>
          <Button size="xs" variant="ghost" disabled={chat.isPending} onClick={() => agent && chat.mutate(agent)}>
            {chat.isPending ? <Spinner /> : <MessageSquarePlus />} {t("header.newChat")}
          </Button>
        </span>
      </Row>
    );
  }

  const mode: RetryMode = retryModeOf(message.blocks) === "continue" && conversation.claudeSessionId ? "continue" : "again";
  const label = mode === "continue" ? t("common:actions.continue") : t("common:actions.tryAgain");
  const action = (variant: "outline" | "ghost") => (
    <Button size="xs" variant={variant} disabled={retry.isPending} aria-busy={retry.isPending} onClick={() => retry.mutate()} title={mode === "continue" ? t("turnEnd.picksUp", { name }) : t("turnEnd.sendsAgain", { name })}>
      {retry.isPending ? <Spinner /> : mode === "continue" ? <Play className="fill-current" /> : <RotateCcw />} {label}
    </Button>
  );

  if (end?.kind === "auth") return <SignInAgain run={run} name={name} action={action} onSignedIn={() => retry.mutate()} />;

  if (end && needsFix(end)) {
    const fix = fixFor(end, name);
    return (
      <Row>
        <span className="min-w-0">{fix.text}</span>
        <span className="flex shrink-0 items-center gap-1">
          {fix.to && (
            <Button size="xs" variant="outline" asChild>
              <Link to={fix.to}>
                {fix.label} <ArrowUpRight />
              </Link>
            </Button>
          )}
          {action("ghost")}
        </span>
      </Row>
    );
  }

  // The human stopped it on purpose: offered quietly, in case they changed their mind.
  const byHuman = end?.kind === "stopped" && end.byUser;
  return (
    <Row>
      {action(byHuman ? "ghost" : "outline")}
      <span className="min-w-0">
        {retryAt
          ? t("turnEnd.retryAuto", { why, name, time: retryAt })
          : mode === "continue"
          ? byHuman
            ? t("turnEnd.changedMind", { name })
            : t("turnEnd.picksUpHere", { name })
          : t("turnEnd.sendsYourAgain", { name })}
      </span>
    </Row>
  );
}

/**
 * Claude Code is signed out: sign in again from the chat (or the banner), and the turn goes on by itself once Claude
 * works again while the chat is open.
 */
function SignInAgain({ run, name, action, onSignedIn }: { run: Run; name: string; action: (variant: "outline" | "ghost") => ReactNode; onSignedIn: () => void }) {
  const { t } = useTranslation(["chat", "common"]);
  const continued = useRef<string | null>(null);
  const goOn = useCallback(() => {
    if (continued.current === run.id) return;
    continued.current = run.id;
    onSignedIn();
  }, [run.id, onSignedIn]);
  const login = useClaudeLogin({ onSignedIn: goOn });
  const { status, state, start } = login;
  // Cleared some other way while the chat is open (a sign-in in a terminal, another run that got an answer).
  const wasOut = useRef(false);
  useEffect(() => {
    if (status?.signedOut) wasOut.current = true;
    else if (wasOut.current && status?.signedOut === null) {
      wasOut.current = false;
      goOn();
    }
  }, [status?.signedOut, goOn]);
  // A core that knows the state says it works again (older ones leave it out).
  const worksAgain = status?.signedOut === null && state !== "failed";

  if (status?.signedOut?.apiKey)
    return (
      <Row>
        <span className="min-w-0">{t("turnEnd.keyRefused")}</span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" asChild>
            <Link to="/settings/api-keys">
              {t("turnEnd.apiKeys")} <ArrowUpRight />
            </Link>
          </Button>
          {action("ghost")}
        </span>
      </Row>
    );
  if (state === "waiting" && !login.mine)
    return (
      <Row>
        <Spinner className="size-3.5" />
        <span className="min-w-0">{t("turnEnd.signingIn", { name })}</span>
      </Row>
    );
  if (state === "waiting")
    return (
      <div className="-mt-3 space-y-1.5 pl-11">
        <ClaudeSignInSteps login={login} className="max-w-xl" />
        <p className="text-xs text-muted-foreground">{t("turnEnd.goesOnSignedIn", { name })}</p>
      </div>
    );
  if (worksAgain)
    return (
      <Row>
        {action("outline")}
        <span className="min-w-0">{t("turnEnd.worksAgain", { name })}</span>
      </Row>
    );
  if (!maySignIn)
    return (
      <Row>
        <span className="min-w-0">{t("turnEnd.signedOutOwner")}</span>
        {action("ghost")}
      </Row>
    );
  return (
    <Row>
      <span className="min-w-0">{state === "failed" && status?.message ? t("turnEnd.signInFailed", { message: status.message }) : t("turnEnd.signedOut", { name })}</span>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="xs" disabled={start.isPending} aria-busy={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? <Spinner /> : <LogIn />} {state === "failed" ? t("common:actions.tryAgain") : t("turnEnd.signInAgain")}
        </Button>
        {action("ghost")}
      </span>
    </Row>
  );
}

function Row({ children }: { children: ReactNode }) {
  const { t } = useTranslation("chat");
  return (
    <div role="group" aria-label={t("turnEnd.endedEarly")} aria-live="polite" className="-mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pl-11 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
