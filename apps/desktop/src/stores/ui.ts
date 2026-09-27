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
  setWorkspace: (id: string) => void;
  setCommandOpen: (open: boolean) => void;
  setVoiceMode: (on: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setBrowserPanel: (v: boolean) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      workspace: "all",
      commandOpen: false,
      voiceMode: false,
      sidebarCollapsed: false,
      browserPanel: true,
      setWorkspace: (workspace) => set({ workspace }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setVoiceMode: (voiceMode) => set({ voiceMode }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setBrowserPanel: (browserPanel) => set({ browserPanel }),
    }),
    {
      name: "godmode-ui",
      partialize: (s) => ({ workspace: s.workspace, sidebarCollapsed: s.sidebarCollapsed, voiceMode: s.voiceMode, browserPanel: s.browserPanel }),
    },
  ),
);
