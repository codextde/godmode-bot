import { useMutation } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useNavigation } from "expo-router";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import type { HeaderMenuItem } from "./header-actions";
import { useArchive } from "@/lib/archive";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";

/** Only the notes: everything the phone opens of an agent's folder stays under memory/. */
export const NOTES_DIR = "memory";

export const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** What went wrong, in words; an older Godmode on the computer that refuses this asks to be updated. */
export function failureText(err: unknown): string {
  return err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err);
}

/** Closes the settings sheet however deep in it the screen is, then goes on (`then`) outside it. */
export function useLeaveSettings() {
  const navigation = useNavigation();
  return (then?: () => void) => {
    const root = navigation.getParent();
    if (root?.canGoBack()) root.goBack();
    else router.back();
    then?.();
  };
}

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: qk.agents });
  void queryClient.invalidateQueries({ queryKey: qk.conversations });
  void queryClient.invalidateQueries({ queryKey: qk.runs });
};

/**
 * The desktop's agent actions, for the agent screen's menu: run it once, pause or continue all its work, change its look,
 * copy it (one that reads secrets in plain text is copied on the computer) and delete it (never the built-in agent).
 */
export function useAgentMenu(agent: Agent, { working, paused }: { working: boolean; paused: boolean }): HeaderMenuItem[] {
  const { t } = useTranslation(["agents", "common", "archive"]);
  const done = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  const pause = useMutation({
    mutationFn: () => api.agents.pause(agent.id),
    onSuccess: () => {
      done();
      refresh();
    },
    onError: (err) => {
      refresh();
      Alert.alert(t("actions.pauseFailed"), failureText(err));
    },
  });
  const resume = useMutation({
    mutationFn: () => api.agents.resume(agent.id),
    onSuccess: () => {
      done();
      refresh();
    },
    onError: (err) => {
      refresh();
      Alert.alert(t("actions.continueFailed"), failureText(err));
    },
  });
  const duplicate = useMutation({
    mutationFn: () => api.agents.duplicate(agent.id),
    onSuccess: (copy) => {
      done();
      queryClient.setQueryData<Agent[]>(qk.agents, (old) => (old ? [...old, copy] : old));
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      router.push({ pathname: "/settings/agent/[id]", params: { id: copy.id } });
    },
    onError: (err) => Alert.alert(t("actions.duplicateFailed", { name: agent.name }), failureText(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.agents.remove(agent.id),
    onSuccess: () => {
      done();
      router.back();
      queryClient.setQueryData<Agent[]>(qk.agents, (old) => old?.filter((a) => a.id !== agent.id));
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.routines });
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: (err) => Alert.alert(t("actions.deleteFailed"), failureText(err)),
  });
  const confirmDelete = () =>
    Alert.alert(t("actions.deleteTitle", { name: agent.name }), t("actions.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("actions.deleteConfirm"), style: "destructive", onPress: () => remove.mutate() },
    ]);

  const { archive } = useArchive(() => router.back());
  const items: HeaderMenuItem[] = [];
  if (agent.enabled) items.push({ icon: "play", title: t("actions.runNow"), onPress: () => router.push({ pathname: "/agent-run", params: { agentId: agent.id } }) });
  if (working) items.push({ icon: "pause", title: t("actions.pauseAll"), onPress: () => !pause.isPending && pause.mutate() });
  if (paused) items.push({ icon: "play", title: t("actions.continueAll"), onPress: () => !resume.isPending && resume.mutate() });
  items.push({ icon: "palette", title: t("actions.look"), onPress: () => router.push({ pathname: "/settings/look/[id]", params: { id: agent.id } }) });
  if (!agent.isDefault && agent.permissions?.secretAccess !== "reveal") {
    items.push({ icon: "copy", title: t("actions.duplicate"), onPress: () => !duplicate.isPending && duplicate.mutate() });
  }
  if (!agent.isDefault && !agent.archived) items.push({ icon: "archive", title: t("archive:archive"), onPress: () => archive({ kind: "agent", id: agent.id, name: agent.name }) });
  if (!agent.isDefault) items.push({ icon: "trash", title: t("actions.delete"), destructive: true, onPress: confirmDelete });
  return items;
}
