import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentFilesDeleteResult } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cloudContext, isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { copyText } from "@/components/chat/copy-button";
import { nameOf } from "./file-editor";

/** The core runs on this machine: its file manager can show a path. */
export const canReveal = isTauri && !cloudContext;
export const REVEAL_LABEL = canReveal ? (isMac ? "Show in Finder" : "Show in folder") : "Copy path";

export function joinPath(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name;
}

/** tmp/ is cleared without the bin, uploads/ holds the human's attachments: nothing is made or moved there. */
export function reservedPlace(path: string) {
  const lower = path.toLowerCase();
  return ["workspace/tmp", "workspace/uploads"].some((r) => lower === r || lower.startsWith(`${r}/`));
}

/** Where new entries may go and entries may be moved: inside workspace/ or memory/, not tmp/ or uploads/. */
export function placeable(path: string) {
  return (path.startsWith("workspace/") || path.startsWith("memory/") || path === "workspace" || path === "memory") && !reservedPlace(path);
}

/** Of what names a path, what Godmode can't rewrite on a move: the agent's instructions, automations and follow-ups. */
export function pinsAmong(names: string[]) {
  return names.filter((n) => /^(the instructions|the automation |a follow-up)/.test(n));
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Everything the Files page shows about an agent goes stale after a change. */
export function useRefreshFiles(agentId: string) {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.agentFilesPage(agentId) });
    qc.invalidateQueries({ queryKey: ["agents", "files", agentId] });
    qc.invalidateQueries({ queryKey: ["agents", "file", agentId] });
    qc.invalidateQueries({ queryKey: qk.agentCommits(agentId) });
    qc.invalidateQueries({ queryKey: qk.agentMemory(agentId) });
    qc.invalidateQueries({ queryKey: qk.filesOverview });
  }, [qc, agentId]);
}

export function useReveal(repoPath: string) {
  return useCallback(
    (rel: string) => {
      const abs = rel ? `${repoPath}/${rel}` : repoPath;
      if (!canReveal) {
        void copyText(abs).then((ok) => ok && toast.success("Path copied"));
        return;
      }
      api.files.reveal(abs).catch((err) => toast.error(`Couldn't open ${isMac ? "Finder" : "the file manager"}`, { description: errorMessage(err) }));
    },
    [repoPath],
  );
}

/** Delete into the bin, with an Undo on the toast that puts everything back. */
export function useDeleteFiles(agentId: string, onDone?: (result: AgentFilesDeleteResult) => void) {
  const refresh = useRefreshFiles(agentId);
  const restore = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.agents.restoreDeleted(agentId, id);
    },
    onSuccess: (_, ids) => {
      refresh();
      toast.success(ids.length === 1 ? "Put back" : `Put ${ids.length} back`);
    },
    onError: (err) => {
      refresh();
      toast.error("Couldn't put everything back", { description: `${errorMessage(err)} — the rest is in the bin.` });
    },
  });
  return useMutation({
    mutationFn: (paths: string[]) => api.agents.deleteFiles(agentId, paths),
    onSuccess: (result) => {
      refresh();
      onDone?.(result);
      const { deleted, refused } = result;
      if (deleted.length) {
        const bytes = deleted.reduce((n, d) => n + d.bytes, 0);
        toast.success(deleted.length === 1 ? `Deleted ${nameOf(deleted[0]!.path)}` : `Deleted ${deleted.length} items`, {
          description: `${formatBytes(bytes)} moved to the bin.${refused.length ? ` ${plural(refused.length, "item")} stayed.` : ""}`,
          action: { label: "Undo", onClick: () => restore.mutate(deleted.map((d) => d.id)) },
        });
      } else if (refused.length) {
        toast.error(refused.length === 1 ? `${nameOf(refused[0]!.path)} stays` : "Nothing was deleted", { description: refused[0]!.reason });
      }
    },
    onError: (err) => toast.error("Couldn't delete", { description: errorMessage(err) }),
  });
}

/** Move or rename one entry or several, one after the other. */
export function useMoveFiles(agentId: string, onMoved?: (moves: { from: string; to: string }[]) => void) {
  const refresh = useRefreshFiles(agentId);
  return useMutation({
    mutationFn: async (moves: { from: string; to: string }[]) => {
      const done: { from: string; to: string }[] = [];
      const rewritten = new Set<string>();
      try {
        for (const m of moves) {
          const r = await api.agents.moveFile(agentId, m.from, m.to);
          done.push({ from: m.from, to: r.path });
          r.rewritten.forEach((p) => rewritten.add(p));
        }
      } catch (err) {
        if (done.length) onMoved?.(done);
        throw err;
      }
      return { done, rewritten: [...rewritten] };
    },
    onSuccess: ({ done, rewritten }) => {
      refresh();
      onMoved?.(done);
      const one = done.length === 1 ? done[0]! : null;
      const renamed = one && one.from.slice(0, one.from.lastIndexOf("/")) === one.to.slice(0, one.to.lastIndexOf("/"));
      toast.success(one ? (renamed ? `Renamed to ${nameOf(one.to)}` : `Moved ${nameOf(one.to)}`) : `Moved ${done.length} items`, {
        description: rewritten.length ? `Updated the path in ${rewritten.join(", ")}.` : undefined,
      });
    },
    onError: (err) => {
      refresh();
      toast.error("Couldn't move", { description: errorMessage(err) });
    },
  });
}
