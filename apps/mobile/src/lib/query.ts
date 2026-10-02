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
  agents: ["agents"],
  agent: (id: string) => ["agents", id],
  agentCommands: (id: string) => ["agent-commands", id],
  models: ["models"],
  conversations: ["conversations"],
  conversationList: (search: string, workspaceId: string | null = null) => ["conversations", "list", search, workspaceId ?? "all"],
  conversation: (id: string) => ["conversations", "detail", id],
  tasks: ["tasks"],
  taskList: (workspaceId: string | null) => ["tasks", "list", workspaceId ?? "all"],
  task: (id: string) => ["tasks", "detail", id],
  runs: ["runs"],
  agentRuns: (agentId: string) => ["runs", "agent", agentId],
  routines: ["routines"],
  agentRoutines: (agentId: string) => ["routines", agentId],
  browserProfiles: ["browser-profiles"],
  vms: ["vms"],
  vmScreen: (id: string) => ["vm-screen", id],
  notifications: ["notifications"],
  missingLogins: ["missing-logins"],
} as const;
