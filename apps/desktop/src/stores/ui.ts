import { create } from "zustand";
import { persist } from "zustand/middleware";
import { storageKey } from "@/lib/core";

export type AgentsView = "grid" | "list" | "chart";

export type RecentTab = "all" | "running" | "scheduled" | "done";

interface UiState {
  /** Workspace scope selected in the sidebar: "all" | "global" | workspace id */
  workspace: string;
  commandOpen: boolean;
  /** The keyboard shortcuts list is open. */
  shortcutsOpen: boolean;
  voiceMode: boolean;
  sidebarCollapsed: boolean;
  /** Show the live browser preview next to chats while the agent's browser is open. */
  browserPanel: boolean;
  /** Show the shared window/screen next to chats that share one. */
  computerPanel: boolean;
  /** Show the VM's screen next to chats that work in a VM. */
  vmPanel: boolean;
  /** Claude Code version whose update prompt was dismissed; a newer release shows it again. */
  skippedClaudeVersion: string | null;
  /** Task board columns folded to a narrow strip. */
  collapsedColumns: string[];
  /** The Agents page shows cards, rows or the org chart. */
  agentsView: AgentsView;
  /** Workspace groups folded on the Agents page ("global" or a workspace id). */
  collapsedAgentGroups: string[];
  /** Which chats the sidebar's Recent list shows. */
  recentTab: RecentTab;
  /** The human came back after a while: from when to when they were away (Home sums up what happened). Not kept. */
  away: { since: string; until: string } | null;
  setWorkspace: (id: string) => void;
  setCommandOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setVoiceMode: (on: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setBrowserPanel: (v: boolean) => void;
  setComputerPanel: (v: boolean) => void;
  setVmPanel: (v: boolean) => void;
  skipClaudeVersion: (version: string | null) => void;
  toggleColumn: (status: string) => void;
  setAgentsView: (v: AgentsView) => void;
  toggleAgentGroup: (key: string) => void;
  setRecentTab: (tab: RecentTab) => void;
  setAway: (away: { since: string; until: string } | null) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      workspace: "all",
      commandOpen: false,
      shortcutsOpen: false,
      voiceMode: false,
      sidebarCollapsed: false,
      browserPanel: true,
      computerPanel: true,
      vmPanel: true,
      skippedClaudeVersion: null,
      collapsedColumns: ["cancelled"],
      agentsView: "grid",
      collapsedAgentGroups: [],
      recentTab: "all",
      away: null,
      setWorkspace: (workspace) => set({ workspace }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setVoiceMode: (voiceMode) => set({ voiceMode }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setBrowserPanel: (browserPanel) => set({ browserPanel }),
      setComputerPanel: (computerPanel) => set({ computerPanel }),
      setVmPanel: (vmPanel) => set({ vmPanel }),
      skipClaudeVersion: (skippedClaudeVersion) => set({ skippedClaudeVersion }),
      toggleColumn: (status) =>
        set((s) => ({
          collapsedColumns: s.collapsedColumns.includes(status) ? s.collapsedColumns.filter((c) => c !== status) : [...s.collapsedColumns, status],
        })),
      setAgentsView: (agentsView) => set({ agentsView }),
      toggleAgentGroup: (key) =>
        set((s) => ({
          collapsedAgentGroups: s.collapsedAgentGroups.includes(key) ? s.collapsedAgentGroups.filter((k) => k !== key) : [...s.collapsedAgentGroups, key],
        })),
      setRecentTab: (recentTab) => set({ recentTab }),
      setAway: (away) => set({ away }),
    }),
    {
      // Per computer in cloud mode: the selected workspace id belongs to one computer.
      name: storageKey("godmode-ui"),
      partialize: (s) => ({
        workspace: s.workspace,
        sidebarCollapsed: s.sidebarCollapsed,
        voiceMode: s.voiceMode,
        browserPanel: s.browserPanel,
        computerPanel: s.computerPanel,
        vmPanel: s.vmPanel,
        skippedClaudeVersion: s.skippedClaudeVersion,
        collapsedColumns: s.collapsedColumns,
        agentsView: s.agentsView,
        collapsedAgentGroups: s.collapsedAgentGroups,
        recentTab: s.recentTab,
      }),
    },
  ),
);
