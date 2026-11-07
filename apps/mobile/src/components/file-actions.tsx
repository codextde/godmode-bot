import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import type { HeaderMenuItem } from "./header-actions";
import { api } from "@/lib/api";
import { isLocked } from "@/lib/agent-files";
import { t } from "@/lib/i18n";
import { qk } from "@/lib/query";

/** A dream of the agent runs: its files are frozen until it ends (the computer refuses changes meanwhile). */
export function useDreamingNow(agentId: string): boolean {
  const { data } = useQuery({ queryKey: qk.dreams(agentId), queryFn: () => api.dreams.overview(agentId), select: (o) => o.active?.status === "running" });
  return !!data;
}

export const openRename = (agent: string, path: string) => router.push({ pathname: "/files/name", params: { agent, mode: "rename", path } });
export const openNew = (agent: string, mode: "note" | "folder", dir: string) => router.push({ pathname: "/files/name", params: { agent, mode, dir } });
export const openMove = (agent: string, path: string) => router.push({ pathname: "/files/move", params: { agent, path } });
export const openDelete = (agent: string, path: string) => router.push({ pathname: "/files/delete", params: { agent, path } });
export const openDeleteMany = (agent: string, paths: string[]) => router.push({ pathname: "/files/delete", params: { agent, paths: JSON.stringify(paths) } });

/** Rename, move and delete for one entry, like the desktop's row menu; nothing for Godmode's own files or while it dreams. */
export function entryActions(agent: string, path: string, frozen: boolean): HeaderMenuItem[] {
  if (isLocked(path) || frozen) return [];
  return [
    { icon: "pencil", title: t("common:actions.rename"), onPress: () => openRename(agent, path) },
    { icon: "move", title: t("files:actions.move"), onPress: () => openMove(agent, path) },
    { icon: "trash", title: t("common:actions.delete"), destructive: true, onPress: () => openDelete(agent, path) },
  ];
}
