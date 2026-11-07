import type { ComposioConnectInput, ComposioConnectResult, ComposioConnection, ComposioStatus, ComposioToolkit } from "@godmode/shared";
import { request } from "./api";
import { ik } from "./integrations";
import { queryClient } from "./query";

/** Composio as the desktop's Integrations → Composio tab runs it (full-access phones): the key, connecting and disconnecting apps. */
export const composioAdmin = {
  /** The core checks the stored key again with Composio. */
  recheck: () => request<ComposioStatus>("GET", "/api/composio/status?refresh=1"),
  /** Saved encrypted in the vault and checked with Composio; null removes it. */
  setKey: (apiKey: string | null) => request<ComposioStatus>("PUT", "/api/composio/key", { apiKey }, 30_000),
  toolkits: (q: { search?: string; cursor?: string }) => {
    const params = new URLSearchParams();
    if (q.search) params.set("search", q.search);
    if (q.cursor) params.set("cursor", q.cursor);
    const query = params.toString();
    return request<{ items: ComposioToolkit[]; nextCursor: string | null }>("GET", `/api/composio/toolkits${query ? `?${query}` : ""}`, undefined, 30_000);
  },
  connect: (input: ComposioConnectInput) => request<ComposioConnectResult>("POST", "/api/composio/connect", input, 30_000),
  refresh: (id: string) => request<ComposioConnection>("POST", `/api/composio/connections/${encodeURIComponent(id)}/refresh`, {}),
  disconnect: (id: string) => request<{ ok: true }>("DELETE", `/api/composio/connections/${encodeURIComponent(id)}`),
};

export const toolkitsKey = (search: string) => [...ik.composioStatus.slice(0, 2), "toolkits", search];

/** Composio's logo for an app. */
export const toolkitLogoUrl = (slug: string) => `https://logos.composio.dev/api/${encodeURIComponent(slug)}`;

export type ConnectionTone = "ok" | "pending" | "error" | "neutral";

export function connectionTone(status: string): ConnectionTone {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "ok";
  if (s === "INITIATED" || s === "INITIALIZING" || s === "PENDING") return "pending";
  if (s === "FAILED" || s === "EXPIRED" || s === "REVOKED") return "error";
  return "neutral";
}

/** Everything that shows Composio asks again: the key, the accounts, the MCP servers they bring. */
export function refreshComposio() {
  void queryClient.invalidateQueries({ queryKey: ik.composioStatus.slice(0, 2) });
  void queryClient.invalidateQueries({ queryKey: ik.mcpServers });
}
