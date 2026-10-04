import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  /** Workspace scope selected in the sidebar: "all" | "global" | workspace id */
  workspace: string;
  commandOpen: boolean;
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
  /** The Agents page shows cards or the org chart. */
  agentsView: "grid" | "chart";
  setWorkspace: (id: string) => void;
  setCommandOpen: (open: boolean) => void;
  setVoiceMode: (on: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setBrowserPanel: (v: boolean) => void;
  setComputerPanel: (v: boolean) => void;
  setVmPanel: (v: boolean) => void;
  skipClaudeVersion: (version: string | null) => void;
  toggleColumn: (status: string) => void;
  setAgentsView: (v: "grid" | "chart") => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      workspace: "all",
      commandOpen: false,
      voiceMode: false,
      sidebarCollapsed: false,
      browserPanel: true,
      computerPanel: true,
      vmPanel: true,
      skippedClaudeVersion: null,
      collapsedColumns: ["cancelled"],
      agentsView: "grid",
      setWorkspace: (workspace) => set({ workspace }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
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
    }),
    {
      name: "godmode-ui",
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
      }),
    },
  ),
);
