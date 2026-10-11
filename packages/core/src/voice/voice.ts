/**
 * Server-side voice: speech-to-text (OpenAI transcriptions) and text-to-speech (OpenAI speech, ElevenLabs).
 * The "browser" providers run entirely in the UI (Web Speech API) and never reach these functions.
 * API keys are vault app secrets: `openai_api_key`, `elevenlabs_api_key`.
 */
import type { Agent, Settings } from "@godmode/shared";
import { apiToolKey, apiToolsForAgent, markApiToolUsed } from "../integrations/apiTools";
import { getSettings } from "../services/settings";
import * as vault from "../vault/vault";
import { badRequest, HttpError } from "../util";

export const OPENAI_API_KEY_SECRET = "openai_api_key";
export const ELEVENLABS_API_KEY_SECRET = "elevenlabs_api_key";
export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_MODEL = "eleven_flash_v2_5";
export const ELEVENLABS_STT_MODEL = "scribe_v2";
const OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
/** OpenAI's upload limit for transcriptions. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_SPEAK_CHARS = 4000;

const STT_TIMEOUT_MS = 120_000;
/** Time allowed for a transcript to arrive once the provider started answering. */
const STT_BODY_TIMEOUT_MS = 30_000;
/** Time allowed until the TTS provider starts answering; the audio itself then streams without a deadline. */
const TTS_TIMEOUT_MS = 60_000;

type Provider = "OpenAI" | "ElevenLabs";

function apiKey(secret: string, provider: Provider): string {
  const value = vault.getAppSecret(secret); // 423 when stored but the vault is locked
  if (!value) throw badRequest(`Add your ${provider} API key in Settings → Integrations`, { secret });
  return value;
}

function openaiBaseUrl(voice: Settings["voice"]): string {
  const raw = (voice.openaiBaseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw badRequest(`Invalid OpenAI base URL in Settings → Voice: ${raw}`);
  }
  return raw;
}

/** OpenAI wants ISO-639-1 ("en"), the app stores BCP-47 ("en-US"). */
export function isoLanguage(tag: string | null | undefined): string | undefined {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};
const KNOWN_EXT = /\.(webm|ogg|oga|m4a|mp4|mp3|mpga|mpeg|wav|flac)$/i;

/** OpenAI detects the audio format from the file name, so make sure it carries the right extension. */
export function audioFilename(mime: string, provided?: string | null): string {
  if (provided && KNOWN_EXT.test(provided)) return provided.replace(/[^A-Za-z0-9._-]/g, "_");
  const ext = AUDIO_EXT[(mime || "").split(";")[0]!.trim().toLowerCase()] ?? "webm";
  return `speech.${ext}`;
}

function providerMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const d = data as { error?: unknown; detail?: unknown; message?: unknown };
    if (d.error && typeof d.error === "object" && typeof (d.error as { message?: unknown }).message === "string") {
      return (d.error as { message: string }).message;
    }
    if (typeof d.detail === "string") return d.detail;
    if (d.detail && typeof d.detail === "object" && typeof (d.detail as { message?: unknown }).message === "string") {
      return (d.detail as { message: string }).message;
    }
    if (typeof d.message === "string") return d.message;
  }
  return fallback;
}

