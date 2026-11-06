import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

/** Cards: each group of steps in a bordered card. Compact: one muted line per group; tap it for the steps. */
export type ToolCallView = "cards" | "compact";
/** Light saves energy: characters stand still, live dots and cursors don't loop, and titles appear at once. */
export type Animations = "full" | "light";

const KEY = "godmode.chatPrefs";

interface ChatPrefsState {
  toolCalls: ToolCallView;
  animations: Animations;
  setToolCalls: (toolCalls: ToolCallView) => void;
  setAnimations: (animations: Animations) => void;
}

/** How chats look on this phone (Settings → General); the computer keeps its own. */
export const useChatPrefs = create<ChatPrefsState>((set, get) => {
  const save = () => void SecureStore.setItemAsync(KEY, JSON.stringify({ toolCalls: get().toolCalls, animations: get().animations })).catch(() => undefined);
  return {
    toolCalls: "cards",
    animations: "full",
    setToolCalls: (toolCalls) => {
      set({ toolCalls });
      save();
    },
    setAnimations: (animations) => {
      set({ animations });
      save();
    },
  };
});

void SecureStore.getItemAsync(KEY)
  .catch(() => null)
  .then((saved) => {
    if (!saved) return;
    try {
      const prefs = JSON.parse(saved) as Partial<Record<"toolCalls" | "animations", unknown>>;
      useChatPrefs.setState({
        ...(prefs.toolCalls === "compact" || prefs.toolCalls === "cards" ? { toolCalls: prefs.toolCalls } : {}),
        ...(prefs.animations === "light" || prefs.animations === "full" ? { animations: prefs.animations } : {}),
      });
    } catch {
      // A broken entry keeps the defaults.
    }
  });

export const useLightAnimations = () => useChatPrefs((s) => s.animations === "light");
