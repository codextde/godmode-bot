import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { Conversation } from "@godmode/shared";
import type { ChatBucket } from "./desktop-parity";

export type ChatSource = "mine" | "automations" | "agents";
export type RecentSource = ChatSource | "all";
export type RecentTab = "all" | ChatBucket;

const SOURCE_KEY = "godmode.recentSource";
const TAB_KEY = "godmode.recentTab";

export const SOURCES: { value: RecentSource; label: string; hint: string }[] = [
  { value: "mine", label: "Mine", hint: "Chats you started" },
  { value: "automations", label: "Automations", hint: "Started by an automation or the API" },
  { value: "agents", label: "Agents", hint: "Started by an agent: handovers, board tasks, heartbeats" },
  { value: "all", label: "All", hint: "Every chat" },
];

export const TABS: { value: RecentTab; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every recent chat" },
  { value: "running", label: "Running", hint: "Working, queued or waiting for you" },
  { value: "scheduled", label: "Scheduled", hint: "Continue on their own later" },
  { value: "done", label: "Done", hint: "Finished chats" },
];

/** Mine: chats the human started, here or from Slack, Telegram or Teams. Automations: started by a trigger. Agents: an agent started it itself. */
export function chatSource(c: Conversation): ChatSource {
  switch (c.origin) {
    case "routine":
    case "api":
      return "automations";
    case "delegation":
    case "task":
    case "heartbeat":
    case "dream":
      return "agents";
    default:
      return "mine";
  }
}

export type SourceStat = { unread: number; needsYou: number };

export function sourceStats(chats: Conversation[]): Record<RecentSource, SourceStat> {
  const stats = Object.fromEntries(SOURCES.map((s) => [s.value, { unread: 0, needsYou: 0 }])) as Record<RecentSource, SourceStat>;
  for (const c of chats) {
    for (const key of [chatSource(c), "all"] as const) {
      if (c.unread) stats[key].unread++;
      if (c.paused?.reason === "question") stats[key].needsYou++;
    }
  }
  return stats;
}

interface ChatFilters {
  source: RecentSource;
  tab: RecentTab;
  setSource: (source: RecentSource) => void;
  setTab: (tab: RecentTab) => void;
}

const save = (key: string, value: string) => void SecureStore.setItemAsync(key, value).catch(() => undefined);

/** The Chats tab's filters, kept on this phone like the desktop keeps its sidebar's: yours first. */
export const useChatFilters = create<ChatFilters>((set) => ({
  source: "mine",
  tab: "all",
  setSource: (source) => {
    set({ source });
    save(SOURCE_KEY, source);
  },
  setTab: (tab) => {
    set({ tab });
    save(TAB_KEY, tab);
  },
}));

void Promise.all([SecureStore.getItemAsync(SOURCE_KEY).catch(() => null), SecureStore.getItemAsync(TAB_KEY).catch(() => null)]).then(([source, tab]) => {
  const patch: Partial<ChatFilters> = {};
  if (SOURCES.some((s) => s.value === source)) patch.source = source as RecentSource;
  if (TABS.some((t) => t.value === tab)) patch.tab = tab as RecentTab;
  useChatFilters.setState(patch);
});
