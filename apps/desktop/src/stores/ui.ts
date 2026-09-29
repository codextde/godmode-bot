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
  /** Claude Code version whose update prompt was dismissed; a newer release shows it again. */
  skippedClaudeVersion: string | null;
  setWorkspace: (id: string) => void;
  setCommandOpen: (open: boolean) => void;
  setVoiceMode: (on: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setBrowserPanel: (v: boolean) => void;
  setComputerPanel: (v: boolean) => void;
  skipClaudeVersion: (version: string | null) => void;
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
      skippedClaudeVersion: null,
      setWorkspace: (workspace) => set({ workspace }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setVoiceMode: (voiceMode) => set({ voiceMode }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setBrowserPanel: (browserPanel) => set({ browserPanel }),
      setComputerPanel: (computerPanel) => set({ computerPanel }),
      skipClaudeVersion: (skippedClaudeVersion) => set({ skippedClaudeVersion }),
    }),
    {
      name: "godmode-ui",
      partialize: (s) => ({
        workspace: s.workspace,
        sidebarCollapsed: s.sidebarCollapsed,
        voiceMode: s.voiceMode,
        browserPanel: s.browserPanel,
        computerPanel: s.computerPanel,
        skippedClaudeVersion: s.skippedClaudeVersion,
      }),
    },
  ),
);
