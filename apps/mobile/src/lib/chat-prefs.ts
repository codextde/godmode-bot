import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

/** Cards: each group of steps in a bordered card. Compact: one muted line per group; tap it for the steps. */
export type ToolCallView = "cards" | "compact";
/** Light saves energy: characters stand still, live dots and cursors don't loop, and titles appear at once. */
export type Animations = "full" | "light";
/** A message sent while the agent works: queued for its next step, or steering (it stops and starts on the message). */
export type FollowUp = "queue" | "steer";

const KEY = "godmode.chatPrefs";

interface ChatPrefsState {
  toolCalls: ToolCallView;
  animations: Animations;
  followUp: FollowUp;
  /** Tools of MCP servers that bring their own view show it in the chat (off by default, like the desktop). */
  mcpApps: boolean;
  /** Replies can be read out: a Read button under them, and spoken after a dictated message (off by default). */
  readReplies: boolean;
  setToolCalls: (toolCalls: ToolCallView) => void;
  setAnimations: (animations: Animations) => void;
  setFollowUp: (followUp: FollowUp) => void;
  setMcpApps: (mcpApps: boolean) => void;
  setReadReplies: (readReplies: boolean) => void;
}

/** How chats look on this phone (Settings → General); the computer keeps its own. */
export const useChatPrefs = create<ChatPrefsState>((set, get) => {
  const save = () => void SecureStore.setItemAsync(KEY, JSON.stringify({ toolCalls: get().toolCalls, animations: get().animations, followUp: get().followUp, mcpApps: get().mcpApps, readReplies: get().readReplies })).catch(() => undefined);
  return {
    toolCalls: "cards",
    animations: "full",
    followUp: "queue",
    mcpApps: false,
    readReplies: false,
    setToolCalls: (toolCalls) => {
      set({ toolCalls });
      save();
    },
    setAnimations: (animations) => {
      set({ animations });
      save();
    },
    setFollowUp: (followUp) => {
      set({ followUp });
      save();
    },
    setMcpApps: (mcpApps) => {
      set({ mcpApps });
      save();
    },
    setReadReplies: (readReplies) => {
      set({ readReplies });
      save();
    },
  };
});

void SecureStore.getItemAsync(KEY)
  .catch(() => null)
  .then((saved) => {
    if (!saved) return;
    try {
      const prefs = JSON.parse(saved) as Partial<Record<"toolCalls" | "animations" | "followUp" | "mcpApps" | "readReplies", unknown>>;
      useChatPrefs.setState({
        ...(prefs.toolCalls === "compact" || prefs.toolCalls === "cards" ? { toolCalls: prefs.toolCalls } : {}),
        ...(prefs.animations === "light" || prefs.animations === "full" ? { animations: prefs.animations } : {}),
        ...(prefs.followUp === "queue" || prefs.followUp === "steer" ? { followUp: prefs.followUp } : {}),
        ...(typeof prefs.mcpApps === "boolean" ? { mcpApps: prefs.mcpApps } : {}),
        ...(typeof prefs.readReplies === "boolean" ? { readReplies: prefs.readReplies } : {}),
      });
    } catch {
      // A broken entry keeps the defaults.
    }
  });

export const useLightAnimations = () => useChatPrefs((s) => s.animations === "light");
