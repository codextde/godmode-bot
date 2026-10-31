import { createContext } from "react";
import { create } from "zustand";
import type { ChatFile } from "@godmode/shared";

export type ChatSide = { kind: "pull"; url: string } | { kind: "file"; file: ChatFile; line: number | null; local: boolean };

interface SidePanelState {
  open: Record<string, ChatSide | null>;
  show: (conversationId: string, side: ChatSide) => void;
  hide: (conversationId: string) => void;
}

export const useChatSidePanel = create<SidePanelState>()((set) => ({
  open: {},
  show: (conversationId, side) => set((s) => ({ open: { ...s.open, [conversationId]: side } })),
  hide: (conversationId) => set((s) => ({ open: { ...s.open, [conversationId]: null } })),
}));

export const SidePanelScope = createContext<{ conversationId: string; current: ChatSide | null } | null>(null);
export const SidePanelScopeProvider = SidePanelScope.Provider;

export function sideKey(side: ChatSide | null): string | null {
  if (!side) return null;
  return side.kind === "pull" ? `pull:${side.url}` : `file:${side.file.path}`;
}

export function lineOf(ref: string): number | null {
  const match = /:(\d{1,7})(?::\d+)?$/.exec(ref);
  return match ? Number(match[1]) : null;
}
