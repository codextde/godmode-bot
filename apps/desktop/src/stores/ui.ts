import { create } from "zustand";
import { persist } from "zustand/middleware";
import { storageKey } from "@/lib/core";

export type AgentsView = "grid" | "list" | "chart";

export type RecentTab = "all" | "running" | "scheduled" | "done";

/** Who started the chats the sidebar lists: the human, an automation or an agent on its own. */
export type RecentSource = "mine" | "automations" | "agents" | "all";

export type WorkspacesView = "grid" | "list";
export type InboxView = "list" | "board";

/** How a chat shows the agent's tool calls: cards with the steps open while it works, or one muted line each. */
export type ToolCallView = "cards" | "compact";
export type FollowUpMode = "queue" | "steer";

/** What Enter does in a chat: send (Shift+Enter is a new line), or a new line (Cmd/Ctrl+Enter sends). */
export type EnterKey = "send" | "newLine";

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
  collapsedInboxSections: string[];
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
  sidebarWidth: number | null;
  artifactPanelWidth: number | null;
  reduceAnimations: boolean;
  toolCallView: ToolCallView;
  followUpMode: FollowUpMode;
  enterKey: EnterKey;
  largePasteAsFile: boolean;
  mcpApps: boolean;
  /** Show the frame rate meter on top of the window. */
  fpsMeter: boolean;
  /** Sidebar sections open by default that the human folded. */
  collapsedNav: string[];
  /** Pages the human took out of the sidebar's Work section. */
  hiddenNav: string[];
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
  toggleInboxSection: (id: string) => void;
  toggleAgentGroup: (key: string) => void;
  setRecentTab: (tab: RecentTab) => void;
  setRecentSource: (source: RecentSource) => void;
  toggleNavSection: (key: string) => void;
  toggleNavCollapsed: (key: string) => void;
  toggleNavHidden: (to: string) => void;
  hideHint: (key: string) => void;
  setWorkspacesView: (v: WorkspacesView) => void;
  setWorkspacesSort: (v: WorkspacesSort) => void;
  setAway: (away: { since: string; until: string } | null) => void;
  setHideSuggestions: (v: boolean) => void;
  setSidebarWidth: (width: number | null) => void;
  setArtifactPanelWidth: (width: number | null) => void;
  setReduceAnimations: (v: boolean) => void;
  setToolCallView: (v: ToolCallView) => void;
  setFollowUpMode: (v: FollowUpMode) => void;
  setEnterKey: (v: EnterKey) => void;
  setLargePasteAsFile: (v: boolean) => void;
  setMcpApps: (v: boolean) => void;
  setFpsMeter: (v: boolean) => void;
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
      collapsedInboxSections: [],
      collapsedAgentGroups: [],
      recentTab: "all",
      recentSource: "mine",
      recentWorkspaces: [],
      expandedNav: [],
      collapsedNav: [],
      hiddenNav: [],
      hiddenHints: [],
      workspacesView: "grid",
      workspacesSort: "name",
      away: null,
      hideSuggestions: false,
      sidebarWidth: null,
      artifactPanelWidth: null,
      reduceAnimations: false,
      toolCallView: "cards",
      followUpMode: "queue",
      enterKey: "send",
      largePasteAsFile: true,
      mcpApps: false,
      fpsMeter: false,
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
      toggleInboxSection: (id) =>
        set((s) => ({ collapsedInboxSections: s.collapsedInboxSections.includes(id) ? s.collapsedInboxSections.filter((x) => x !== id) : [...s.collapsedInboxSections, id] })),
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
      toggleNavHidden: (to) => set((s) => ({ hiddenNav: s.hiddenNav.includes(to) ? s.hiddenNav.filter((k) => k !== to) : [...s.hiddenNav, to] })),
      hideHint: (key) => set((s) => ({ hiddenHints: s.hiddenHints.includes(key) ? s.hiddenHints : [...s.hiddenHints, key] })),
      setAway: (away) => set({ away }),
      setHideSuggestions: (hideSuggestions) => set({ hideSuggestions }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setArtifactPanelWidth: (artifactPanelWidth) => set({ artifactPanelWidth }),
      setReduceAnimations: (reduceAnimations) => set({ reduceAnimations }),
      setToolCallView: (toolCallView) => set({ toolCallView }),
      setFollowUpMode: (followUpMode) => set({ followUpMode }),
      setEnterKey: (enterKey) => set({ enterKey }),
      setLargePasteAsFile: (largePasteAsFile) => set({ largePasteAsFile }),
      setMcpApps: (mcpApps) => set({ mcpApps }),
      setFpsMeter: (fpsMeter) => set({ fpsMeter }),
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
        collapsedInboxSections: s.collapsedInboxSections,
        collapsedAgentGroups: s.collapsedAgentGroups,
        recentTab: s.recentTab,
        recentSource: s.recentSource,
        recentWorkspaces: s.recentWorkspaces,
        expandedNav: s.expandedNav,
        collapsedNav: s.collapsedNav,
        hiddenNav: s.hiddenNav,
        hiddenHints: s.hiddenHints,
        workspacesView: s.workspacesView,
        workspacesSort: s.workspacesSort,
        hideSuggestions: s.hideSuggestions,
        sidebarWidth: s.sidebarWidth,
        artifactPanelWidth: s.artifactPanelWidth,
        reduceAnimations: s.reduceAnimations,
        toolCallView: s.toolCallView,
        followUpMode: s.followUpMode,
        enterKey: s.enterKey,
        largePasteAsFile: s.largePasteAsFile,
        mcpApps: s.mcpApps,
        fpsMeter: s.fpsMeter,
      }),
    },
  ),
);

/** What a key press in a chat text field does: send, send the other way (queue/steer) or nothing. */
export function sendKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; nativeEvent: { isComposing: boolean } }): "send" | "opposite" | null {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (useUi.getState().enterKey === "newLine") return mod ? (e.shiftKey ? "opposite" : "send") : null;
  return e.shiftKey ? null : mod ? "opposite" : "send";
}
