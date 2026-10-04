import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play } from "lucide-react";
import type { Agent, AgentPresence, CharacterMood } from "@godmode/shared";
import { agentPresence, presenceLabel } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useMissingLogins, useScopeWorkspace } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { clearDraft, useDraft } from "@/lib/drafts";
import { useLive, type LiveRun } from "@/stores/live";
import { AgentAvatar, Kbd } from "@/components/common";
import { liveMood } from "@/components/chat/conversation-mood";
import { LiveDot } from "@/components/aicss/Motion";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";

/** The agent's live runs: the working ones first, then the queued ones, oldest first. */
export function useAgentLiveRuns(agentId: string | undefined): LiveRun[] {
  const ids = useLive((s) =>
    agentId
      ? Object.values(s.runs)
          .filter((r) => r.agentId === agentId)
          .sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || a.startedAt - b.startedAt)
          .map((r) => r.runId)
          .join(",")
      : "",
  );
  const runs = useLive((s) => s.runs);
  return useMemo(() => (ids ? ids.split(",").flatMap((id) => (runs[id] ? [runs[id]] : [])) : []), [ids, runs]);
}

/** The agent's first run that is working right now (a queued one isn't). */
export function useAgentLiveRun(agentId: string | undefined): LiveRun | null {
  return useLive((s) => (agentId ? (Object.values(s.runs).find((r) => r.agentId === agentId && r.status === "running") ?? null) : null));
}

/** What the agent is doing right now, the same everywhere it shows (card, chart, header, picker). */
export function useAgentPresence(agent: Agent): AgentPresence {
  const runs = useAgentLiveRuns(agent.id);
  const { data: missing = [] } = useMissingLogins("open");
  return agentPresence(agent, {
    running: runs.filter((r) => r.status === "running").length,
    queued: runs.filter((r) => r.status === "queued").length,
    needsLogin: missing.some((m) => m.agentId === agent.id),
  });
}

/** The agent's character mood outside a chat: busy while it works, waving while it needs the human. */
export function useAgentMood(agent: Agent): CharacterMood {
  const live = useAgentLiveRun(agent.id);
  const presence = useAgentPresence(agent);
  if (live) return liveMood(live).mood;
  switch (presence.state) {
    case "off":
      return "sleeping";
    case "waiting":
      return "attention";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

type ChatTarget = Pick<Agent, "id" | "name" | "enabled">;

/** Start a fresh conversation with an agent and open it. A switched-off agent gets a "Switch on and chat" offer instead. */
export function useStartAgentChat() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const workspace = useScopeWorkspace();
  const mutation = useMutation({
    mutationFn: async ({ agent, switchOn }: { agent: ChatTarget; switchOn?: boolean }) => {
      if (switchOn) {
        const updated = await api.agents.update(agent.id, { enabled: true });
        qc.setQueryData(qk.agent(updated.id), updated);
        qc.invalidateQueries({ queryKey: qk.agents });
      }
      return api.conversations.create({ agentId: agent.id, workspaceId: workspace?.id });
    },
    onSuccess: (conversation) => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${conversation.id}`);
    },
    onError: (err) => toast.error("Couldn't start a chat", { description: errorMessage(err) }),
  });
  return {
    ...mutation,
    mutate: (agent: ChatTarget) => {
      if (agent.enabled) return mutation.mutate({ agent });
      toast(`${agent.name} is switched off`, {
        description: "It doesn't answer until you switch it on.",
        action: { label: "Switch on and chat", onClick: () => mutation.mutate({ agent, switchOn: true }) },
      });
    },
  };
}

export function useToggleAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.agents.update(id, { enabled }),
    onSuccess: (agent) => {
      qc.setQueryData(qk.agent(agent.id), agent);
      qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(agent.enabled ? `${agent.name} is switched on` : `${agent.name} is switched off`, {
        description: agent.enabled ? undefined : "Its automations won't run until you switch it on again.",
      });
    },
    onError: (err) => toast.error("Couldn't update agent", { description: errorMessage(err) }),
  });
}

/** Copy an agent's setup (the passphrase first when it may read secrets) and open the copy's settings. */
export function useDuplicateAgent() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agent: Agent) =>
      agent.permissions.secretAccess === "reveal" ? withGrant((grant) => api.agents.duplicate(agent.id, grant), `Copy ${agent.name}, which may read secrets`) : api.agents.duplicate(agent.id),
    onSuccess: (copy, source) => {
      qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(`${copy.name} is ready`, { description: `Same setup as ${source.name}, with a fresh memory. Give it its own name and role.` });
      navigate(`/agents/${copy.id}/settings`);
    },
    onError: (err, source) => {
      if (!isGrantCancelled(err)) toast.error(`Couldn't duplicate ${source.name}`, { description: errorMessage(err) });
    },
  });
}

