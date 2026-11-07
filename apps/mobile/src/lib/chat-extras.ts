import { useQuery } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { router } from "expo-router";
import type { Conversation, DeviceGroup, MoveChatInput, RunnerState, SharedChatPreview } from "@godmode/shared";
import { request } from "./api";
import { t } from "./i18n";

/** Sharing a chat as a code or file, opening one shared with you, and moving a chat to another computer of the group. */
export const chatExtrasApi = {
  share: (id: string, opts: { context: boolean; files: boolean; screenshots: boolean }) =>
    request<{ code: string; fileName: string; bytes: number; messages: number; withContext: boolean }>("POST", `/api/conversations/${id}/share`, opts, 60_000),
  previewImport: (data: string) => request<SharedChatPreview>("POST", "/api/conversations/import/preview", { data }, 60_000),
  import: (input: { data: string; agentId: string; workspaceId?: string | null; projectId?: string | null }) =>
    request<Conversation>("POST", "/api/conversations/import", input, 120_000),
  /** Copies the Claude session and transcript over: big chats take a while. */
  move: (id: string, input: MoveChatInput) => request<Conversation>("POST", `/api/conversations/${id}/move`, input, 600_000),
  group: () => request<DeviceGroup>("GET", "/api/devices"),
};

/** A computer of the device group a chat can work on: `runnerId` is how the API names it (null = the primary). */
export interface Place {
  runnerId: string | null;
  name: string;
  state: RunnerState;
  self: boolean;
}

/** The computers of the group this phone's computer is in; empty outside a group. */
export function usePlaces(enabled = true): Place[] {
  const group = useQuery({ queryKey: ["devices", "group"], queryFn: chatExtrasApi.group, enabled, staleTime: 30_000 });
  if (!group.data?.role) return [];
  return group.data.devices.map((d) => ({ runnerId: d.id, name: d.name, state: d.state, self: d.self }));
}

/** Where a chat can go: the other computers of the group that are online now. */
export function moveTargets(places: Place[], chatRunnerId: string | null | undefined): Place[] {
  return places.filter((p) => p.runnerId !== (chatRunnerId ?? null) && p.state === "online");
}

const CHAT_FILE_EXT = ".godmode-chat";
/** A shared chat is a few megabytes at most; more is not a chat file. */
export const MAX_CHAT_FILE_BYTES = 150 * 1024 * 1024;

export const isChatFile = (file: { name: string }) => file.name.toLowerCase().endsWith(CHAT_FILE_EXT);

/** What the import sheet opens with: a code pasted into a message field or a chat file picked there. Too long for a route. */
let handed: { data: string; name: string | null } | null = null;

export function takeChatImport() {
  const given = handed;
  handed = null;
  return given;
}

export function openChatImport(data: string, name: string | null = null) {
  handed = { data, name };
  router.push("/chat-import");
}

export async function openChatFile(file: { uri: string; name: string }) {
  const picked = new File(file.uri);
  if ((picked.size ?? 0) > MAX_CHAT_FILE_BYTES) throw new Error(t("chat:import.tooBig"));
  openChatImport(await picked.text(), file.name);
}
