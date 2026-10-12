/**
 * Phone calls: agents call people (a business to book an appointment, a lead, the owner with an urgent question) and
 * answer calls to Godmode's number. The voice runs on ElevenLabs Agents with a Twilio or SIP number imported there;
 * Godmode places calls over its API and reads each finished call back (transcript, summary, outcome), so no public
 * address is needed. A finished call continues the chat that placed it.
 */
import type { ID, ISODate } from "./models";

export type CallDirection = "outbound" | "inbound";
/** `task`: an agent's call · `question`: the owner is asked something that waits for the answer · `inform`: the owner is told something · `inbound`: someone called Godmode's number. */
export type CallPurpose = "task" | "question" | "inform" | "inbound";
/**
 * `calling` → `in_progress` → `processing` (the call ended, the summary is being made) → `done`.
 * `no_answer`: nobody picked up (busy, voicemail, rang out) · `failed`: the call couldn't be placed or broke off.
 */
export type CallStatus = "calling" | "in_progress" | "processing" | "done" | "no_answer" | "failed";

export const CALL_ACTIVE: readonly CallStatus[] = ["calling", "in_progress", "processing"];

export function isCallActive(c: Pick<PhoneCall, "status">): boolean {
  return CALL_ACTIVE.includes(c.status);
}

export interface CallTurn {
  /** `agent`: Godmode's voice · `other`: the person on the line. */
  speaker: "agent" | "other";
  text: string;
  /** Seconds into the call. */
  at: number;
}

export interface PhoneCall {
  id: ID;
  direction: CallDirection;
  purpose: CallPurpose;
  status: CallStatus;
  /** The other side in E.164 (+4915112345678); for an inbound call the caller ("" when withheld). */
  number: string;
  /** Who it is, when known ("Salon Haarwerk"). */
  contactName: string;
  /** What the call is for, as the agent wrote it (outbound) or what the caller wanted (inbound, after the call). */
  goal: string;
  language: string;
  /** The agent whose call it is, and the chat that continues with the result. */
  agentId: ID | null;
  agentName: string | null;
  conversationId: ID | null;
  /** A question the owner is asked on the phone: their answer on the call answers it. */
  questionId: ID | null;
  /** The call's id at the provider (ElevenLabs conversation id). */
  providerCallId: string | null;
  /** Short summary of the call ("" until it ended). */
  summary: string;
  /** What came out of it: what was agreed, the appointment, the caller's request ("" = nothing). */
  outcome: string;
  /** The answer the owner gave to the question of a `question` call ("" = none). */
  answer: string;
  /** Whether the call reached its goal, as judged after the call (null = unknown). */
  successful: boolean | null;
  transcript: CallTurn[];
  durationSecs: number | null;
  /** What the call cost at the provider, in US dollars (null = unknown). */
  costUsd: number | null;
  hasAudio: boolean;
  error: string | null;
  createdAt: ISODate;
  endedAt: ISODate | null;
}

/** A number in the provider account that calls can go out from (and come in to). */
export interface CallNumber {
  id: string;
  number: string;
  label: string;
  provider: string;
  /** Inbound calls to it are answered by Godmode's voice agent. */
  answersInbound: boolean;
}

export interface CallVoice {
  id: string;
  name: string;
  /** e.g. "female · German · warm" */
  description: string;
  previewUrl: string | null;
}

/** What Settings → Phone calls shows: whether calls can be made, and what to fix if not. */
export interface CallSetup {
  /** Where the ElevenLabs key comes from: a Godmode key (vault), an API tool, or none. */
  keySource: "vault" | "api_tool" | null;
  numbers: CallNumber[];
  voices: CallVoice[];
  llms: string[];
  /** The ElevenLabs agent Godmode manages for its calls. */
  providerAgentId: string | null;
  /** Calls can be placed now. */
  ready: boolean;
  /** What stands in the way, in plain words ([] when ready). */
  problems: string[];
}

export interface PlaceCallInput {
  to: string;
  goal: string;
  context?: string;
  contactName?: string;
  language?: string;
}

export interface ImportCallNumberInput {
  number: string;
  label?: string;
  /** Twilio Account SID and Auth Token (or an API key SID + secret); sent to ElevenLabs, never stored by Godmode. */
  sid: string;
  token: string;
}

/** A phone number in E.164 ("+49 151 1234-5678" → "+4915112345678"); "00" counts as "+". Null when it isn't one. */
export function toE164(raw: string): string | null {
  let s = raw.trim().replace(/[\s()./-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/** "HH:MM" (24 h). */
export function isClockTime(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
