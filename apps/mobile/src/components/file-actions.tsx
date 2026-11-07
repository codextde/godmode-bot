import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Alert } from "react-native";
import type { MobileSession } from "@godmode/shared";
import { useFullAccess } from "./full-access";
import type { HeaderMenuItem } from "./header-actions";
import { showToast } from "./toast";
import { api, errorText, request } from "@/lib/api";
import { isLocked } from "@/lib/agent-files";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { isGatewayUrl, useSession } from "@/lib/session";

/** A dream of the agent runs: its files are frozen until it ends (the computer refuses changes meanwhile). */
export function useDreamingNow(agentId: string): boolean {
  const { data } = useQuery({ queryKey: qk.dreams(agentId), queryFn: () => api.dreams.overview(agentId), select: (o) => o.active?.status === "running" });
  return !!data;
}

export const openRename = (agent: string, path: string) => router.push({ pathname: "/files/name", params: { agent, mode: "rename", path } });
export const openNew = (agent: string, mode: "note" | "folder", dir: string) => router.push({ pathname: "/files/name", params: { agent, mode, dir } });
export const openMove = (agent: string, path: string) => router.push({ pathname: "/files/move", params: { agent, path } });
export const openMoveMany = (agent: string, paths: string[]) => router.push({ pathname: "/files/move", params: { agent, paths: JSON.stringify(paths) } });
export const openDelete = (agent: string, path: string) => router.push({ pathname: "/files/delete", params: { agent, path } });
export const openDeleteMany = (agent: string, paths: string[]) => router.push({ pathname: "/files/delete", params: { agent, paths: JSON.stringify(paths) } });

/** The computer's file manager is for a phone with full access on a direct connection: Godmode Cloud refuses it. */
export function useCanShowOnComputer(): boolean {
  const { fullAccess } = useFullAccess();
  const url = useSession((s) => s.connection?.activeUrl);
  return fullAccess === true && !isGatewayUrl(url);
}

/** The same, at the moment of a tap outside of a screen's rendering. */
export function canShowOnComputer(): boolean {
  return queryClient.getQueryData<MobileSession>(qk.me)?.fullAccess === true && !isGatewayUrl(useSession.getState().connection?.activeUrl);
}

/** Selects the file or opens the folder in the computer's file manager, for whoever sits there. */
export async function showOnComputer(path: string) {
  try {
    await request<{ ok: true }>("POST", "/api/files/reveal", { path });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    showToast(t("files:reveal.done"));
  } catch (err) {
    Alert.alert(t("files:reveal.failed"), errorText(err));
  }
}

export const revealItem = (path: string): HeaderMenuItem => ({ icon: "display", title: t("files:reveal.action"), onPress: () => void showOnComputer(path) });

/** Rename, move and delete for one entry, like the desktop's row menu; nothing for Godmode's own files or while it dreams. */
export function entryActions(agent: string, path: string, frozen: boolean): HeaderMenuItem[] {
  if (isLocked(path) || frozen) return [];
  return [
    { icon: "pencil", title: t("common:actions.rename"), onPress: () => openRename(agent, path) },
    { icon: "move", title: t("files:actions.move"), onPress: () => openMove(agent, path) },
    { icon: "trash", title: t("common:actions.delete"), destructive: true, onPress: () => openDelete(agent, path) },
  ];
}