async function providerFetch(provider: Provider, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    throw new HttpError(
      502,
      aborted ? `${provider} did not respond within ${timeoutMs / 1000} seconds` : `Could not reach ${provider}: ${err instanceof Error ? err.message : String(err)}`,
      "voice_unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res;

  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const message = providerMessage(data, text.replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${res.status}`);
  // Never forward 401: the UI would treat it as an expired Godmode session.
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(400, `${provider} rejected the API key (${message}). Check it in Settings → Integrations.`, "voice_invalid_key");
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new HttpError(429, `${provider} rate limit or quota reached${retry ? ` — try again in ${retry} s` : ""}: ${message}`, "voice_rate_limited");
  }
  if (res.status >= 400 && res.status < 500) throw new HttpError(400, `${provider}: ${message}`, "voice_bad_request");
  throw new HttpError(502, `${provider} error (HTTP ${res.status}): ${message}`, "voice_upstream");
}

export async function transcribe(audio: Blob, opts: { language?: string | null; filename?: string | null } = {}): Promise<{ text: string }> {
  const voice = getSettings().voice;
  if (voice.sttProvider !== "openai" && voice.sttProvider !== "browser") {
    throw badRequest(`Unsupported speech recognition provider: ${String(voice.sttProvider)}`);
  }
  // "browser" normally transcribes inside the app. The app only records and uploads audio when this window has no
  // speech service (e.g. WebView2/WebKitGTK) — transcribe it with OpenAI when a key is available.
  if (voice.sttProvider === "browser" && !vault.hasAppSecret(OPENAI_API_KEY_SECRET)) {
    throw badRequest(
      "Speech recognition isn't available in this window. Add an OpenAI API key (Settings → Integrations → API keys) so Godmode can transcribe your dictation, or switch Voice → Speech recognition to OpenAI.",
    );
  }
  if (!audio || audio.size === 0) throw badRequest("The recording is empty");
  if (audio.size > MAX_AUDIO_BYTES) throw new HttpError(413, "Recordings are limited to 25 MB", "too_large");

  return {
    text: await openaiTranscript(audio, {
      key: apiKey(OPENAI_API_KEY_SECRET, "OpenAI"),
      baseUrl: openaiBaseUrl(voice),
      model: voice.sttModel || OPENAI_STT_MODEL,
      language: isoLanguage(opts.language || voice.language),
      filename: opts.filename,
    }),
  };
}

async function openaiTranscript(
  audio: Blob,
  opts: { key: string; baseUrl: string; model: string; language?: string; filename?: string | null },
): Promise<string> {
  const form = new FormData();
  form.set("file", audio, audioFilename(audio.type, opts.filename));
  form.set("model", opts.model);
  form.set("response_format", "json");
  if (opts.language) form.set("language", opts.language);

  const res = await providerFetch(
    "OpenAI",
    `${opts.baseUrl}/audio/transcriptions`,
    { method: "POST", headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" }, body: form },
    STT_TIMEOUT_MS,
  );
  return transcriptIn("OpenAI", res);
}

async function transcriptIn(provider: Provider, res: Response): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(502, `${provider} did not finish its answer within ${STT_BODY_TIMEOUT_MS / 1000} seconds`, "voice_unreachable")), STT_BODY_TIMEOUT_MS);
  });
  try {
    const data = (await Promise.race([res.json().catch(() => null), late])) as { text?: unknown } | null;
    if (!data || typeof data.text !== "string") throw new HttpError(502, `${provider} returned an unexpected transcription response`, "voice_upstream");
    return data.text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function elevenlabsTranscript(audio: Blob, opts: { key: string; filename?: string | null }): Promise<string> {
  const form = new FormData();
  form.set("file", audio, audioFilename(audio.type, opts.filename));
  form.set("model_id", ELEVENLABS_STT_MODEL);
  form.set("tag_audio_events", "false");
  form.set("timestamps_granularity", "none");

  const res = await providerFetch(
    "ElevenLabs",
    `${ELEVENLABS_BASE_URL}/v1/speech-to-text`,
    { method: "POST", headers: { "xi-api-key": opts.key, accept: "application/json" }, body: form },
    STT_TIMEOUT_MS,
  );
  return transcriptIn("ElevenLabs", res);
}

type RecordingAgent = Pick<Agent, "id" | "workspaceId" | "inheritMcp">;

interface Transcriber {
  provider: "openai" | "elevenlabs";
  key: string;
  /** The API tool the key belongs to, when it isn't one of the Voice keys. */
  toolId?: string;
}

const TOOL_HOSTS: Record<string, Transcriber["provider"]> = { "api.openai.com": "openai", "api.elevenlabs.io": "elevenlabs" };

function toolProvider(baseUrl: string): Transcriber["provider"] | null {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" ? (TOOL_HOSTS[u.host] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The key a recording someone sent is transcribed with: the Voice keys first, then an OpenAI or ElevenLabs API tool
 * `agent` may use (the one closest to the agent). Null when there is none.
 */
function transcriberFor(agent: RecordingAgent | null): Transcriber | null {
  for (const [secret, provider] of [
    [OPENAI_API_KEY_SECRET, "openai"],
    [ELEVENLABS_API_KEY_SECRET, "elevenlabs"],
  ] as const) {
    const key = vault.getAppSecret(secret);
    if (key) return { provider, key };
  }
  if (!agent) return null;
  for (const tool of apiToolsForAgent(agent).reverse()) {
    const provider = tool.hasKey ? toolProvider(tool.baseUrl) : null;
    const key = provider ? apiToolKey(tool.id) : null;
    if (provider && key) return { provider, key, toolId: tool.id };
  }
  return null;
}

export const NO_TRANSCRIPTION_KEY = "No OpenAI or ElevenLabs key is set up (Settings → Integrations)";

/**
 * Text of a recording that reached Godmode from outside the app (a voice message in a messaging chat). The language
 * is detected. Throws an HttpError a human can read when it can't be transcribed.
 */
export async function transcribeRecording(audio: Blob, opts: { filename?: string | null; agent?: RecordingAgent | null } = {}): Promise<string> {
  if (!audio || audio.size === 0) throw new HttpError(400, "The recording is empty", "voice_empty");
  if (audio.size > MAX_AUDIO_BYTES) throw new HttpError(413, "Recordings are limited to 25 MB", "too_large");
  const source = transcriberFor(opts.agent ?? null);
  if (!source) throw new HttpError(400, NO_TRANSCRIPTION_KEY, "voice_no_key");
  const voice = getSettings().voice;
  const text =
    source.provider === "elevenlabs"
      ? await elevenlabsTranscript(audio, { key: source.key, filename: opts.filename })
      : await openaiTranscript(audio, {
          key: source.key,
          // A tool's key only ever goes to the tool's own address.
          baseUrl: source.toolId ? "https://api.openai.com/v1" : openaiBaseUrl(voice),
          model: (!source.toolId && voice.sttModel) || OPENAI_STT_MODEL,
          filename: opts.filename,
        });
  if (source.toolId) markApiToolUsed(source.toolId);
  return text;
}

export interface SpeechAudio {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
}

export async function speak(text: string): Promise<SpeechAudio> {
  const voice = getSettings().voice;
  const input = typeof text === "string" ? text.trim() : "";
  if (!input) throw badRequest("Nothing to speak");
  if (input.length > MAX_SPEAK_CHARS) throw badRequest(`Text is too long to speak (max ${MAX_SPEAK_CHARS} characters)`);

  let res: Response;
  switch (voice.ttsProvider) {
    case "browser":
      throw badRequest("Speech synthesis runs in the app for the browser provider");
    case "openai": {
      const key = apiKey(OPENAI_API_KEY_SECRET, "OpenAI");
      res = await providerFetch(
        "OpenAI",
        `${openaiBaseUrl(voice)}/audio/speech`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({ model: voice.ttsModel || "gpt-4o-mini-tts", voice: voice.ttsVoice || "alloy", input, response_format: "mp3" }),
        },
        TTS_TIMEOUT_MS,
      );
      break;
    }
    case "elevenlabs": {
      const key = apiKey(ELEVENLABS_API_KEY_SECRET, "ElevenLabs");
      const voiceId = (voice.elevenlabsVoiceId ?? "").trim();
      if (!voiceId) throw badRequest("Choose an ElevenLabs voice in Settings → Voice");
      res = await providerFetch(
        "ElevenLabs",
        `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({ text: input, model_id: ELEVENLABS_MODEL }),
        },
        TTS_TIMEOUT_MS,
      );
      break;
    }
    default:
      throw badRequest(`Unsupported speech synthesis provider: ${String(voice.ttsProvider)}`);
  }
  if (!res.body) throw new HttpError(502, "The speech provider returned no audio", "voice_upstream");
  return { stream: res.body, contentType: "audio/mpeg" };
}
