/**
 * Which SSH servers an agent or chat uses (`ssh_server_ids` columns, JSON arrays). Kept free of service imports so the
 * agent and conversation services and the runner can use it without depending on the SSH service.
 */
import type { SshAssignment } from "@godmode/shared";
import { all, get, run } from "../db";
import { parseJson } from "../util";

/** Every SSH server id that exists, of the given ones. */
function existing(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  return new Set(all<{ id: string }>(`SELECT id FROM ssh_servers WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids).map((r) => r.id));
}

export function parseServerIds(value: string | null | undefined): string[] {
  const list = parseJson<unknown>(value, []);
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
}

/**
 * Normalize a list from an API input: undefined = unchanged, else the ids of servers that exist (a server deleted while
 * a screen still showed it is dropped).
 */
export function normalizeSshServerIds(value: string[] | null | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = [...new Set((value ?? []).map((v) => v.trim()).filter(Boolean))];
  const found = existing(ids);
  return ids.filter((id) => found.has(id));
}

/** The servers a run may use: its chat's and its agent's, in that order (deleted ones are skipped). */
export function runSshServerIds(conversationId: string | null, agentId: string): string[] {
  const conv = conversationId ? get<{ ssh_server_ids: string | null }>("SELECT ssh_server_ids FROM conversations WHERE id = ?", conversationId) : null;
  const agent = get<{ ssh_server_ids: string | null }>("SELECT ssh_server_ids FROM agents WHERE id = ?", agentId);
  const ids = [...new Set([...parseServerIds(conv?.ssh_server_ids), ...parseServerIds(agent?.ssh_server_ids)])];
  const found = existing(ids);
  return ids.filter((id) => found.has(id));
}

/** Agents and chats (not archived) that use the server. */
export function sshAssignments(serverId: string): SshAssignment[] {
  const uses = "EXISTS (SELECT 1 FROM json_each(ssh_server_ids) WHERE value = ?)";
  const agents = all<{ id: string; name: string }>(`SELECT id, name FROM agents WHERE ${uses} ORDER BY name COLLATE NOCASE`, serverId);
  const chats = all<{ id: string; title: string }>(
    `SELECT id, title FROM conversations WHERE archived = 0 AND ${uses} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 50`,
    serverId,
  );
  return [...agents.map((r) => ({ kind: "agent" as const, id: r.id, name: r.name })), ...chats.map((r) => ({ kind: "conversation" as const, id: r.id, name: r.title }))];
}

/** A deleted server leaves every agent and chat (call inside the delete's transaction). */
export function removeServerEverywhere(serverId: string): { agents: string[]; conversations: string[] } {
  const uses = "EXISTS (SELECT 1 FROM json_each(ssh_server_ids) WHERE value = ?)";
  const without = "COALESCE((SELECT json_group_array(value) FROM json_each(ssh_server_ids) WHERE value <> ?), '[]')";
  const agents = all<{ id: string }>(`SELECT id FROM agents WHERE ${uses}`, serverId).map((r) => r.id);
  const conversations = all<{ id: string }>(`SELECT id FROM conversations WHERE ${uses}`, serverId).map((r) => r.id);
  run(`UPDATE agents SET ssh_server_ids = ${without} WHERE ${uses}`, serverId, serverId);
  run(`UPDATE conversations SET ssh_server_ids = ${without} WHERE ${uses}`, serverId, serverId);
  return { agents, conversations };
}
