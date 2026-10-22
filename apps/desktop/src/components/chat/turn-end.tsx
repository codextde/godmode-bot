import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

const PLATFORM_ORIGINS = new Set(["slack", "telegram", "teams"]);

/** Where the fix for a turn that can't just be tried again lives. */
function fixFor(end: RunEnd, agentName: string): { text: string; to?: string; label?: string } {
  switch (end.kind) {
    case "cli":
      return { text: "Install Claude Code, then try again.", to: "/settings/system", label: "Open System" };
    case "vm":
      return end.off
        ? { text: "Turn virtual machines on, or pick no VM below, then try again.", to: "/settings/vms", label: "VM settings" }
        : { text: "The VM couldn't be started — check it, or pick no VM below, then try again.", to: "/vms", label: "Open VMs" };
    case "folder":
      return { text: `Pick another folder for ${agentName} below, then try again.` };
    default:
      return { text: "Pick another model below, then try again." };
  }
}

/**
 * Under the chat's latest turn when it ended early (failed, timed out, stopped, cut off by a restart): one click to
 * pick it up — continue where it stopped, or send the message again when Claude never got it. A ticket's chat points to
 * the ticket, a chat on Slack or Telegram to where the person asked.
 */
export function TurnEnd({ conversation, message, agent }: { conversation: ConversationWithMessages; message: Message; agent?: Agent }) {
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
  const name = agent?.name ?? "The agent";
  const compress = useMutation({
    mutationFn: () => api.conversations.send(conversation.id, { content: "/compress" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversation(conversation.id) }),
    onError: (err) => toast.error("Couldn't compress the chat", { description: errorMessage(err) }),
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
      toast.error(err instanceof ApiRequestError && err.status === 409 ? "Can't pick this up" : "Couldn't pick this up", { description: errorMessage(err) });
    },
  });

  if (!run || (run.status !== "failed" && run.status !== "cancelled")) return null;
  if (run.trigger === "dream" || run.trigger === "check" || PLATFORM_ORIGINS.has(conversation.origin)) return null;
  // The connection to Claude dropped, or Claude Code stopped with an error: Godmode continues by itself, a little later.
  const retryAt = run.retryAt ? new Date(run.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const why = run.retryCause === "error" ? "Claude Code stopped with an error" : "The connection to Claude dropped";

  // A ticket's chat (also one whose ticket is archived) goes on from the ticket.
  if (conversation.origin === "task") {
    const task = tasks.find((t) => t.conversationId === conversation.id);
    return (
      <Row>
        <span className="min-w-0">{task ? `This chat works on ticket #${task.number} — continue it from there.` : "This chat works on a ticket — continue it from there."}</span>
        <Button size="xs" variant="outline" asChild>
          <Link to={task ? `/tasks?task=${task.id}` : "/tasks?view=archived"}>
            Open ticket <ArrowUpRight />
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
          {retryAt ? `${why} — “${routine.name}” goes on by itself around ${retryAt}.` : `This was “${routine.name}” — run the automation again.`}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" disabled={runRoutine.isPending || !routine.enabled} aria-busy={runRoutine.isPending} onClick={() => runRoutine.mutate(routine)}>
            {runRoutine.isPending ? <Spinner /> : <Play className="fill-current" />} Run now
          </Button>
          <Button size="xs" variant="ghost" asChild>
            <Link to={`/automations?edit=${routine.id}`}>
              <Workflow /> Open automation
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
        <span className="min-w-0">This chat is too long for {name} to go on. Compress it into a summary and carry on, or start fresh.</span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" disabled={compress.isPending} aria-busy={compress.isPending} onClick={() => compress.mutate()}>
            {compress.isPending ? <Spinner /> : <FoldVertical />} Compress
          </Button>
          <Button size="xs" variant="ghost" disabled={chat.isPending} onClick={() => agent && chat.mutate(agent)}>
            {chat.isPending ? <Spinner /> : <MessageSquarePlus />} New chat
          </Button>
        </span>
      </Row>
    );
  }

  const mode: RetryMode = retryModeOf(message.blocks) === "continue" && conversation.claudeSessionId ? "continue" : "again";
  const label = mode === "continue" ? "Continue" : "Try again";
  const action = (variant: "outline" | "ghost") => (
    <Button size="xs" variant={variant} disabled={retry.isPending} aria-busy={retry.isPending} onClick={() => retry.mutate()} title={mode === "continue" ? `${name} picks up where it stopped` : `Sends the message to ${name} again`}>
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
          ? `${why} — ${name} picks it up by itself around ${retryAt}.`
          : mode === "continue"
          ? byHuman
            ? `Changed your mind? ${name} picks up where you stopped it.`
            : `${name} picks up where it stopped, in this chat.`
          : `Sends your message to ${name} again.`}
      </span>
    </Row>
  );
}

/**
 * Claude Code is signed out: sign in again from the chat (or the banner), and the turn goes on by itself once Claude
 * works again while the chat is open.
 */
function SignInAgain({ run, name, action, onSignedIn }: { run: Run; name: string; action: (variant: "outline" | "ghost") => ReactNode; onSignedIn: () => void }) {
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
        <span className="min-w-0">Claude refused the Anthropic API key. Check it, then try again.</span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" asChild>
            <Link to="/integrations?tab=api-keys">
              API keys <ArrowUpRight />
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
        <span className="min-w-0">Signing in to Claude… {name} picks up where it stopped once you're done.</span>
      </Row>
    );
  if (state === "waiting")
    return (
      <div className="-mt-3 space-y-1.5 pl-11">
        <ClaudeSignInSteps login={login} className="max-w-xl" />
        <p className="text-xs text-muted-foreground">{name} goes on by itself once you're signed in.</p>
      </div>
    );
  if (worksAgain)
    return (
      <Row>
        {action("outline")}
        <span className="min-w-0">Claude works again. {name} picks up where it stopped.</span>
      </Row>
    );
  if (!maySignIn)
    return (
      <Row>
        <span className="min-w-0">Claude is signed out on this computer. Once its owner signs in again, try again.</span>
        {action("ghost")}
      </Row>
    );
  return (
    <Row>
      <span className="min-w-0">{state === "failed" && status?.message ? `The sign-in didn't finish: ${status.message}` : `Claude is signed out. Sign in again and ${name} goes on by itself.`}</span>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="xs" disabled={start.isPending} aria-busy={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? <Spinner /> : <LogIn />} {state === "failed" ? "Try again" : "Sign in again"}
        </Button>
        {action("ghost")}
      </span>
    </Row>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div role="group" aria-label="This turn ended early" aria-live="polite" className="-mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pl-11 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
