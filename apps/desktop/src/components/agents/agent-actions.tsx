import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Play } from "lucide-react";
import type { Agent, AgentPresence, CharacterMood } from "@godmode/shared";
import { agentPresence } from "@godmode/shared";
import { t as translate } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useMissingLogins, useScopeWorkspace } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { clearDraft, useDraft } from "@/lib/drafts";
import { useLive, useLiveRunsMap, type LiveRun } from "@/stores/live";
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
  const runs = useLiveRunsMap();
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

/** The agent's presence as a short status line in the app language. */
export function agentPresenceLabel(p: AgentPresence): string {
  switch (p.state) {
    case "off":
      return translate("agents:agentActions.presence.off");
    case "working":
      return p.running > 1 ? translate("agents:agentActions.presence.workingMany", { n: p.running }) : translate("agents:agentActions.presence.working");
    case "waiting":
      if (!p.waiting) return translate("agents:agentActions.presence.needsLogin");
      return p.waiting > 1 ? translate("agents:agentActions.presence.needsYouMany", { n: p.waiting }) : translate("agents:agentActions.presence.needsAnswer");
    case "failed":
      return translate("agents:agentActions.presence.failed");
    case "paused":
      return p.paused > 1 ? translate("agents:agentActions.presence.pausedMany", { n: p.paused }) : translate("agents:agentActions.presence.paused");
    case "queued":
      return p.queued > 1 ? translate("agents:agentActions.presence.queuedMany", { n: p.queued }) : translate("agents:agentActions.presence.queued");
    default:
      return translate("agents:agentActions.presence.idle");
  }
}

/** Start a fresh conversation with an agent and open it. A switched-off agent gets a "Switch on and chat" offer instead. */
export function useStartAgentChat() {
  const { t } = useTranslation("agents");
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
    onError: (err) => toast.error(t("agentActions.startChat.error"), { description: errorMessage(err) }),
  });
  return {
    ...mutation,
    mutate: (agent: ChatTarget) => {
      if (agent.enabled) return mutation.mutate({ agent });
      toast(t("agentActions.startChat.offTitle", { name: agent.name }), {
        description: t("agentActions.startChat.offDescription"),
        action: { label: t("agentActions.startChat.switchOnAndChat"), onClick: () => mutation.mutate({ agent, switchOn: true }) },
      });
    },
  };
}

export function useToggleAgent() {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.agents.update(id, { enabled }),
    onSuccess: (agent) => {
      qc.setQueryData(qk.agent(agent.id), agent);
      qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(agent.enabled ? t("agentActions.toggle.on", { name: agent.name }) : t("agentActions.toggle.off", { name: agent.name }), {
        description: agent.enabled ? undefined : t("agentActions.toggle.offDescription"),
      });
    },
    onError: (err) => toast.error(t("agentActions.toggle.error"), { description: errorMessage(err) }),
  });
}

/** Copy an agent's setup (the passphrase first when it may read secrets) and open the copy's settings. */
export function useDuplicateAgent() {
  const { t } = useTranslation("agents");
  const navigate = useNavigate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agent: Agent) =>
      agent.permissions.secretAccess === "reveal" ? withGrant((grant) => api.agents.duplicate(agent.id, grant), t("agentActions.duplicate.grant", { name: agent.name })) : api.agents.duplicate(agent.id),
    onSuccess: (copy, source) => {
      qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(t("agentActions.duplicate.ready", { name: copy.name }), { description: t("agentActions.duplicate.readyDescription", { source: source.name }) });
      navigate(`/agents/${copy.id}/settings`);
    },
    onError: (err, source) => {
      if (!isGrantCancelled(err)) toast.error(t("agentActions.duplicate.error", { name: source.name }), { description: errorMessage(err) });
    },
  });
}

/** Pause everything an agent is working on, and continue it where it stopped. */
export function useAgentPause() {
  const { t } = useTranslation("agents");
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
      toast(t("agentActions.pause.pausing", { name: agent.name }), { description: paused > 1 ? t("agentActions.pause.many", { n: paused }) : t("agentActions.pause.one") });
    },
    onError: (err) => toast.error(t("agentActions.pause.error"), { description: errorMessage(err) }),
  });
  const resume = useMutation({
    mutationFn: (agent: Agent) => api.agents.continue(agent.id),
    onSuccess: ({ continued }, agent) => {
      refresh();
      toast.success(t("agentActions.resume.continues", { name: agent.name }), { description: continued > 1 ? t("agentActions.resume.many", { n: continued }) : t("agentActions.resume.one") });
    },
    onError: (err) => {
      refresh();
      toast.error(t("agentActions.resume.error"), { description: errorMessage(err) });
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
  const { t } = useTranslation(["agents", "common"]);
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
      toast.success(t("agentActions.runTask.onIt", { name: agent?.name ?? t("common:words.agent") }));
      // Text typed while it was starting stays as the next draft.
      if (input.agentId !== agent?.id) clearDraft(`run-task:${input.agentId}`);
      else if (prompt.trim() === input.prompt) promptDraft.discard();
      onOpenChange(false);
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (err) => toast.error(t("agentActions.runTask.error"), { description: errorMessage(err) }),
  });
  const canRun = !!agent && !run.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {agent && <AgentAvatar agent={agent} size="md" />}
            <div>
              <DialogTitle>{agent ? t("agentActions.runTask.titleWith", { name: agent.name }) : t("agentActions.runTask.title")}</DialogTitle>
              <DialogDescription>{t("agentActions.runTask.description")}</DialogDescription>
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
              {t("agentActions.runTask.label")} <span className="font-normal text-muted-foreground">({t("common:words.optional")})</span>
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
              placeholder={agent?.description ? t("agentActions.runTask.placeholderExample", { description: agent.description }) : t("agentActions.runTask.placeholder")}
              aria-describedby="run-task-hint"
              className="min-h-32 resize-none text-[15px]"
            />
            <p id="run-task-hint" className="text-xs text-muted-foreground">
              {agent?.name ? t("agentActions.runTask.hint", { name: agent.name }) : t("agentActions.runTask.hintGeneric")}
            </p>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd> {t("agentActions.runTask.toRun")}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" disabled={!canRun}>
                {run.isPending ? <Spinner /> : <Play />}
                {t("agentActions.runTask.submit")}
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
  const { t } = useTranslation(["agents", "common"]);
  const agent = useLatest(agentProp);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.agents.delete(agent!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.routines });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(t("agentActions.delete.deleted", { name: agent?.name ?? t("common:words.agent") }));
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (err) => toast.error(t("agentActions.delete.error"), { description: errorMessage(err) }),
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("agentActions.delete.title", { name: agent?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{t("agentActions.delete.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              del.mutate();
            }}
            disabled={del.isPending}
            variant="destructive"
          >
            {del.isPending && <Spinner />}
            {t("agentActions.delete.confirm")}
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
  const { t } = useTranslation("agents");
  const live = useAgentLiveRun(agent.id);
  const presence = useAgentPresence(agent);
  const { state } = presence;
  const label = state === "working" && presence.running === 1 && showActivity && live?.activity ? live.activity : agentPresenceLabel(presence);
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
      <Link to={`/settings/activity?run=${agent.failedRunId}`} className={linkClass} title={t("agentActions.status.openFailedRun")} onClick={(e) => e.stopPropagation()}>
        {dot}
        {text}
      </Link>
    );
  }
  if (interactive && state === "working" && presence.running === 1 && live) {
    return (
      <Link to={`/chat/${live.conversationId}`} className={linkClass} aria-label={t("agentActions.status.watch", { name: agent.name, activity: label })} onClick={(e) => e.stopPropagation()}>
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
