/**
 * ElevenLabs Agents: the voice of Godmode's phone calls. One agent in the account ("Godmode Phone") answers incoming
 * calls with the inbound instructions; every outbound call overrides its prompt, first message, language and voice.
 * Godmode only calls out to the API (no webhooks), so it works on a laptop without a public address.
 */
import type { CallNumber, CallTurn, CallVoice } from "@godmode/shared";
import { all } from "../db";
import { apiToolKey, markApiToolUsed } from "../integrations/apiTools";
import { HttpError } from "../util";
import * as vault from "../vault/vault";
import { ELEVENLABS_API_KEY_SECRET, ELEVENLABS_BASE_URL } from "../voice/voice";

const TIMEOUT_MS = 30_000;
const TTS_MODEL = "eleven_flash_v2_5";

export interface ElevenLabsKey {
  key: string;
  source: "vault" | "api_tool";
  toolId?: string;
}

/**
 * The key calls use: the Voice key (vault), else an enabled ElevenLabs API tool open to every agent (global, not
 * pinned): calls are Godmode's, not one agent's. Null when there is none.
 */
export function elevenLabsKey(): ElevenLabsKey | null {
  try {
    return findKey();
  } catch {
    return null; // the vault is locked
  }
}

function findKey(): ElevenLabsKey | null {
  const own = vault.getAppSecret(ELEVENLABS_API_KEY_SECRET);
  if (own) return { key: own, source: "vault" };
  const tools = all<{ id: string; base_url: string }>(
    "SELECT id, base_url FROM api_tools WHERE enabled = 1 AND workspace_id IS NULL AND agent_id IS NULL AND key_enc IS NOT NULL ORDER BY created_at",
  );
  for (const t of tools) {
    try {
      const u = new URL(t.base_url);
      if (u.protocol !== "https:" || u.host !== "api.elevenlabs.io") continue;
    } catch {
      continue;
    }
    const key = apiToolKey(t.id);
    if (key) return { key, source: "api_tool", toolId: t.id };
  }
  return null;
}

export const NO_KEY = "Add an ElevenLabs API key (Settings → Integrations → API keys, or an ElevenLabs API tool for all agents)";

function requireKey(): ElevenLabsKey {
  const k = elevenLabsKey();
  if (!k) throw new HttpError(400, NO_KEY, "calls_no_key");
  return k;
}

function message(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const d = data as { detail?: unknown; message?: unknown };
    if (typeof d.detail === "string") return d.detail;
    if (d.detail && typeof d.detail === "object") {
      const inner = d.detail as { message?: unknown; msg?: unknown };
      if (typeof inner.message === "string") return inner.message;
      if (typeof inner.msg === "string") return inner.msg;
    }
    if (Array.isArray(d.detail) && d.detail[0] && typeof d.detail[0].msg === "string") return d.detail[0].msg;
    if (typeof d.message === "string") return d.message;
  }
  return fallback;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new HttpError(502, "ElevenLabs returned an unexpected answer", "calls_upstream");
  }
}

