/**
 * Which Android phones an agent or chat controls (`android_device_ids` columns, JSON arrays). Kept free of service
 * imports so the agent and conversation services and the runner can use it without depending on the phone service.
 */
import type { AndroidAssignment } from "@godmode/shared";
import { all, get, run } from "../db";
import { parseJson } from "../util";

function existing(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  return new Set(all<{ id: string }>(`SELECT id FROM android_devices WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids).map((r) => r.id));
}

export function parseDeviceIds(value: string | null | undefined): string[] {
  const list = parseJson<unknown>(value, []);
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
}

/** undefined = unchanged, else the ids of phones that exist (one forgotten while a screen still showed it is dropped). */
export function normalizeAndroidDeviceIds(value: string[] | null | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = [...new Set((value ?? []).map((v) => v.trim()).filter(Boolean))];
  const found = existing(ids);
  return ids.filter((id) => found.has(id));
}

/** The phones a run may control: its chat's and its agent's, in that order (forgotten ones are skipped). */
export function runAndroidDeviceIds(conversationId: string | null, agentId: string): string[] {
  const conv = conversationId ? get<{ android_device_ids: string | null }>("SELECT android_device_ids FROM conversations WHERE id = ?", conversationId) : null;
  const agent = get<{ android_device_ids: string | null }>("SELECT android_device_ids FROM agents WHERE id = ?", agentId);
  const ids = [...new Set([...parseDeviceIds(conv?.android_device_ids), ...parseDeviceIds(agent?.android_device_ids)])];
  const found = existing(ids);
  return ids.filter((id) => found.has(id));
}

const USES = "EXISTS (SELECT 1 FROM json_each(android_device_ids) WHERE value = ?)";

/** Agents and chats (not archived) that use the phone. */
export function androidAssignments(deviceId: string): AndroidAssignment[] {
  const agents = all<{ id: string; name: string }>(`SELECT id, name FROM agents WHERE ${USES} ORDER BY name COLLATE NOCASE`, deviceId);
  const chats = all<{ id: string; title: string }>(
    `SELECT id, title FROM conversations WHERE archived = 0 AND ${USES} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 50`,
    deviceId,
  );
  return [...agents.map((r) => ({ kind: "agent" as const, id: r.id, name: r.name })), ...chats.map((r) => ({ kind: "conversation" as const, id: r.id, name: r.title }))];
}

/** A forgotten phone leaves every agent and chat (call inside the delete's transaction). */
export function removeDeviceEverywhere(deviceId: string): { agents: string[]; conversations: string[] } {
  const without = "COALESCE((SELECT json_group_array(value) FROM json_each(android_device_ids) WHERE value <> ?), '[]')";
  const agents = all<{ id: string }>(`SELECT id FROM agents WHERE ${USES}`, deviceId).map((r) => r.id);
  const conversations = all<{ id: string }>(`SELECT id FROM conversations WHERE ${USES}`, deviceId).map((r) => r.id);
  run(`UPDATE agents SET android_device_ids = ${without} WHERE ${USES}`, deviceId, deviceId);
  run(`UPDATE conversations SET android_device_ids = ${without} WHERE ${USES}`, deviceId, deviceId);
  return { agents, conversations };
}
