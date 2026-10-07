import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ConversationWithMessages, RemoteRunner, RunnerAutofixInput, RunnerPatch } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { upsertRunner } from "@/lib/realtime";

type RunnerAction = "connect" | "sync" | "health" | "autofix" | "update" | "upgrade" | "remove";

/**
 * Reconnect, copy the setup, check health, fix with Claude, change and remove runners — with toasts, and the answer
 * patched into the cached list right away (realtime `runner.updated` keeps it current afterwards).
 */
export function useRunnerActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Per runner: several cards share these mutations, and each shows its own spinner.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (action: RunnerAction, id: string, on: boolean) =>
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(`${action}:${id}`);
      else next.delete(`${action}:${id}`);
      return next;
    });
  const isBusy = (action: RunnerAction, id: string) => busy.has(`${action}:${id}`);

  const connect = useMutation({
    mutationFn: (runner: RemoteRunner) => api.runners.connect(runner.id),
    onMutate: (runner) => mark("connect", runner.id, true),
    onSuccess: (next) => {
      void upsertRunner(qc, next);
      if (next.state === "online") toast.success(`${next.name} is online`);
      else if (next.state !== "connecting") toast.error(`Couldn't reach ${next.name}`, { description: next.error ?? undefined });
    },
    onError: (e, runner) => toastApiError(e, `Couldn't reach ${runner.name}`, qc),
    onSettled: (_res, _e, runner) => mark("connect", runner.id, false),
  });

  const sync = useMutation({
    mutationFn: (runner: RemoteRunner) => api.runners.sync(runner.id),
    onMutate: (runner) => mark("sync", runner.id, true),
    onSuccess: (next) => {
      void upsertRunner(qc, next);
      if (next.sync.state === "failed") toast.error(`Couldn't copy your setup to ${next.name}`, { description: next.sync.error ?? undefined });
      else toast.success(`Setup copied to ${next.name}`, { description: "Your agents, logins, integrations and settings are up to date there." });
    },
    onError: (e, runner) => toastApiError(e, `Couldn't copy your setup to ${runner.name}`, qc),
    onSettled: (_res, _e, runner) => mark("sync", runner.id, false),
  });

  /** Runs every check on the runner again; the report lands where the health panel reads it. */
  const checkHealth = useMutation({
    mutationFn: (runner: RemoteRunner) => api.runners.health(runner.id, true),
    onMutate: (runner) => mark("health", runner.id, true),
    onSuccess: async (health, runner) => {
      // A slower check that started earlier must not put the older report back.
      await qc.cancelQueries({ queryKey: qk.runnerHealth(runner.id) });
      qc.setQueryData(qk.runnerHealth(runner.id), health);
    },
    onError: (e, runner) => toastApiError(e, `Couldn't check ${runner.name}`, qc),
    onSettled: (_res, _e, runner) => mark("health", runner.id, false),
  });

  /** A chat on this computer whose agent looks at the runner and repairs it; opens the chat. */
  const autofix = useMutation({
    mutationFn: ({ runner, input }: { runner: RemoteRunner; input?: RunnerAutofixInput }) => api.runners.autofix(runner.id, input),
    onMutate: ({ runner }) => mark("autofix", runner.id, true),
    onSuccess: (res) => {
      qc.setQueryData<ConversationWithMessages>(qk.conversation(res.conversation.id), {
        ...res.conversation,
        messages: [res.message],
        activeRunId: res.run.status === "queued" || res.run.status === "running" ? res.run.id : null,
        queue: [],
      });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (e, { runner }) => toastApiError(e, `Couldn't start the repair of ${runner.name}`, qc),
    onSettled: (_res, _e, { runner }) => mark("autofix", runner.id, false),
  });

  /** Its Godmode to this computer's, its tools to their newest. The card follows the progress (runner.updated). */
  const upgrade = useMutation({
    mutationFn: (runner: RemoteRunner) => api.runners.upgrade(runner.id),
    onMutate: (runner) => mark("upgrade", runner.id, true),
    onSuccess: (next) => {
      void upsertRunner(qc, next);
      const u = next.update;
      if (u.state === "failed") toast.error(`Couldn't update ${next.name}`, { description: u.detail ?? undefined });
      else if (u.state === "waiting") toast.success(`${next.name} installs the update next`, { description: u.detail ?? undefined });
      else if (u.state === "current" && !u.tools.length) toast.success(`${next.name} is up to date`, { description: `Godmode ${u.target.version} and all of its tools.` });
    },
    onError: (e, runner) => toastApiError(e, `Couldn't update ${runner.name}`, qc),
    onSettled: (_res, _e, runner) => mark("upgrade", runner.id, false),
  });

  const update = useMutation({
    mutationFn: ({ runner, patch }: { runner: RemoteRunner; patch: RunnerPatch }) => api.runners.update(runner.id, patch),
    onMutate: ({ runner, patch }) => {
      mark("update", runner.id, true);
      // The switch in the menu answers at once.
      if (patch.syncBrowser !== undefined) void upsertRunner(qc, { ...runner, syncBrowser: patch.syncBrowser });
      if (patch.autoUpdate !== undefined) void upsertRunner(qc, { ...runner, update: { ...runner.update, autoUpdate: patch.autoUpdate } });
    },
    onSuccess: (next, { patch }) => {
      void upsertRunner(qc, next);
      if (patch.name !== undefined) toast.success(`Renamed to ${next.name}`);
      else if (patch.autoUpdate !== undefined)
        toast.success(next.update.autoUpdate ? "Updates install by themselves" : "Updates wait for you", {
          description: next.update.autoUpdate
            ? `${next.name} gets this computer's Godmode whenever it runs another one, once its chats are done.`
            : `${next.name} keeps its Godmode until you click Update.`,
        });
      else if (patch.syncBrowser !== undefined)
        toast.success(next.syncBrowser ? "Browser sessions are copied along" : "Browser sessions stay on this computer", {
          description: next.syncBrowser
            ? `Before a chat starts on ${next.name}, the cookies of its browser profile are copied there.`
            : `Chats on ${next.name} browse with the sign-ins that are already there.`,
        });
      else toast.success("Addresses saved", { description: `Godmode reaches ${next.name} through them from now on.` });
    },
    onError: (e, { runner }) => {
      void upsertRunner(qc, runner);
      toastApiError(e, `Couldn't change ${runner.name}`, qc);
    },
    onSettled: (_res, _e, { runner }) => mark("update", runner.id, false),
  });

  const remove = useMutation({
    mutationFn: (runner: RemoteRunner) => api.runners.remove(runner.id),
    onMutate: (runner) => mark("remove", runner.id, true),
    onSuccess: (_res, runner) => {
      qc.setQueryData<RemoteRunner[]>(qk.runners, (old) => old?.filter((r) => r.id !== runner.id));
      qc.removeQueries({ queryKey: qk.runnerHealth(runner.id) });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(`${runner.name} removed`, { description: runner.conversations > 0 ? "Its chats stay here, as chats of this computer." : undefined });
    },
    onError: (e, runner) => toastApiError(e, `Couldn't remove “${runner.name}”`, qc),
    onSettled: (_res, _e, runner) => mark("remove", runner.id, false),
  });

  return { connect, sync, checkHealth, autofix, upgrade, update, remove, isBusy };
}

export type RunnerActions = ReturnType<typeof useRunnerActions>;