/** Pause everything an agent is working on, and continue it where it stopped. */
export function useAgentPause() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.agents });
    qc.invalidateQueries({ queryKey: qk.conversationsAll });
    qc.invalidateQueries({ queryKey: qk.runs });
  };
  const pause = useMutation({
    mutationFn: (agent: Agent) => api.agents.pause(agent.id),
    onSuccess: ({ paused }, agent) => {
      refresh();
      toast(`${agent.name} is pausing`, { description: paused > 1 ? `${paused} chats stop after the step they are in.` : "It stops after the step it is in." });
    },
    onError: (err) => toast.error("Couldn't pause", { description: errorMessage(err) }),
  });
  const resume = useMutation({
    mutationFn: (agent: Agent) => api.agents.continue(agent.id),
    onSuccess: ({ continued }, agent) => {
      refresh();
      toast.success(`${agent.name} continues`, { description: continued > 1 ? `${continued} chats go on where they stopped.` : "It goes on where it stopped." });
    },
    onError: (err) => {
      refresh();
      toast.error("Couldn't continue", { description: errorMessage(err) });
    },
  });
  return { pause, resume };
}

/** Holds on to the last non-null value so dialogs don't go blank while animating out. */
function useLatest<T>(value: T | null): T | null {
  const [latest, setLatest] = useState(value);
  useEffect(() => {
    if (value) setLatest(value);
  }, [value]);
  return value ?? latest;
}

/** Quick "give this agent a task" dialog → new conversation with the task running (empty = follow its instructions). */
export function RunTaskDialog({
  agent: agentProp,
  open,
  onOpenChange,
}: {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const agent = useLatest(agentProp);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const workspace = useScopeWorkspace();
  const [prompt, setPrompt, promptDraft] = useDraft(agent ? `run-task:${agent.id}` : undefined, "");
  const run = useMutation({
    mutationFn: (input: { agentId: string; prompt: string }) => api.agents.run(input.agentId, input.prompt, workspace?.id),
    onSuccess: (res, input) => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success(`${agent?.name ?? "Agent"} is on it`);
      // Text typed while it was starting stays as the next draft.
      if (input.agentId !== agent?.id) clearDraft(`run-task:${input.agentId}`);
      else if (prompt.trim() === input.prompt) promptDraft.discard();
      onOpenChange(false);
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (err) => toast.error("Couldn't start the task", { description: errorMessage(err) }),
  });
  const canRun = !!agent && !run.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {agent && <AgentAvatar agent={agent} size="md" />}
            <div>
              <DialogTitle>Run a task{agent ? ` with ${agent.name}` : ""}</DialogTitle>
              <DialogDescription>It works in a new conversation — you can follow along live.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canRun) run.mutate({ agentId: agent.id, prompt: prompt.trim() });
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="run-task-prompt">
              Task <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="run-task-prompt"
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (canRun) run.mutate({ agentId: agent.id, prompt: prompt.trim() });
                }
              }}
              placeholder={agent?.description ? `e.g. ${agent.description}` : "Describe what it should do…"}
              aria-describedby="run-task-hint"
              className="min-h-32 resize-none text-[15px]"
            />
            <p id="run-task-hint" className="text-xs text-muted-foreground">
              Leave it empty and {agent?.name ?? "the agent"} works from its instructions.
            </p>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd> to run
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canRun}>
                {run.isPending ? <Spinner /> : <Play />}
                Run task
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAgentDialog({
  agent: agentProp,
  open,
  onOpenChange,
  onDeleted,
}: {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const agent = useLatest(agentProp);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.agents.delete(agent!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.routines });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(`${agent?.name ?? "Agent"} deleted`);
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (err) => toast.error("Couldn't delete agent", { description: errorMessage(err) }),
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {agent?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the agent, its automations and conversations. Its memory repository is deleted as well. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              del.mutate();
            }}
            disabled={del.isPending}
            variant="destructive"
          >
            {del.isPending && <Spinner />}
            Delete agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Status dot + label, live-aware ("Browsing github.com…" while one run works). With `interactive`, "Last run failed"
 * opens that run and a single working run links to its chat.
 */
export function AgentStatus({
  agent,
  className,
  showActivity = true,
  interactive = false,
}: {
  agent: Agent;
  className?: string;
  showActivity?: boolean;
  interactive?: boolean;
}) {
  const live = useAgentLiveRun(agent.id);
  const presence = useAgentPresence(agent);
  const { state } = presence;
  const label = state === "working" && presence.running === 1 && showActivity && live?.activity ? live.activity : presenceLabel(presence);
  const text = (
    <span className={cn("truncate", state === "working" ? "text-shimmer font-medium" : state === "waiting" ? "text-foreground" : state === "failed" ? "text-destructive" : "text-muted-foreground")}>
      {label}
    </span>
  );
  const dot =
    state === "working" ? (
      <LiveDot className="shrink-0" />
    ) : (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          state === "idle" && "bg-success",
          (state === "waiting" || state === "paused") && "bg-warning",
          state === "failed" && "bg-destructive",
          (state === "off" || state === "queued") && "bg-muted-foreground/50",
        )}
      />
    );
  const linkClass = cn("relative z-10 inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", className);
  if (interactive && state === "failed" && agent.failedRunId) {
    return (
      <Link to={`/activity?run=${agent.failedRunId}`} className={linkClass} title="Open the run that failed" onClick={(e) => e.stopPropagation()}>
        {dot}
        {text}
      </Link>
    );
  }
  if (interactive && state === "working" && presence.running === 1 && live) {
    return (
      <Link to={`/chat/${live.conversationId}`} className={linkClass} aria-label={`Watch ${agent.name} work: ${label}`} onClick={(e) => e.stopPropagation()}>
        {dot}
        {text}
      </Link>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", className)}>
      {dot}
      {text}
    </span>
  );
}
