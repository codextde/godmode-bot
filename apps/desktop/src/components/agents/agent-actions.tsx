import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useScopeWorkspace } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { clearDraft, useDraft } from "@/lib/drafts";
import { useLive, type LiveRun } from "@/stores/live";
import { AgentAvatar, Kbd } from "@/components/common";
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

/** The live run of an agent, if it is working right now. */
export function useAgentLiveRun(agentId: string | undefined): LiveRun | null {
  return useLive((s) => (agentId ? (Object.values(s.runs).find((r) => r.agentId === agentId) ?? null) : null));
}

/** Start a fresh conversation with an agent and open it. */
export function useStartAgentChat() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const workspace = useScopeWorkspace();
  return useMutation({
    mutationFn: (agentId: string) => api.conversations.create({ agentId, workspaceId: workspace?.id }),
    onSuccess: (conversation) => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${conversation.id}`);
    },
    onError: (err) => toast.error("Couldn't start a chat", { description: errorMessage(err) }),
  });
}

export function useToggleAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.agents.update(id, { enabled }),
    onSuccess: (agent) => {
      qc.setQueryData(qk.agent(agent.id), agent);
      qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(agent.enabled ? `${agent.name} enabled` : `${agent.name} disabled`, {
        description: agent.enabled ? undefined : "Its automations won't run until you enable it again.",
      });
    },
    onError: (err) => toast.error("Couldn't update agent", { description: errorMessage(err) }),
  });
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

/** Status dot + label, live-aware ("Browsing github.com…" while running). */
export function AgentStatus({ agent, className, showActivity = true }: { agent: Agent; className?: string; showActivity?: boolean }) {
  const live = useAgentLiveRun(agent.id);
  const running = !!live || agent.status === "running";
  const state = !agent.enabled ? "disabled" : running ? "running" : agent.status === "error" ? "error" : "idle";
  const label =
    state === "running"
      ? showActivity && live?.activity
        ? live.activity
        : "Working…"
      : state === "disabled"
        ? "Disabled"
        : state === "error"
          ? "Last run failed"
          : "Idle";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", className)}>
      {state === "running" ? (
        <LiveDot className="shrink-0" />
      ) : (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state === "idle" && "bg-success",
            state === "error" && "bg-destructive",
            state === "disabled" && "bg-muted-foreground/50",
          )}
        />
      )}
      <span className={cn("truncate", state === "running" ? "text-shimmer font-medium" : "text-muted-foreground")}>{label}</span>
    </span>
  );
}
