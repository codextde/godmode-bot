import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import * as vault from "../src/vault/vault";
import { audioFilename, isoLanguage, speak, transcribe } from "../src/voice/voice";
import { registerVoiceRoutes } from "../src/server/routes/voice";
import { HttpError } from "../src/util";

const PASSPHRASE = "correct horse battery staple";
let dataDir: string;

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  json?: unknown;
  form?: FormData;
}
const realFetch = globalThis.fetch;
let captured: Captured[] = [];
let respond: (c: Captured) => Response = () => new Response("unmocked", { status: 500 });

async function expectHttpError(fn: () => unknown, status: number): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    return err as HttpError;
  }
  throw new Error(`expected HttpError ${status}`);
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-voice-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  vault.lock();
  await vault.setup(PASSPHRASE, false);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const type = req.headers.get("content-type") ?? "";
    const c: Captured = { url: req.url, method: req.method, headers: req.headers };
    if (type.includes("multipart/form-data")) c.form = await req.formData();
    else if (type.includes("json")) c.json = await req.json();
    captured.push(c);
    return respond(c);
  }) as typeof fetch;
});

beforeEach(() => {
  captured = [];
  respond = () => new Response("unmocked", { status: 500 });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("helpers", () => {
  test("language + filename normalization", () => {
    expect(isoLanguage("de-DE")).toBe("de");
    expect(isoLanguage("en")).toBe("en");
    expect(isoLanguage("")).toBeUndefined();
    expect(isoLanguage("zz-999-x")).toBe("zz");
    expect(audioFilename("audio/webm;codecs=opus")).toBe("speech.webm");
    expect(audioFilename("audio/mp4")).toBe("speech.m4a");
    expect(audioFilename("", "memo.wav")).toBe("memo.wav");
    expect(audioFilename("audio/ogg", "blob")).toBe("speech.ogg");
  });
});

describe("transcribe", () => {
  const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" });

  test("browser provider without an OpenAI key → actionable 400 (no upstream call)", async () => {
    updateSettings({ voice: { sttProvider: "browser" } });
    const err = await expectHttpError(() => transcribe(audio), 400);
    expect(err.message).toContain("Add an OpenAI API key");
    expect(captured).toHaveLength(0);
  });

  test("browser provider falls back to OpenAI when the app uploads a recording and a key exists", async () => {
    updateSettings({ voice: { sttProvider: "browser" } });
    vault.setAppSecret("openai_api_key", "sk-openai-test");
    respond = () => Response.json({ text: " hallo welt " });
    try {
      const { text } = await transcribe(audio);
      expect(text).toBe("hallo welt");
      expect(captured.at(-1)?.url).toContain("/audio/transcriptions");
    } finally {
      vault.setAppSecret("openai_api_key", null);
    }
  });

  test("openai without a key → helpful 400", async () => {
    updateSettings({ voice: { sttProvider: "openai" } });
    const err = await expectHttpError(() => transcribe(audio), 400);
    expect(err.message).toBe("Add your OpenAI API key in Settings → Integrations");
    expect(captured).toHaveLength(0);
  });

  test("openai: multipart upload with model + ISO language", async () => {
    vault.setAppSecret("openai_api_key", "sk-openai-test");
    updateSettings({ voice: { sttProvider: "openai", sttModel: "gpt-4o-transcribe", language: "de-DE", openaiBaseUrl: "https://proxy.example/v1/" } });
    respond = () => Response.json({ text: "  Hallo Welt  " });
    expect(await transcribe(audio)).toEqual({ text: "Hallo Welt" });
    const c = captured[0]!;
    expect(c.url).toBe("https://proxy.example/v1/audio/transcriptions");
    expect(c.headers.get("authorization")).toBe("Bearer sk-openai-test");
    expect(c.form!.get("model")).toBe("gpt-4o-transcribe");
    expect(c.form!.get("language")).toBe("de");
    expect((c.form!.get("file") as File).name).toBe("speech.webm");

    // Explicit language wins.
    await transcribe(audio, { language: "fr-FR" });
    expect(captured[1]!.form!.get("language")).toBe("fr");
  });

  test("upstream errors are mapped (401 never forwarded)", async () => {
    respond = () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 });
    const bad = await expectHttpError(() => transcribe(audio), 400);
    expect(bad.message).toContain("OpenAI rejected the API key");
    respond = () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429, headers: { "retry-after": "7" } });
    expect((await expectHttpError(() => transcribe(audio), 429)).message).toContain("try again in 7 s");
    respond = () => new Response("oops", { status: 500 });
    await expectHttpError(() => transcribe(audio), 502);
    await expectHttpError(() => transcribe(new Blob([])), 400);
  });

  test("locked vault → 423", async () => {
    vault.lock();
    try {
      await expectHttpError(() => transcribe(audio), 423);
    } finally {
      await vault.unlock(PASSPHRASE);
    }
  });
});

