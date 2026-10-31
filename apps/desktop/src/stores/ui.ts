import { create } from "zustand";
import { persist } from "zustand/middleware";
import { storageKey } from "@/lib/core";

export type AgentsView = "grid" | "list" | "chart";

export type RecentTab = "all" | "running" | "scheduled" | "done";

/** Who started the chats the sidebar lists: the human, an automation or an agent on its own. */
export type RecentSource = "mine" | "automations" | "agents" | "all";

export type WorkspacesView = "grid" | "list";
export type InboxView = "list" | "board";

export type WorkspacesSort = "name" | "active" | "attention";

interface UiState {
  /** Workspace scope selected in the sidebar: "all" | "global" | workspace id */
  workspace: string;
  /** Project of that workspace picked in the sidebar; null = the whole workspace. */
  project: string | null;
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
  /** Show the phone's screen next to chats that control an Android phone. */
  phonePanel: boolean;
  /** Claude Code version whose update prompt was dismissed; a newer release shows it again. */
  skippedClaudeVersion: string | null;
  /** Task board columns folded to a narrow strip. */
  collapsedColumns: string[];
  /** The Agents page shows cards, rows or the org chart. */
  agentsView: AgentsView;
  /** The Inbox shows what waits as a list or the to-dos as a board. */
  inboxView: InboxView;
  /** Workspace groups folded on the Agents page ("global" or a workspace id). */
  collapsedAgentGroups: string[];
  /** Which chats the sidebar's Recent list shows. */
  recentTab: RecentTab;
  recentSource: RecentSource;
  /** Workspace ids picked lately, newest first (the switcher lists them on top). */
  recentWorkspaces: string[];
  /** The Workspaces page shows cards or rows, in this order. */
  workspacesView: WorkspacesView;
  workspacesSort: WorkspacesSort;
  /** Sidebar sections shown as full lists (the rest are a row of icons). */
  expandedNav: string[];
  /** The "Try something like" suggestions on Home were closed. */
  hideSuggestions: boolean;
  /** Sidebar sections open by default that the human folded. */
  collapsedNav: string[];
  /** Page explainers the human closed. */
  hiddenHints: string[];
  /** The human came back after a while: from when to when they were away (Home sums up what happened). Not kept. */
  away: { since: string; until: string } | null;
  /** Pick a scope; a project only goes with its workspace (omitted = the whole workspace). */
  setWorkspace: (id: string, project?: string | null) => void;
  setCommandOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setVoiceMode: (on: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setBrowserPanel: (v: boolean) => void;
  setComputerPanel: (v: boolean) => void;
  setVmPanel: (v: boolean) => void;
  setPhonePanel: (v: boolean) => void;
  skipClaudeVersion: (version: string | null) => void;
  toggleColumn: (status: string) => void;
  setAgentsView: (v: AgentsView) => void;
  setInboxView: (v: InboxView) => void;
  toggleAgentGroup: (key: string) => void;
  setRecentTab: (tab: RecentTab) => void;
  setRecentSource: (source: RecentSource) => void;
  toggleNavSection: (key: string) => void;
  toggleNavCollapsed: (key: string) => void;
  hideHint: (key: string) => void;
  setWorkspacesView: (v: WorkspacesView) => void;
  setWorkspacesSort: (v: WorkspacesSort) => void;
  setAway: (away: { since: string; until: string } | null) => void;
  setHideSuggestions: (v: boolean) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      workspace: "all",
      project: null,
      commandOpen: false,
      shortcutsOpen: false,
      voiceMode: false,
      sidebarCollapsed: false,
      browserPanel: true,
      computerPanel: true,
      vmPanel: true,
      phonePanel: true,
      skippedClaudeVersion: null,
      collapsedColumns: ["cancelled"],
      agentsView: "grid",
      inboxView: "list",
      collapsedAgentGroups: [],
      recentTab: "all",
      recentSource: "mine",
      recentWorkspaces: [],
      expandedNav: [],
      collapsedNav: [],
      hiddenHints: [],
      workspacesView: "grid",
      workspacesSort: "name",
      away: null,
      hideSuggestions: false,
      setWorkspace: (workspace, project = null) =>
        set((s) => ({
          workspace,
          project: workspace === "all" || workspace === "global" ? null : project,
          recentWorkspaces: workspace === "all" || workspace === "global" ? s.recentWorkspaces : [workspace, ...s.recentWorkspaces.filter((id) => id !== workspace)].slice(0, 6),
        })),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setVoiceMode: (voiceMode) => set({ voiceMode }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setBrowserPanel: (browserPanel) => set({ browserPanel }),
      setComputerPanel: (computerPanel) => set({ computerPanel }),
      setVmPanel: (vmPanel) => set({ vmPanel }),
      setPhonePanel: (phonePanel) => set({ phonePanel }),
      skipClaudeVersion: (skippedClaudeVersion) => set({ skippedClaudeVersion }),
      toggleColumn: (status) =>
        set((s) => ({
          collapsedColumns: s.collapsedColumns.includes(status) ? s.collapsedColumns.filter((c) => c !== status) : [...s.collapsedColumns, status],
        })),
      setAgentsView: (agentsView) => set({ agentsView }),
      setInboxView: (inboxView) => set({ inboxView }),
      toggleAgentGroup: (key) =>
        set((s) => ({
          collapsedAgentGroups: s.collapsedAgentGroups.includes(key) ? s.collapsedAgentGroups.filter((k) => k !== key) : [...s.collapsedAgentGroups, key],
        })),
      setRecentTab: (recentTab) => set({ recentTab }),
      setRecentSource: (recentSource) => set({ recentSource }),
      setWorkspacesView: (workspacesView) => set({ workspacesView }),
      setWorkspacesSort: (workspacesSort) => set({ workspacesSort }),
      toggleNavSection: (key) =>
        set((s) => ({ expandedNav: s.expandedNav.includes(key) ? s.expandedNav.filter((k) => k !== key) : [...s.expandedNav, key] })),
      toggleNavCollapsed: (key) =>
        set((s) => ({ collapsedNav: s.collapsedNav.includes(key) ? s.collapsedNav.filter((k) => k !== key) : [...s.collapsedNav, key] })),
      hideHint: (key) => set((s) => ({ hiddenHints: s.hiddenHints.includes(key) ? s.hiddenHints : [...s.hiddenHints, key] })),
      setAway: (away) => set({ away }),
      setHideSuggestions: (hideSuggestions) => set({ hideSuggestions }),
    }),
    {
      // Per computer in cloud mode: the selected workspace id belongs to one computer.
      name: storageKey("godmode-ui"),
      partialize: (s) => ({
        workspace: s.workspace,
        project: s.project,
        sidebarCollapsed: s.sidebarCollapsed,
        voiceMode: s.voiceMode,
        browserPanel: s.browserPanel,
        computerPanel: s.computerPanel,
        vmPanel: s.vmPanel,
        phonePanel: s.phonePanel,
        skippedClaudeVersion: s.skippedClaudeVersion,
        collapsedColumns: s.collapsedColumns,
        agentsView: s.agentsView,
        inboxView: s.inboxView,
        collapsedAgentGroups: s.collapsedAgentGroups,
        recentTab: s.recentTab,
        recentSource: s.recentSource,
        recentWorkspaces: s.recentWorkspaces,
        expandedNav: s.expandedNav,
        collapsedNav: s.collapsedNav,
        hiddenHints: s.hiddenHints,
        workspacesView: s.workspacesView,
        workspacesSort: s.workspacesSort,
        hideSuggestions: s.hideSuggestions,
      }),
    },
  ),
);
