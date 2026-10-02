import { create } from "zustand";
import type { MessageBlock, Run } from "@godmode/shared";

export interface LiveRun {
  runId: string;
  agentId: string;
  conversationId: string;
  messageId: string | null;
  blocks: MessageBlock[];
  status: Run["status"];
  /** Unknown for a run first seen through its stream. */
  trigger?: Run["trigger"];
  activity: string | null;
  startedAt: number;
}

export interface BrowserFrame {
  data: string;
  url: string;
  title: string;
  width: number;
  height: number;
  at: number;
}

export interface ComputerFrame {
  /** base64 ("" when `error` is set) */
  data: string;
  mime: string;
  width: number;
  height: number;
  label: string;
  error?: string;
  at: number;
}

export interface ComputerAction {
  runId: string;
  action: string;
  /** 0–1 within the frame */
  x?: number;
  y?: number;
  at: number;
}

/** How the latest run of a conversation ended (for the character's reaction). */
export interface FinishedRun {
  runId: string;
  status: Run["status"];
  at: number;
}

interface LiveState {
  connected: boolean;
  runs: Record<string, LiveRun>;
  /** Last finished run per conversation id. */
  finished: Record<string, FinishedRun>;
  /** Browser live view frames per view (`browserView`: a profile's active tab, or one chat's tab). */
  frames: Record<string, BrowserFrame>;
  /** Computer live view frames per view ("display:1", "window:812:4711", …). */
  computerFrames: Record<string, ComputerFrame>;
  /** Latest agent action per view (drawn as a ripple). */
  computerActions: Record<string, ComputerAction>;
  setConnected: (v: boolean) => void;
  runStarted: (run: Run) => void;
  runDelta: (runId: string, conversationId: string, messageId: string, blocks: MessageBlock[]) => void;
  runActivity: (runId: string, label: string) => void;
  runFinished: (run: Run) => void;
  /** The run stands still: nothing streams, and it has not ended. */
  runPaused: (run: Run) => void;
  browserFrame: (view: string, frame: BrowserFrame) => void;
  dropBrowserFrame: (profileId: string) => void;
  computerFrame: (view: string, frame: ComputerFrame) => void;
  computerAction: (view: string, action: ComputerAction) => void;
  dropComputerView: (view: string) => void;
}

/** Realtime state fed by the WebSocket (in-flight runs, streaming blocks, browser frames). */
export const useLive = create<LiveState>((set) => ({
  connected: false,
  runs: {},
  finished: {},
  frames: {},
  computerFrames: {},
  computerActions: {},
  setConnected: (connected) => set({ connected }),
  runStarted: (run) =>
    set((s) => {
      // Sent twice (queued, then running): what a run that continues after a pause already showed stays.
      const known = s.runs[run.id];
      return {
        runs: {
          ...s.runs,
          [run.id]: {
            runId: run.id,
            agentId: run.agentId,
            conversationId: run.conversationId,
            messageId: known?.messageId ?? null,
            blocks: known?.blocks ?? [],
            status: run.status,
            trigger: run.trigger,
            activity: null,
            startedAt: known?.startedAt ?? Date.now(),
          },
        },
      };
    }),
  runDelta: (runId, conversationId, messageId, blocks) =>
    set((s) => {
      const prev = s.runs[runId];
      return {
        runs: {
          ...s.runs,
          [runId]: {
            runId,
            agentId: prev?.agentId ?? "",
            conversationId,
            messageId,
            blocks,
            status: "running",
            trigger: prev?.trigger,
            activity: prev?.activity ?? null,
            startedAt: prev?.startedAt ?? Date.now(),
          },
        },
      };
    }),
  runActivity: (runId, label) =>
    set((s) => (s.runs[runId] ? { runs: { ...s.runs, [runId]: { ...s.runs[runId], activity: label } } } : s)),
  runFinished: (run) =>
    set((s) => {
      const next = { ...s.runs };
      delete next[run.id];
      return {
        runs: next,
        finished: { ...s.finished, [run.conversationId]: { runId: run.id, status: run.status, at: Date.now() } },
      };
    }),
  runPaused: (run) =>
    set((s) => {
      if (!s.runs[run.id]) return s;
      const next = { ...s.runs };
      delete next[run.id];
      return { runs: next };
    }),
  browserFrame: (view, frame) => set((s) => ({ frames: { ...s.frames, [view]: frame } })),
  /** Forget every frame of the profile (its browser stopped). */
  dropBrowserFrame: (profileId) =>
    set((s) => {
      const stale = Object.keys(s.frames).filter((view) => view === profileId || view.startsWith(`${profileId}:`));
      if (!stale.length) return s;
      const frames = { ...s.frames };
      for (const view of stale) delete frames[view];
      return { frames };
    }),
  computerFrame: (view, frame) =>
    set((s) => {
      // Keep the last picture (and when it was live) when an error arrives, so the view doesn't flash empty.
      const prev = s.computerFrames[view];
      const next = frame.error && prev?.data ? { ...prev, error: frame.error } : frame;
      return { computerFrames: { ...s.computerFrames, [view]: next } };
    }),
  computerAction: (view, action) => set((s) => ({ computerActions: { ...s.computerActions, [view]: action } })),
  dropComputerView: (view) =>
    set((s) => {
      if (!s.computerFrames[view] && !s.computerActions[view]) return s;
      const computerFrames = { ...s.computerFrames };
      const computerActions = { ...s.computerActions };
      delete computerFrames[view];
      delete computerActions[view];
      return { computerFrames, computerActions };
    }),
}));

/** Live run currently streaming into a conversation (if any). */
export function useConversationLiveRun(conversationId: string | undefined): LiveRun | null {
  return useLive((s) => {
    if (!conversationId) return null;
    // The one that works; a run waiting behind it (or behind a paused one) only when nothing does.
    let waiting: LiveRun | null = null;
    for (const r of Object.values(s.runs)) {
      if (r.conversationId !== conversationId) continue;
      if (r.status !== "queued") return r;
      waiting ??= r;
    }
    return waiting;
  });
}

export function useConversationFinishedRun(conversationId: string | undefined): FinishedRun | null {
  return useLive((s) => (conversationId ? (s.finished[conversationId] ?? null) : null));
}

export function useAgentRunning(agentId: string | undefined): boolean {
  return useLive((s) => (agentId ? Object.values(s.runs).some((r) => r.agentId === agentId) : false));
}
