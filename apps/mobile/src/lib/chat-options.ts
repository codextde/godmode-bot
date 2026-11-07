import { create } from "zustand";
import type { Agent, BrowserProfile, ComputerTarget, Project, StartChatInput } from "@godmode/shared";

export interface NewChatOptions {
  /** Nothing is kept: no list, transcript or memory, and it's wiped once the human leaves it. */
  private: boolean;
  /** null = the agent's browser profile. */
  browserProfileId: string | null;
  /** Standing instructions for this chat only ("" = none). */
  instructions: string;
  /** Works in this folder on the computer instead of the agent's (null = the agent's). */
  workingDirectory: string | null;
  /** Works in this VM instead of the agent's (null = the agent's). */
  vmId: string | null;
  /** SSH servers and Android phones it may use on top of the agent's. */
  sshServerIds: string[];
  androidDeviceIds: string[];
  /** The window, screen or tab shared with it. */
  computerTarget: ComputerTarget | null;
  /** Another computer of the group it works on (undefined = where new chats go by default). */
  runnerId?: string | null;
}

const NONE: NewChatOptions = { private: false, browserProfileId: null, instructions: "", workingDirectory: null, vmId: null, sshServerIds: [], androidDeviceIds: [], computerTarget: null };

/** What the next new chat (the compose sheet) starts with beyond agent, project and model. */
export const useNewChatOptions = create<{ options: NewChatOptions; set: (patch: Partial<NewChatOptions>) => void; reset: () => void }>((set) => ({
  options: NONE,
  set: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
  reset: () => set({ options: NONE }),
}));

/** The new chat's options as the body of POST /api/chat: only what was picked. */
export function chatOptionsBody(options: NewChatOptions): Pick<StartChatInput, "private" | "browserProfileId" | "instructions" | "workingDirectory" | "vmId" | "sshServerIds" | "androidDeviceIds" | "computerTarget" | "runnerId"> {
  // A private chat stays on this computer; one on another computer starts without this computer's folder, VM and phones.
  const elsewhere = !options.private && options.runnerId !== undefined;
  return {
    ...(options.private ? { private: true as const } : {}),
    ...(options.browserProfileId ? { browserProfileId: options.browserProfileId } : {}),
    ...(options.instructions.trim() ? { instructions: options.instructions.trim() } : {}),
    ...(elsewhere ? { runnerId: options.runnerId } : {}),
    ...(!elsewhere && options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    ...(!elsewhere && options.vmId ? { vmId: options.vmId } : {}),
    ...(options.sshServerIds.length ? { sshServerIds: options.sshServerIds } : {}),
    ...(!elsewhere && options.androidDeviceIds.length ? { androidDeviceIds: options.androidDeviceIds } : {}),
    ...(!elsewhere && options.computerTarget ? { computerTarget: options.computerTarget } : {}),
  };
}

/**
 * The profile a chat browses with when it has none of its own, like the computer picks it: the agent's pinned one, the
 * project's, then the default of the agent's (or the chat's) workspace, then the global default.
 */
export function fallbackProfile(
  agent: Agent | undefined,
  profiles: BrowserProfile[],
  workspaceId: string | null,
  project: Pick<Project, "browserProfileId" | "workspaceId"> | null,
): BrowserProfile | null {
  const pinned = agent?.browser.profileId ? profiles.find((p) => p.id === agent.browser.profileId) : undefined;
  if (pinned) return pinned;
  const forProject = project?.browserProfileId ? profiles.find((p) => p.id === project.browserProfileId) : undefined;
  if (forProject && (!forProject.workspaceId || forProject.workspaceId === project!.workspaceId)) return forProject;
  const home = agent?.workspaceId ?? project?.workspaceId ?? workspaceId;
  return (home ? profiles.find((p) => p.workspaceId === home && p.isDefault) : undefined) ?? profiles.find((p) => !p.workspaceId && p.isDefault) ?? null;
}
