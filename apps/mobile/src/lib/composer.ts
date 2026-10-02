import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import type { Agent, ClaudeModel, ConversationWithMessages, Effort, QueuedMessage, SlashCommand } from "@godmode/shared";
import { DEFAULT_MODEL, EFFORT_OPTIONS, effortForModel, findModel } from "@godmode/shared";
import { api } from "./api";
import { qk, queryClient } from "./query";

export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** base64 without the data: prefix */
  data: string;
  /** Local file for image thumbnails */
  uri: string | null;
}

export interface Draft {
  text: string;
  files: PendingAttachment[];
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The phones' listener takes requests up to 64 MB, and base64 adds a third. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const EMPTY: Draft = { text: "", files: [] };

/** Unsent text and files per chat, kept while the app runs. */
export const useDrafts = create<{ drafts: Record<string, Draft>; set: (key: string, patch: Partial<Draft>) => void; clear: (key: string) => void }>((set) => ({
  drafts: {},
  set: (key, patch) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? EMPTY), ...patch } } })),
  clear: (key) =>
    set((s) => {
      const { [key]: _, ...rest } = s.drafts;
      return { drafts: rest };
    }),
}));

export function useDraft(key: string): Draft {
  return useDrafts((s) => s.drafts[key] ?? EMPTY);
}

/* Queue */

/** Queued messages this phone is still sending: they stay in the queue until the computer answers. */
export const pendingQueued = new Map<string, QueuedMessage>();