export async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  const k = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${ELEVENLABS_BASE_URL}${path}`, {
      method,
      headers: { "xi-api-key": k.key, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    throw new HttpError(502, aborted ? "ElevenLabs did not answer in time" : `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}`, "calls_unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (k.toolId) markApiToolUsed(k.toolId);
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const why = message(data, text.replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new HttpError(400, `ElevenLabs refused the key: ${why}`, "calls_invalid_key");
  if (res.status === 404) throw new HttpError(404, `ElevenLabs: ${why}`, "calls_not_found");
  if (res.status === 429) throw new HttpError(429, `ElevenLabs rate limit or quota reached: ${why}`, "calls_rate_limited");
  if (res.status < 500) throw new HttpError(400, `ElevenLabs: ${why}`, "calls_bad_request");
  throw new HttpError(502, `ElevenLabs error (HTTP ${res.status}): ${why}`, "calls_upstream");
}

/* ------------------------------------------------------------------ */
/* The voice agent                                                     */
/* ------------------------------------------------------------------ */

/** What the analysis after each call extracts (data collection). */
export const DATA_FIELDS = {
  outcome: {
    type: "string",
    description:
      "What came out of the call, concrete and complete: what was agreed or booked (with date, time, place, price, names), what the other side promised or asked for, or why the goal wasn't reached. Empty if nothing happened.",
  },
  answer: {
    type: "string",
    description:
      "Only for calls the assistant made to ask the other person a decision or question it was sent with: their answer to that question (not to small talk like 'do you have a minute'), complete and in their words; when suggested answers were named, the one they chose. Also any instruction they gave for the team. Empty if they gave no answer.",
  },
  caller_name: { type: "string", description: "The other person's name or company, if they said it. Empty otherwise." },
  callback_number: { type: "string", description: "A phone number the other person gave to be called back on, in international format. Empty otherwise." },
} as const;

export interface AgentConfig {
  name: string;
  prompt: string;
  firstMessage: string;
  language: string;
  llm: string;
  voiceId: string;
  maxSeconds: number;
}

const systemTool = (name: string) => ({ name, description: "", params: { system_tool_type: name } });

export function agentBody(c: AgentConfig) {
  return {
    name: c.name,
    tags: ["godmode"],
    conversation_config: {
      agent: {
        first_message: c.firstMessage,
        language: c.language,
        prompt: {
          prompt: c.prompt,
          llm: c.llm,
          temperature: 0.4,
          built_in_tools: { end_call: systemTool("end_call"), voicemail_detection: systemTool("voicemail_detection"), play_keypad_touch_tone: systemTool("play_keypad_touch_tone") },
        },
      },
      tts: { model_id: TTS_MODEL, ...(c.voiceId ? { voice_id: c.voiceId } : {}) },
      conversation: { max_duration_seconds: c.maxSeconds },
      turn: { turn_eagerness: "normal", silence_end_call_timeout: 30 },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true, llm: true } },
          tts: { voice_id: true },
          conversation: { max_duration_seconds: true },
        },
      },
      data_collection: DATA_FIELDS,
    },
  };
}

export async function createAgent(c: AgentConfig): Promise<string> {
  const out = await api<{ agent_id?: string }>("POST", "/v1/convai/agents/create", agentBody(c));
  if (!out?.agent_id) throw new HttpError(502, "ElevenLabs did not return the new agent", "calls_upstream");
  return out.agent_id;
}

export async function updateAgent(agentId: string, c: AgentConfig): Promise<void> {
  await api("PATCH", `/v1/convai/agents/${encodeURIComponent(agentId)}`, agentBody(c));
}

export async function agentExists(agentId: string): Promise<boolean> {
  try {
    await api("GET", `/v1/convai/agents/${encodeURIComponent(agentId)}`);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return false;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Numbers, voices, models                                             */
/* ------------------------------------------------------------------ */

interface NumberRow {
  phone_number: string;
  label: string;
  phone_number_id: string;
  provider: string;
  assigned_agent?: { agent_id: string } | null;
}

export async function listNumbers(agentId: string | null): Promise<(CallNumber & { assignedAgentId: string | null })[]> {
  const rows = (await api<NumberRow[]>("GET", "/v1/convai/phone-numbers")) ?? [];
  return rows.map((r) => ({
    assignedAgentId: r.assigned_agent?.agent_id ?? null,
    id: r.phone_number_id,
    number: r.phone_number,
    label: r.label ?? "",
    provider: r.provider,
    answersInbound: !!agentId && r.assigned_agent?.agent_id === agentId,
  }));
}

export async function importTwilioNumber(input: { number: string; label: string; sid: string; token: string }): Promise<string> {
  const out = await api<{ phone_number_id?: string }>("POST", "/v1/convai/phone-numbers", {
    provider: "twilio",
    phone_number: input.number,
    label: input.label,
    sid: input.sid,
    token: input.token,
  });
  if (!out?.phone_number_id) throw new HttpError(502, "ElevenLabs did not return the imported number", "calls_upstream");
  return out.phone_number_id;
}

/** Inbound calls to the number are answered by `agentId` (null: by nobody). */
export async function assignNumber(numberId: string, agentId: string | null): Promise<void> {
  await api("PATCH", `/v1/convai/phone-numbers/${encodeURIComponent(numberId)}`, { agent_id: agentId });
}

export async function listVoices(): Promise<CallVoice[]> {
  const out = await api<{ voices?: { voice_id: string; name: string; labels?: Record<string, string>; preview_url?: string | null }[] }>(
    "GET",
    "/v2/voices?page_size=100&sort=name&sort_direction=asc",
  );
  return (out?.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    description: [v.labels?.gender, v.labels?.accent ?? v.labels?.language, v.labels?.description ?? v.labels?.descriptive].filter(Boolean).join(" · "),
    previewUrl: v.preview_url ?? null,
  }));
}

export async function listLlms(): Promise<string[]> {
  const out = await api<{ llms?: { llm: string; deprecation_info?: unknown; is_checkpoint?: boolean }[] }>("GET", "/v1/convai/llm/list");
  return (out?.llms ?? []).filter((l) => !l.deprecation_info && !l.is_checkpoint && l.llm !== "custom-llm" && !/@|\d{4}-\d{2}-\d{2}/.test(l.llm)).map((l) => l.llm);
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export interface OutboundCall {
  agentId: string;
  numberId: string;
  provider: string;
  to: string;
  prompt: string;
  firstMessage: string;
  language: string;
  llm: string;
  voiceId: string;
  maxSeconds: number;
}

/** Starts the call; returns the ElevenLabs conversation it is read back from. */
export async function placeOutbound(c: OutboundCall): Promise<string> {
  const path = c.provider === "sip_trunk" ? "/v1/convai/sip-trunk/outbound-call" : "/v1/convai/twilio/outbound-call";
  const out = await api<{ success?: boolean; message?: string; conversation_id?: string | null }>("POST", path, {
    agent_id: c.agentId,
    agent_phone_number_id: c.numberId,
    to_number: c.to,
    telephony_call_config: { ringing_timeout_secs: 45 },
    conversation_initiation_client_data: {
      conversation_config_override: {
        agent: { first_message: c.firstMessage, language: c.language, prompt: { prompt: c.prompt, llm: c.llm } },
        ...(c.voiceId ? { tts: { voice_id: c.voiceId } } : {}),
        conversation: { max_duration_seconds: c.maxSeconds },
      },
    },
  });
  if (!out?.success || !out.conversation_id) throw new HttpError(502, `The call couldn't be placed: ${out?.message || "no answer from ElevenLabs"}`, "calls_failed");
  return out.conversation_id;
}

