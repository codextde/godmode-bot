import { create } from "zustand";
import type { MessageBlock, Run } from "@godmode/shared";

export type LinkStatus = "connecting" | "online" | "offline";

export interface LiveRun {
  run: Run;
  /** What the agent is doing right now, e.g. "Opening github.com". */
  activity: string | null;
}

export interface Draft {
  runId: string;
  messageId: string;
  blocks: MessageBlock[];
}

export interface Frame {
  data: string;
  mime: string;
  width: number;
  height: number;
  title: string;
  url?: string;
  error?: string;
  at: number;
}

interface LiveState {
  status: LinkStatus;
  runs: Record<string, LiveRun>;
  /** Latest activity per run; may arrive before the run itself is known. */
  labels: Record<string, string>;
  drafts: Record<string, Draft>;
  frames: Record<string, Frame>;
  setStatus: (status: LinkStatus) => void;
  seedRuns: (runs: Run[]) => void;
  runStarted: (run: Run) => void;
  runActivity: (runId: string, label: string) => void;
  runFinished: (run: Run) => void;
  delta: (conversationId: string, draft: Draft) => void;
  frame: (key: string, frame: Frame) => void;
  dropFrame: (key: string) => void;
}

export const useLive = create<LiveState>((set) => ({
  status: "connecting",
  runs: {},
  labels: {},
  drafts: {},
  frames: {},
  setStatus: (status) => set({ status }),
  seedRuns: (runs) =>
    set((s) => {
      const ids = new Set(runs.map((r) => r.id));
      return {
        runs: Object.fromEntries(runs.map((run) => [run.id, { run, activity: s.labels[run.id] ?? null }])),
        labels: Object.fromEntries(Object.entries(s.labels).filter(([id]) => ids.has(id))),
        drafts: Object.fromEntries(Object.entries(s.drafts).filter(([, d]) => ids.has(d.runId))),
      };
    }),
  runStarted: (run) => set((s) => ({ runs: { ...s.runs, [run.id]: { run, activity: s.labels[run.id] ?? null } } })),
  runActivity: (runId, label) =>
    set((s) => ({
      labels: { ...s.labels, [runId]: label },
      runs: s.runs[runId] ? { ...s.runs, [runId]: { ...s.runs[runId]!, activity: label } } : s.runs,
    })),
  runFinished: (run) =>
    set((s) => {
      const { [run.id]: _gone, ...runs } = s.runs;
      const { [run.id]: _label, ...labels } = s.labels;
      const drafts = { ...s.drafts };
      if (drafts[run.conversationId]?.runId === run.id) delete drafts[run.conversationId];
      return { runs, labels, drafts };
    }),
  delta: (conversationId, draft) => set((s) => ({ drafts: { ...s.drafts, [conversationId]: draft } })),
  frame: (key, frame) => set((s) => ({ frames: { ...s.frames, [key]: frame } })),
  dropFrame: (key) =>
    set((s) => {
      const { [key]: _gone, ...frames } = s.frames;
      return { frames };
    }),
}));

/** The run working on this conversation right now (a queued follow-up only when nothing runs). */
export function useConversationRun(conversationId: string | undefined): LiveRun | undefined {
  return useLive((s) => {
    if (!conversationId) return undefined;
    const runs = Object.values(s.runs).filter((r) => r.run.conversationId === conversationId);
    return runs.find((r) => r.run.status === "running") ?? runs[0];
  });
}
