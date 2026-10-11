import { useMemo } from "react";
import { create } from "zustand";
import { applyRunDelta, type MessageBlock, type Run, type RunDelta } from "@godmode/shared";

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
  seq: number;
  stream?: string;
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
  /** Why it's offline in the cloud gateway's words (computer not connected, plan limit), when it said so. */
  offlineReason: string | null;
  runs: Record<string, LiveRun>;
  /** Runs seen ending lately: an answer that arrives after their end doesn't bring them back as live. */
  ended: string[];
  /** Latest activity per run; may arrive before the run itself is known. */
  labels: Record<string, string>;
  drafts: Record<string, Draft>;
  frames: Record<string, Frame>;
  setStatus: (status: LinkStatus, offlineReason?: string | null) => void;
  seedRuns: (runs: Run[]) => void;
  runStarted: (run: Run) => void;
  runActivity: (runId: string, label: string) => void;
  runFinished: (run: Run) => void;
  /** False when the delta doesn't fit what the phone has of the run (it missed one): ask for the whole list then. */
  delta: (event: RunDelta) => boolean;
  frame: (key: string, frame: Frame) => void;
  dropFrame: (key: string) => void;
}

export const useLive = create<LiveState>((set, get) => ({
  status: "connecting",
  offlineReason: null,
  runs: {},
  ended: [],
  labels: {},
  drafts: {},
  frames: {},
  setStatus: (status, offlineReason = null) => set({ status, offlineReason }),
  seedRuns: (runs) =>
    set((s) => {
      const ids = new Set(runs.map((r) => r.id));
      return {
        runs: Object.fromEntries(runs.map((run) => [run.id, { run, activity: s.labels[run.id] ?? null }])),
        labels: Object.fromEntries(Object.entries(s.labels).filter(([id]) => ids.has(id))),
        drafts: Object.fromEntries(Object.entries(s.drafts).filter(([, d]) => ids.has(d.runId))),
      };
    }),
  runStarted: (run) => set((s) => (s.ended.includes(run.id) ? s : { runs: { ...s.runs, [run.id]: { run, activity: s.labels[run.id] ?? null } } })),
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
      return { runs, labels, drafts, ended: [...s.ended.slice(-49), run.id] };
    }),
  delta: (event) => {
    const have = get().drafts[event.conversationId];
    const next = applyRunDelta(have?.runId === event.runId ? have : null, event);
    if (!next) return false;
    set((s) => ({ drafts: { ...s.drafts, [event.conversationId]: { runId: event.runId, messageId: event.messageId, ...next } } }));
    return true;
  },
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

export interface RunCount {
  running: number;
  queued: number;
}

/**
 * Running and queued runs per agent. Selected as a string so a screen re-renders when a number changes, not on every
 * activity label of every run.
 */
export function useRunCounts(): Map<string, RunCount> {
  const key = useLive((s) =>
    Object.values(s.runs)
      .map(({ run }) => `${run.agentId} ${run.status}`)
      .sort()
      .join("\n"),
  );
  return useMemo(() => {
    const counts = new Map<string, RunCount>();
    for (const line of key ? key.split("\n") : []) {
      const [agentId, status] = line.split(" ");
      const n = counts.get(agentId!) ?? { running: 0, queued: 0 };
      if (status === "running") n.running++;
      else if (status === "queued") n.queued++;
      counts.set(agentId!, n);
    }
    return counts;
  }, [key]);
}

/** Chats with a run in them, re-rendering only when that set changes. */
export function useRunningChats(): Set<string> {
  const key = useLive((s) => [...new Set(Object.values(s.runs).map(({ run }) => run.conversationId))].sort().join("\n"));
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}