export type ProviderStatus = "initiated" | "in-progress" | "processing" | "done" | "failed";

export interface ProviderCall {
  id: string;
  status: ProviderStatus;
  direction: "inbound" | "outbound" | null;
  externalNumber: string;
  /** answered | voicemail | busy | no_answer | failed, when the phone line reported it. */
  callResult: string | null;
  transcript: CallTurn[];
  durationSecs: number;
  startedAt: number;
  costUsd: number | null;
  summary: string;
  title: string;
  successful: boolean | null;
  data: Record<string, string>;
  terminationReason: string;
  hasAudio: boolean;
}

interface ConversationJson {
  conversation_id: string;
  status: ProviderStatus;
  has_audio?: boolean;
  transcript?: { role: "user" | "agent"; message?: string | null; time_in_call_secs?: number }[];
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    cost_fiat?: number | null;
    termination_reason?: string;
    phone_call?: { direction?: "inbound" | "outbound"; external_number?: string; call_result?: string | null } | null;
  };
  analysis?: {
    call_successful?: "success" | "failure" | "unknown";
    transcript_summary?: string;
    call_summary_title?: string | null;
    data_collection_results?: Record<string, { value?: unknown }>;
  } | null;
}

export function parseConversation(c: ConversationJson): ProviderCall {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.analysis?.data_collection_results ?? {})) {
    if (v?.value !== undefined && v.value !== null && String(v.value).trim()) data[k] = String(v.value).trim();
  }
  const ok = c.analysis?.call_successful;
  return {
    id: c.conversation_id,
    status: c.status,
    direction: c.metadata?.phone_call?.direction ?? null,
    externalNumber: c.metadata?.phone_call?.external_number ?? "",
    callResult: c.metadata?.phone_call?.call_result ?? null,
    transcript: (c.transcript ?? [])
      .filter((t) => typeof t.message === "string" && t.message.trim())
      .map((t) => ({ speaker: t.role === "agent" ? "agent" : "other", text: t.message!.trim(), at: t.time_in_call_secs ?? 0 })),
    durationSecs: c.metadata?.call_duration_secs ?? 0,
    startedAt: c.metadata?.start_time_unix_secs ?? 0,
    costUsd: typeof c.metadata?.cost_fiat === "number" ? c.metadata.cost_fiat : null,
    summary: c.analysis?.transcript_summary?.trim() ?? "",
    title: c.analysis?.call_summary_title?.trim() ?? "",
    successful: ok === "success" ? true : ok === "failure" ? false : null,
    data,
    terminationReason: c.metadata?.termination_reason ?? "",
    hasAudio: !!c.has_audio,
  };
}

export async function getCall(conversationId: string): Promise<ProviderCall> {
  return parseConversation(await api<ConversationJson>("GET", `/v1/convai/conversations/${encodeURIComponent(conversationId)}`));
}

/** Calls of the agent that started after `sinceUnix`, newest first (ids only; read each with getCall). */
export async function recentCalls(agentId: string, sinceUnix: number): Promise<{ id: string; direction: string | null; status: ProviderStatus }[]> {
  const q = new URLSearchParams({ agent_id: agentId, page_size: "30", call_start_after_unix: String(Math.floor(sinceUnix)) });
  const out = await api<{ conversations?: { conversation_id: string; direction?: string | null; status: ProviderStatus }[] }>("GET", `/v1/convai/conversations?${q}`);
  return (out?.conversations ?? []).map((c) => ({ id: c.conversation_id, direction: c.direction ?? null, status: c.status }));
}

export async function callAudio(conversationId: string): Promise<Response> {
  return raw("GET", `/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`);
}
