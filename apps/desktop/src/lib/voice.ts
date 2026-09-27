/**
 * Voice engine: dictation (Web Speech API or MediaRecorder → core transcription), text-to-speech
 * (speechSynthesis or core TTS) and audio level metering for the voice UI.
 *
 * Pure browser/runtime code — React bindings live in `hooks/use-voice.ts`.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { VoiceSettings } from "@godmode/shared";
import { api, request } from "./api";

/* ------------------------------------------------------------------ */
/* Stores                                                               */
/* ------------------------------------------------------------------ */

interface VoicePrefsState {
  /** Read every assistant reply aloud (composer toggle). */
  speakReplies: boolean;
  setSpeakReplies: (v: boolean) => void;
}

export const useVoicePrefs = create<VoicePrefsState>()(
  persist(
    (set) => ({
      speakReplies: false,
      setSpeakReplies: (speakReplies) => set({ speakReplies }),
    }),
    { name: "godmode-voice" },
  ),
);

interface VoiceSessionState {
  /** Voice mode was opened by the user during this app session (guards against a persisted flag on reload). */
  armed: boolean;
  /** Runs started from a dictated message → their reply may be auto-spoken. */
  voiceRunIds: Record<string, true>;
  /** Key of the text currently being read aloud (message id, run id…) */
  speakingKey: string | null;
  arm: (v: boolean) => void;
  markVoiceRun: (runId: string) => void;
}

export const useVoiceSession = create<VoiceSessionState>((set) => ({
  armed: false,
  voiceRunIds: {},
  speakingKey: null,
  arm: (armed) => set({ armed }),
  markVoiceRun: (runId) => set((s) => ({ voiceRunIds: { ...s.voiceRunIds, [runId]: true } })),
}));

/* ------------------------------------------------------------------ */
/* Text                                                                 */
/* ------------------------------------------------------------------ */