/** The computer's queue of a chat plus what this phone is still sending to it. */
export function withPending(conversationId: string, queue: QueuedMessage[]): QueuedMessage[] {
  const sending = [...pendingQueued.values()].filter((m) => m.conversationId === conversationId && !queue.some((q) => q.id === m.id));
  return sending.length ? [...queue, ...sending] : queue;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Id for a message about to be queued, so its row keeps its identity until the agent picks it up. */
export function newQueueId(): string {
  return `qmsg_${Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;
}

export function setQueue(conversationId: string, fn: (queue: QueuedMessage[]) => QueuedMessage[]) {
  queryClient.setQueryData<ConversationWithMessages>(qk.conversation(conversationId), (old) => (old ? { ...old, queue: fn(old.queue) } : old));
}

/* Attachments */

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function baseName(uri: string): string {
  return decodeURIComponent(uri.split("/").pop() ?? "file");
}

async function read(uri: string, name: string, mime: string | undefined, size: number | undefined): Promise<PendingAttachment> {
  const file = new File(uri);
  const data = await file.base64();
  return {
    id: `${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    mime: mime || MIME_BY_EXT[extOf(name)] || "application/octet-stream",
    size: size ?? file.size ?? Math.round((data.length * 3) / 4),
    data,
    uri: (mime ?? MIME_BY_EXT[extOf(name)] ?? "").startsWith("image/") ? uri : null,
  };
}

export type AttachSource = "photos" | "camera" | "files";

/** Opens the picker; resolves with the picked files (none when cancelled), or throws when access was denied. */
export async function pickAttachments(source: AttachSource, room: number): Promise<{ name: string; uri: string; mime?: string; size?: number }[]> {
  if (source === "files") {
    const res = await DocumentPicker.getDocumentAsync({ multiple: room > 1, copyToCacheDirectory: true, type: "*/*" });
    if (res.canceled) return [];
    return res.assets.map((a) => ({ name: a.name, uri: a.uri, mime: a.mimeType, size: a.size }));
  }
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("Allow camera access for Godmode in Settings to take a photo.");
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    quality: 0.8,
    allowsMultipleSelection: source === "photos" && room > 1,
    selectionLimit: room,
    // JPEG instead of HEIC: Claude reads JPEG, PNG, GIF and WebP.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  };
  const res = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (res.canceled) return [];
  return res.assets.map((a, i) => {
    // The picker hands out a converted copy: name it after what it is now.
    const ext = extOf(baseName(a.uri)) || "jpg";
    const stem = a.fileName ? a.fileName.replace(/\.[^.]+$/, "") : `photo-${Date.now()}${res.assets.length > 1 ? `-${i + 1}` : ""}`;
    return { name: `${stem}.${ext}`, uri: a.uri, mime: MIME_BY_EXT[ext] ?? a.mimeType, size: a.fileSize };
  });
}

/** Reads picked files, leaving out what doesn't fit; `skipped` says why something was left out. */
export async function readAttachments(
  picked: { name: string; uri: string; mime?: string; size?: number }[],
  current: PendingAttachment[],
): Promise<{ files: PendingAttachment[]; skipped: string | null }> {
  let total = current.reduce((n, a) => n + a.size, 0);
  const files: PendingAttachment[] = [];
  let skipped: string | null = null;
  for (const p of picked) {
    if (current.length + files.length >= MAX_ATTACHMENTS) {
      skipped = `You can attach up to ${MAX_ATTACHMENTS} files.`;
      break;
    }
    if ((p.size ?? 0) > MAX_ATTACHMENT_BYTES) {
      skipped = `${p.name} is larger than 25 MB.`;
      continue;
    }
    const file = await read(p.uri, p.name, p.mime, p.size);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      skipped = `${p.name} is larger than 25 MB.`;
      continue;
    }
    if (total + file.size > MAX_UPLOAD_BYTES) {
      skipped = "That's more than 40 MB for one message. Send the rest in another one.";
      continue;
    }
    total += file.size;
    files.push(file);
  }
  return { files, skipped };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* Slash commands */

export function useSlashCommands(agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentCommands(agentId ?? ""),
    queryFn: () => api.agents.commands(agentId!),
    enabled: !!agentId,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Custom commands first, then Claude Code's; with a query: best name match first. */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  const score = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (c.aliases.some((a) => a.toLowerCase().startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    if (q.length > 2 && c.description.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return commands
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

export function findCommand(commands: SlashCommand[] | undefined, name: string): SlashCommand | undefined {
  return commands?.find((c) => c.name === name || c.aliases.includes(name));
}

/* Model and effort */

export interface ModelChoice {
  /** null = the agent's model */
  model: string | null;
  /** null = the agent's effort */
  effort: Effort | null;
}

export const NO_CHOICE: ModelChoice = { model: null, effort: null };

/** The model picked for the next new chat (the compose sheet), until it starts. */
export const useNewChatChoice = create<{ choice: ModelChoice; set: (patch: Partial<ModelChoice>) => void; reset: () => void }>((set) => ({
  choice: NO_CHOICE,
  set: (patch) => set((s) => ({ choice: { ...s.choice, ...patch } })),
  reset: () => set({ choice: NO_CHOICE }),
}));

function customModel(id: string): ClaudeModel {
  return { id, resolvedModel: id, label: id, description: "Custom model id", efforts: [...EFFORT_OPTIONS], latest: true };
}

export function useModelCatalog() {
  return useQuery({ queryKey: qk.models, queryFn: () => api.models(), staleTime: 30 * 60_000 });
}

/** What a chat runs with: its override, else the agent's, else the computer's default. */
export function useEffectiveModel(agent: Agent | undefined, choice: ModelChoice) {
  const catalog = useModelCatalog();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const models = catalog.data?.models ?? [];
  const runner = boot.data?.settings.runner;
  const baseId = agent?.model?.trim() || runner?.model?.trim() || DEFAULT_MODEL;
  const base = findModel(models, baseId) ?? customModel(baseId);
  const current = choice.model ? (findModel(models, choice.model) ?? customModel(choice.model)) : base;
  const baseEffort: Effort = agent?.effort ?? runner?.effort ?? "high";
  const effort = effortForModel(current.efforts, choice.effort ?? baseEffort);
  return { catalog, base, baseEffort, current, effort };
}
