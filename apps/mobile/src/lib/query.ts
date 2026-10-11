import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

export const qk = {
  bootstrap: ["bootstrap"],
  me: ["me"],
  workspaces: ["workspaces"],
  settings: ["settings"],
  agents: ["agents"],
  agent: (id: string) => ["agents", id],
  agentCommands: (id: string) => ["agent-commands", id],
  models: ["models"],
  conversations: ["conversations"],
  conversationList: (search: string, workspaceId: string | null = null) => ["conversations", "list", search, workspaceId ?? "all"],
  conversation: (id: string) => ["conversations", "detail", id],
  archivedChats: (workspaceId: string | null) => ["conversations", "archived", workspaceId ?? "all"],
  tasks: ["tasks"],
  /** Boards carry the tickets without their long texts; `archived`: the ones taken off the board. */
  taskList: (workspaceId: string | null, archived = false) => ["tasks", "list", workspaceId ?? "all", archived ? "archived" : "board"],
  task: (id: string) => ["tasks", "detail", id],
  taskEvents: (id: string) => ["tasks", "events", id],
  runs: ["runs"],
  recentRuns: ["runs", "recent"],
  agentRuns: (agentId: string) => ["runs", "agent", agentId],
  routines: ["routines"],
  allRoutines: ["routines", "all"],
  agentRoutines: (agentId: string) => ["routines", agentId],
  browserProfiles: ["browser-profiles"],
  vms: ["vms"],
  vmScreen: (id: string) => ["vm-screen", id],
  androidDevices: ["android-devices"],
  androidScreen: (id: string) => ["android-screen", id],
  notifications: ["notifications"],
  missingLogins: ["missing-logins"],
  questions: ["questions"],
  humanTasks: ["human-tasks"],
  humanTaskList: (status: "active" | "all") => ["human-tasks", "list", status],
  chatHumanTasks: (conversationId: string) => ["human-tasks", "chat", conversationId],
} as const;