describe("speak", () => {
  test("validation + browser provider", async () => {
    updateSettings({ voice: { ttsProvider: "browser" } });
    expect((await expectHttpError(() => speak("hello"), 400)).message).toBe("Speech synthesis runs in the app for the browser provider");
    updateSettings({ voice: { ttsProvider: "openai" } });
    await expectHttpError(() => speak("   "), 400);
    await expectHttpError(() => speak("x".repeat(4001)), 400);
  });

  test("openai: streams mp3", async () => {
    updateSettings({ voice: { ttsProvider: "openai", ttsModel: "gpt-4o-mini-tts", ttsVoice: "nova", openaiBaseUrl: "https://api.openai.com/v1" } });
    respond = () => new Response(new Uint8Array([0xff, 0xfb, 0x90]), { headers: { "content-type": "audio/mpeg" } });
    const audio = await speak(" Hello there ");
    expect(audio.contentType).toBe("audio/mpeg");
    expect([...new Uint8Array(await new Response(audio.stream).arrayBuffer())]).toEqual([0xff, 0xfb, 0x90]);
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(captured[0]!.json).toEqual({ model: "gpt-4o-mini-tts", voice: "nova", input: "Hello there", response_format: "mp3" });
  });

  test("elevenlabs: voice id, output format, xi-api-key", async () => {
    updateSettings({ voice: { ttsProvider: "elevenlabs", elevenlabsVoiceId: "voice123" } });
    expect((await expectHttpError(() => speak("hi"), 400)).message).toBe("Add your ElevenLabs API key in Settings → Integrations");
    vault.setAppSecret("elevenlabs_api_key", "xi-test-key");
    respond = () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } });
    await speak("Guten Tag");
    const c = captured[0]!;
    expect(c.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128");
    expect(c.headers.get("xi-api-key")).toBe("xi-test-key");
    expect(c.json).toEqual({ text: "Guten Tag", model_id: "eleven_flash_v2_5" });

    respond = () => new Response(JSON.stringify({ detail: { status: "voice_not_found", message: "Voice not found" } }), { status: 404 });
    expect((await expectHttpError(() => speak("x"), 400)).message).toBe("ElevenLabs: Voice not found");
  });
});

describe("routes", () => {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    return c.json({ error: String(err) }, 500);
  });
  registerVoiceRoutes(app);

  test("POST /api/voice/transcribe (multipart) and /api/voice/speak", async () => {
    updateSettings({ voice: { sttProvider: "openai", ttsProvider: "openai" } });
    respond = (c) =>
      c.url.endsWith("/audio/transcriptions")
        ? Response.json({ text: "dictated" })
        : new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } });

    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array([1])], { type: "audio/webm" }), "speech.webm");
    form.set("language", "en-US");
    let res = await app.request("/api/voice/transcribe", { method: "POST", body: form });
    expect(await res.json()).toEqual({ text: "dictated" });

    res = await app.request("/api/voice/transcribe", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);

    res = await app.request("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 9]);
  });
});
