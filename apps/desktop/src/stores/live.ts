import { create } from "zustand";
import type { MessageBlock, Run } from "@godmode/shared";

export interface LiveRun {
  runId: string;
  agentId: string;
  conversationId: string;
  messageId: string | null;
  blocks: MessageBlock[];
  status: Run["status"];
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

interface LiveState {
  connected: boolean;
  runs: Record<string, LiveRun>;
  frames: Record<string, BrowserFrame>;
  setConnected: (v: boolean) => void;
  runStarted: (run: Run) => void;
  runDelta: (runId: string, conversationId: string, messageId: string, blocks: MessageBlock[]) => void;
  runActivity: (runId: string, label: string) => void;
  runFinished: (run: Run) => void;
  browserFrame: (profileId: string, frame: BrowserFrame) => void;
  dropBrowserFrame: (profileId: string) => void;
}

/** Realtime state fed by the WebSocket (in-flight runs, streaming blocks, browser frames). */
export const useLive = create<LiveState>((set) => ({
  connected: false,
  runs: {},
  frames: {},
  setConnected: (connected) => set({ connected }),
  runStarted: (run) =>
    set((s) => ({
      runs: {
        ...s.runs,
        [run.id]: {
          runId: run.id,
          agentId: run.agentId,
          conversationId: run.conversationId,
          messageId: null,
          blocks: [],
          status: run.status,
          activity: null,
          startedAt: Date.now(),
        },
      },
    })),
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
      return { runs: next };
    }),
  browserFrame: (profileId, frame) => set((s) => ({ frames: { ...s.frames, [profileId]: frame } })),
  dropBrowserFrame: (profileId) =>
    set((s) => {
      if (!s.frames[profileId]) return s;
      const frames = { ...s.frames };
      delete frames[profileId];
      return { frames };
    }),
}));

/** Live run currently streaming into a conversation (if any). */
export function useConversationLiveRun(conversationId: string | undefined): LiveRun | null {
  return useLive((s) => {
    if (!conversationId) return null;
    for (const r of Object.values(s.runs)) if (r.conversationId === conversationId) return r;
    return null;
  });
}

export function useAgentRunning(agentId: string | undefined): boolean {
  return useLive((s) => (agentId ? Object.values(s.runs).some((r) => r.agentId === agentId) : false));
}
