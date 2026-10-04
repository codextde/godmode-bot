import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import type { Agent, ClaudeModel, ConversationWithMessages, Effort, ModelCatalog, QueuedMessage, SlashCommand } from "@godmode/shared";
import { BUILTIN_MODELS, DEFAULT_MODEL, EFFORT_OPTIONS, effortForModel, findModel } from "@godmode/shared";
import { api } from "./api";
import type { PendingFile } from "./attachments";
import { qk, queryClient } from "./query";

export interface Draft {
  text: string;
  files: PendingFile[];
}

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

export function setQueue(conversationId: string, fn: (queue: QueuedMessage[]) => QueuedMessage[]) {
  queryClient.setQueryData<ConversationWithMessages>(qk.conversation(conversationId), (old) => (old ? { ...old, queue: fn(old.queue) } : old));
}

/* Slash commands */

export function useSlashCommands(agentId?: string) {
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

export function findCommand(commands: SlashCommand[] = [], name: string): SlashCommand | null {
  return commands.find((c) => c.name === name || c.aliases.includes(name)) ?? null;
}

/* Model and effort */

export interface ModelChoice {
  /** null = the agent's model */
  model: string | null;
  /** null = the agent's effort */
  effort: Effort | null;
  /** null = the agent's Ultracode setting */
  ultracode: boolean | null;
}

export const NO_CHOICE: ModelChoice = { model: null, effort: null, ultracode: null };

/** The model picked for the next new chat (the compose sheet), until it starts. */
export const useNewChatChoice = create<{ choice: ModelChoice; set: (patch: Partial<ModelChoice>) => void; reset: () => void }>((set) => ({
  choice: NO_CHOICE,
  set: (patch) => set((s) => ({ choice: { ...s.choice, ...patch } })),
  reset: () => set({ choice: NO_CHOICE }),
}));

function customModel(id: string, ultracode: boolean): ClaudeModel {
  return { id, resolvedModel: id, label: id, description: "Custom model id", efforts: [...EFFORT_OPTIONS], ultracode, latest: true };
}

const BUILTIN_CATALOG: ModelCatalog = { models: BUILTIN_MODELS, source: "builtin", claudeVersion: null, fetchedAt: "", error: null };

/** Models offered by the installed Claude Code; the built-in list until it answers. */
export function useModelCatalog() {
  return useQuery({ queryKey: qk.models, queryFn: () => api.models(), staleTime: 30 * 60_000, placeholderData: BUILTIN_CATALOG });
}

/** What a chat runs with: its override, else the agent's, else the computer's default. */
export function useEffectiveModel(agent: Agent | null | void, choice: ModelChoice) {
  const catalog = useModelCatalog();
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const models = catalog.data?.models ?? [];
  const runner = boot.data?.settings.runner;
  // Nobody knows what a custom model id can do: it gets Ultracode whenever this Claude Code has it at all.
  const anyUltracode = models.some((m) => m.ultracode);
  const baseId = agent?.model?.trim() || runner?.model?.trim() || DEFAULT_MODEL;
  const base = findModel(models, baseId) ?? customModel(baseId, anyUltracode);
  const current = choice.model ? (findModel(models, choice.model) ?? customModel(choice.model, anyUltracode)) : base;
  const baseEffort: Effort = agent?.effort ?? runner?.effort ?? "high";
  const effort = effortForModel(current.efforts, choice.effort ?? baseEffort);
  const baseUltracode = agent?.ultracode ?? runner?.ultracode ?? false;
  const ultracode = current.ultracode && (choice.ultracode ?? baseUltracode);
  return { catalog, base, baseEffort, baseUltracode, anyUltracode, current, effort, ultracode };
}