/** Turn markdown into something pleasant to listen to. */
export function stripMarkdown(md: string): string {
  return (
    md
      // fenced code → short spoken hint
      .replace(/```[\s\S]*?```/g, " (code omitted) ")
      .replace(/~~~[\s\S]*?~~~/g, " (code omitted) ")
      // images → alt text, links → label
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // bare urls → host
      .replace(/https?:\/\/([^/\s)]+)[^\s)]*/g, "$1")
      // inline code
      .replace(/`([^`]+)`/g, "$1")
      // html tags
      .replace(/<[^>]+>/g, "")
      // headings, quotes, list markers
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      // tables
      .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
      .replace(/\|/g, ", ")
      // emphasis / strike
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      // horizontal rules
      .replace(/^\s*([-*_]\s*){3,}$/gm, "")
      // whitespace → sentence pauses
      .replace(/\n{2,}/g, ".\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\.\s*\.(\s)/g, ".$1")
      .trim()
  );
}

/** Split long text into speakable chunks (speechSynthesis stalls on very long utterances). */
function chunkText(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*[\s\n]*/g) ?? [text];
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > max && buf) {
      chunks.push(buf.trim());
      buf = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max).trim());
    } else buf += s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                         */
/* ------------------------------------------------------------------ */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

export function canSpeakInBrowser(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function voiceInputSupported(): boolean {
  return !!getSpeechRecognition() || canRecord();
}

function pickRecorderFormat(): { mime: string; ext: string } {
  const candidates: [string, string][] = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/mp4", "m4a"],
    ["audio/ogg;codecs=opus", "ogg"],
  ];
  for (const [mime, ext] of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
    } catch {
      /* ignore */
    }
  }
  return { mime: "", ext: "webm" };
}

/* ------------------------------------------------------------------ */
/* Level metering                                                       */
/* ------------------------------------------------------------------ */

type AudioContextCtor = typeof AudioContext;
function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** RMS level (0…1) of a microphone stream or an <audio> element. */
export class LevelMeter {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private data: Uint8Array<ArrayBuffer>;

  constructor(source: MediaStream | HTMLAudioElement) {
    const Ctor = audioContextCtor();
    if (!Ctor) throw new Error("Web Audio is not available");
    this.ctx = new Ctor();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.5;
    this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    if (source instanceof MediaStream) {
      this.ctx.createMediaStreamSource(source).connect(this.analyser);
    } else {
      const node = this.ctx.createMediaElementSource(source);
      node.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    void this.ctx.resume().catch(() => {});
  }

  read(): number {
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    return Math.min(1, rms * 5);
  }

  close() {
    void this.ctx.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Speech to text                                                       */
/* ------------------------------------------------------------------ */

export type DictationPhase = "listening" | "transcribing";

export interface DictationOptions {
  settings: VoiceSettings | undefined;
  /** Keep listening until stop() (composer dictation). Otherwise end after the first utterance (voice mode). */
  continuous: boolean;
  /** Recorder path: auto-stop after this much silence once speech was heard. */
  silenceMs?: number;
  onPhase?: (phase: DictationPhase) => void;
  onInterim?: (text: string) => void;
  onLevel?: (level: number) => void;
  /** Called exactly once per session (unless cancelled or failed). */
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
}

export interface DictationHandle {
  /** Finish and deliver the transcript. */
  stop: () => void;
  /** Abort without delivering anything. */
  cancel: () => void;
}

const SPEECH_THRESHOLD = 0.12;

/** Start listening. Resolves once the microphone is live. */
export async function startDictation(opts: DictationOptions): Promise<DictationHandle> {
  const Recognition = getSpeechRecognition();
  const preferBrowser = (opts.settings?.sttProvider ?? "browser") === "browser";
  if (preferBrowser && Recognition) {
    return startRecognition(Recognition, opts);
  }
  if (!canRecord()) {
    if (Recognition) return startRecognition(Recognition, opts);
    throw new Error("Voice input isn't supported here.");
  }
  return startRecorder(opts);
}

async function openMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new Error("Microphone access was denied. Allow it in your system settings.");
    if (name === "NotFoundError") throw new Error("No microphone found.");
    throw e instanceof Error ? e : new Error(String(e));
  }
}

function levelLoop(meter: LevelMeter, onFrame: (level: number) => void): () => void {
  let raf = 0;
  const tick = () => {
    onFrame(meter.read());
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

function startRecognition(Recognition: SpeechRecognitionCtor, opts: DictationOptions): Promise<DictationHandle> {
  return new Promise((resolve, reject) => {
    const rec = new Recognition();
    rec.lang = opts.settings?.language || navigator.language || "en-US";
    rec.continuous = opts.continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finals = "";
    let interim = "";
    let done = false;
    let started = false;
    let cancelled = false;
    let fellBack = false;
    let meterStop: (() => void) | null = null;
    let meter: LevelMeter | null = null;
    let stream: MediaStream | null = null;

    const cleanupMeter = () => {
      meterStop?.();
      meter?.close();
      stream?.getTracks().forEach((t) => t.stop());
      meterStop = null;
      meter = null;
      stream = null;
    };

    // Optional level meter for visuals (the recognizer owns the mic, a second tap is fine).
    if (opts.onLevel && canRecord()) {
      void openMic()
        .then((s) => {
          if (done) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = s;
          meter = new LevelMeter(s);
          meterStop = levelLoop(meter, (l) => opts.onLevel?.(l));
        })
        .catch(() => {});
    }

    const finish = () => {
      if (done) return;
      done = true;
      cleanupMeter();
      if (!cancelled) opts.onFinal(`${finals} ${interim}`.replace(/\s+/g, " ").trim());
    };

    rec.onstart = () => {
      started = true;
      opts.onPhase?.("listening");
      resolve(handle);
    };
    rec.onresult = (e) => {
      let f = "";
      let i = "";
      for (let k = 0; k < e.results.length; k++) {
        const r = e.results[k];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) f += t;
        else i += t;
      }
      finals = f;
      interim = i;
      opts.onInterim?.(`${f} ${i}`.replace(/\s+/g, " ").trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // onend follows
      const serviceIssue = e.error === "service-not-allowed" || e.error === "network" || e.error === "language-not-supported";
      if (serviceIssue && !finals && !interim && canRecord() && !fellBack) {
        // Speech service unavailable (e.g. inside a webview) → record and transcribe on the core instead.
        fellBack = true;
        done = true;
        cleanupMeter();
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        startRecorder(opts)
          .then((h) => {
            Object.assign(handle, h);
            if (!started) resolve(handle);
          })
          .catch((err) => (started ? opts.onError(err) : reject(err)));
        return;
      }
      done = true;
      cleanupMeter();
      const msg =
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone or speech recognition access was denied."
          : e.error === "audio-capture"
            ? "No microphone found."
            : `Speech recognition failed (${e.error}).`;
      const err = new Error(msg);
      if (started) opts.onError(err);
      else reject(err);
    };
    rec.onend = () => {
      if (fellBack) return;
      finish();
    };

    const handle: DictationHandle = {
      stop: () => {
        try {
          rec.stop();
        } catch {
          finish();
        }
      },
      cancel: () => {
        cancelled = true;
        done = true;
        cleanupMeter();
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      },
    };

    try {
      rec.start();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

async function startRecorder(opts: DictationOptions): Promise<DictationHandle> {
  const stream = await openMic();
  const { mime, ext } = pickRecorderFormat();
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let meter: LevelMeter | null = null;
  let stopLoop: (() => void) | null = null;
  let cancelled = false;
  let heardSpeech = false;
  let lastLoud = performance.now();
  const startedAt = performance.now();
  const MAX_MS = opts.continuous ? 5 * 60_000 : 90_000;

  const release = () => {
    stopLoop?.();
    meter?.close();
    stream.getTracks().forEach((t) => t.stop());
  };

  try {
    meter = new LevelMeter(stream);
    stopLoop = levelLoop(meter, (level) => {
      opts.onLevel?.(level);
      const now = performance.now();
      if (level > SPEECH_THRESHOLD) {
        heardSpeech = true;
        lastLoud = now;
      }
      if (recorder.state !== "recording") return;
      if (opts.silenceMs && heardSpeech && now - lastLoud > opts.silenceMs) recorder.stop();
      else if (now - startedAt > MAX_MS) recorder.stop();
    });
  } catch {
    heardSpeech = true; // no metering available — always transcribe
  }

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    release();
    if (cancelled) return;
    if (!heardSpeech || chunks.length === 0) {
      opts.onFinal("");
      return;
    }
    opts.onPhase?.("transcribing");
    try {
      const blob = new Blob(chunks, { type: mime || chunks[0]?.type || "audio/webm" });
      const text = await transcribe(blob, ext, opts.settings?.language);
      opts.onFinal(text.trim());
    } catch (e) {
      opts.onError(e instanceof Error ? e : new Error(String(e)));
    }
  };

  recorder.start(250);
  opts.onPhase?.("listening");

  return {
    stop: () => {
      if (recorder.state === "recording") recorder.stop();
    },
    cancel: () => {
      cancelled = true;
      if (recorder.state === "recording") recorder.stop();
      else release();
    },
  };
}

/** Send recorded audio to the core for transcription (keeps the real container extension). */
export async function transcribe(blob: Blob, ext = "webm", language?: string): Promise<string> {
  const form = new FormData();
  form.set("audio", blob, `speech.${ext}`);
  if (language) form.set("language", language);
  const res = await request<{ text: string }>("POST", "/api/voice/transcribe", form);
  return res.text ?? "";
}

/* ------------------------------------------------------------------ */
/* Text to speech                                                       */
/* ------------------------------------------------------------------ */

interface ActiveSpeech {
  key: string;
  stop: () => void;
}

let active: ActiveSpeech | null = null;

function setSpeakingKey(key: string | null) {
  useVoiceSession.setState({ speakingKey: key });
}

export function stopSpeaking() {
  const a = active;
  active = null;
  a?.stop();
  setSpeakingKey(null);
}

export interface SpeakOptions {
  /** Identifies what is being spoken (message id…) so buttons can reflect it. */
  key?: string;
  /** 0…1 output level for visuals (synthetic for browser voices). */
  onLevel?: (level: number) => void;
}

function waitForVoices(timeout = 1200): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", done);
    setTimeout(done, timeout);
  });
}

function speakBrowser(text: string, settings: VoiceSettings | undefined, opts: SpeakOptions): { done: Promise<void>; stop: () => void } {
  const synth = window.speechSynthesis;
  let stopped = false;
  let raf = 0;
  let boost = 0;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    opts.onLevel?.(0);
    synth.cancel();
  };
  const done = (async () => {
    synth.cancel();
    const voices = await waitForVoices();
    if (stopped) return;
    const lang = settings?.language || navigator.language;
    const voice =
      voices.find((v) => v.name === settings?.browserVoice) ??
      voices.find((v) => v.lang === lang && v.localService) ??
      voices.find((v) => v.lang.startsWith(lang.split("-")[0])) ??
      null;
    if (opts.onLevel) {
      const t0 = performance.now();
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        boost *= 0.9;
        const level = synth.speaking ? 0.28 + 0.14 * Math.sin(t * 11) + 0.1 * Math.sin(t * 17.3) + boost : 0;
        opts.onLevel?.(Math.max(0, Math.min(1, level)));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    for (const chunk of chunkText(text)) {
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) u.voice = voice;
        u.lang = voice?.lang ?? lang;
        u.rate = settings?.rate && settings.rate > 0 ? settings.rate : 1;
        u.onboundary = () => {
          boost = 0.35;
        };
        u.onend = () => resolve();
        u.onerror = () => resolve();
        synth.speak(u);
      });
    }
    cancelAnimationFrame(raf);
    opts.onLevel?.(0);
  })();
  return { done, stop };
}

function speakServer(text: string, opts: SpeakOptions): { done: Promise<void>; stop: () => void } {
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  let meter: LevelMeter | null = null;
  let raf = 0;
  let stopped = false;
  let resolveDone: () => void = () => {};
  const cleanup = () => {
    cancelAnimationFrame(raf);
    opts.onLevel?.(0);
    meter?.close();
    meter = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const stop = () => {
    stopped = true;
    audio?.pause();
    cleanup();
    resolveDone();
  };
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    api.voice
      .speak(text)
      .then(async (blob) => {
        if (stopped) return resolve();
        if (!(blob instanceof Blob) || blob.size === 0 || (blob.type && !blob.type.startsWith("audio/") && blob.type !== "application/octet-stream")) {
          throw new Error("The voice service returned no audio.");
        }
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.onended = () => {
          cleanup();
          resolve();
        };
        audio.onerror = () => {
          cleanup();
          reject(new Error("Could not play the reply audio."));
        };
        if (opts.onLevel) {
          try {
            meter = new LevelMeter(audio);
            const m = meter;
            const tick = () => {
              opts.onLevel?.(m.read());
              raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);
          } catch {
            /* visuals only */
          }
        }
        await audio.play();
      })
      .catch((e) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
  return { done, stop };
}

/**
 * Speak text with the configured provider. Stops anything currently speaking.
 * Resolves when playback finished or was stopped. Falls back to the browser voice when the core TTS fails.
 */
export async function speak(text: string, settings: VoiceSettings | undefined, opts: SpeakOptions = {}): Promise<void> {
  const clean = stripMarkdown(text);
  stopSpeaking();
  if (!clean) return;
  const key = opts.key ?? "speech";
  const provider = settings?.ttsProvider ?? "browser";

  const run = (impl: { done: Promise<void>; stop: () => void }) => {
    const me: ActiveSpeech = { key, stop: impl.stop };
    active = me;
    setSpeakingKey(key);
    return impl.done.finally(() => {
      if (active === me) {
        active = null;
        setSpeakingKey(null);
      }
    });
  };

  if (provider === "browser") {
    if (!canSpeakInBrowser()) throw new Error("Speech synthesis isn't available here.");
    return run(speakBrowser(clean, settings, opts));
  }
  try {
    await run(speakServer(clean, opts));
  } catch (e) {
    if (!canSpeakInBrowser()) throw e;
    await run(speakBrowser(clean, settings, opts));
  }
}
