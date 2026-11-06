import { useQuery } from "@tanstack/react-query";
import { requireOptionalNativeModule } from "expo";
import { getLocales } from "expo-localization";
import type { ExpoSpeechRecognitionErrorCode, ExpoSpeechRecognitionModule, ExpoSpeechRecognitionOptions } from "expo-speech-recognition";
import { useState } from "react";
import type { DictationStatus, SttProvider } from "@godmode/shared";
import { ApiError, api } from "./api";
import { qk, queryClient } from "./query";

/** The phone's own speech recognition (Speech on iOS, SpeechRecognizer on Android); null in a build without it. */
const speech = requireOptionalNativeModule<typeof ExpoSpeechRecognitionModule>("ExpoSpeechRecognition");

/** Who writes down what was said: the computer (the phone records and uploads) or the phone itself. */
export type DictationEngine = "computer" | "phone";

/** What the phone records for the computer: 16 kHz WAV on iOS, AAC on Android (it has no WAV encoder). */
export const RECORDING_FORMAT = process.env.EXPO_OS === "android" ? "m4a" : "wav";

export function phoneCanDictate(): boolean {
  try {
    return !!speech?.isRecognitionAvailable();
  } catch {
    return false;
  }
}

async function dictationStatus(provider: SttProvider): Promise<DictationStatus> {
  try {
    return await api.voice.dictation();
  } catch (err) {
    if (!(err instanceof ApiError && err.status >= 400 && err.status < 500)) throw err;
    // An older Godmode doesn't answer this but takes recordings with Hex or OpenAI; when it can't after all, the
    // phone writes the recording down itself.
    return { provider, ready: provider !== "browser", formats: provider === "hex" ? ["wav"] : ["wav", "m4a"] };
  }
}

/** The computer when it writes this phone's recordings down, else the phone; null when neither can. */
export function chooseEngine(status: DictationStatus | null | undefined, onPhone: boolean): DictationEngine | null {
  const computer = !!status?.ready && status.formats.includes(RECORDING_FORMAT);
  // "browser" means the device's own speech recognition: on the phone that is the phone's.
  if (computer && (status.provider !== "browser" || !onPhone)) return "computer";
  return onPhone ? "phone" : null;
}

export function useDictation(provider: SttProvider | undefined): DictationEngine | null {
  const [onPhone] = useState(phoneCanDictate);
  const status = useQuery({ queryKey: qk.dictation(provider ?? ""), queryFn: () => dictationStatus(provider!), enabled: !!provider, staleTime: 60_000 });
  return chooseEngine(status.data, onPhone);
}

/** Asks the computer again before the next dictation (after it failed to write one down). */
export function refreshDictation() {
  void queryClient.invalidateQueries({ queryKey: qk.dictation("").slice(0, 2) });
}

export function askToListen() {
  if (!speech) return Promise.resolve({ granted: false, canAskAgain: false });
  return speech.requestPermissionsAsync();
}

const norm = (tag: string) => tag.replace(/_/g, "-").toLowerCase();
/** The region a language means without one, where it isn't the language's own code (de-DE, fr-FR). */
const HOME_REGION: Record<string, string> = { en: "us", pt: "br", ja: "jp", zh: "cn", ko: "kr", sv: "se", da: "dk", cs: "cz", el: "gr", uk: "ua" };
/** Listing the recognizer's languages waits on a system service on Android; it never takes this long. */
const LOCALES_WAIT_MS = 2_000;

async function supportedLocales(): Promise<string[]> {
  if (!speech) return [];
  try {
    const listed = speech.getSupportedLocales({}).then((r) => r.locales);
    return await Promise.race([listed, new Promise<string[]>((resolve) => setTimeout(() => resolve([]), LOCALES_WAIT_MS))]);
  } catch {
    // Android 12 and older can't list them; the recognizer takes the tag as it is.
    return [];
  }
}

/** The recognizer's locale for `tag` (the Voice language), else for the phone's own languages. */
export async function speechLocale(tag: string): Promise<string> {
  const phone = getLocales().map((l) => l.languageTag);
  const wanted = [tag, ...phone].filter(Boolean);
  const supported = await supportedLocales();
  if (!supported.length) return wanted[0] ?? "en-US";
  const find = (want: string) => supported.find((s) => norm(s) === norm(want));
  for (const want of wanted) {
    const language = norm(want).split("-")[0]!;
    const region = getLocales()[0]?.regionCode?.toLowerCase();
    const match =
      find(want) ??
      (region ? find(`${language}-${region}`) : undefined) ??
      phone.filter((p) => norm(p).split("-")[0] === language).map(find).find(Boolean) ??
      find(`${language}-${HOME_REGION[language] ?? language}`) ??
      supported.find((s) => norm(s).split("-")[0] === language);
    if (match) return match;
  }
  return supported[0]!;
}

export interface Heard {
  text: string;
  /** Why nothing was written down, when the recognizer said. */
  error?: { code: ExpoSpeechRecognitionErrorCode; message: string };
}

/** After `stop` the last words come within a moment; this long at most. */
const END_WAIT_MS = 8_000;
/** How long a dictation waits for the one before to let go of the recognizer. */
const SETTLE_MS = 1_500;
/** Recordings longer than this are past what Apple's recognizer takes from a file in one go. */
export const FILE_MAX_MS = 55_000;
const FILE_WAIT_MS = 60_000;

/** Ends when the recognizer let go of the last dictation: one runs at a time, each hears only its own events. */
let settled: Promise<void> = Promise.resolve();
/** Drops the dictation that runs now (a new one takes the recognizer). */
let current: (() => void) | null = null;

function recognize(options: ExpoSpeechRecognitionOptions, onEnd: (heard: Heard) => void, onLevel?: (level: number) => void) {
  const native = speech;
  if (!native) {
    onEnd({ text: "", error: { code: "service-not-allowed", message: "Speech recognition isn't available" } });
    return { stop: () => undefined, abort: () => undefined };
  }
  const said: string[] = [];
  let interim = "";
  let error: Heard["error"];
  /** Over for the caller. */
  let done = false;
  /** Asked the recognizer to start / it started / the caller dropped it. */
  let asked = false;
  let started = false;
  let dropped = false;
  let late: ReturnType<typeof setTimeout> | undefined;
  const subscriptions: { remove: () => void }[] = [];
  let release = () => {};

  const finish = () => {
    if (done) return;
    done = true;
    if (current === drop) current = null;
    clearTimeout(late);
    const text = [...said, interim].filter(Boolean).join(" ");
    onEnd({ text, error: text ? undefined : error });
  };
  const detach = () => {
    for (const s of subscriptions.splice(0)) s.remove();
    release();
  };
  // Starting runs on its own on the native side: a stop or abort that gets there first stops nothing, so the start
  // that comes after is aborted when it arrives.
  const drop = () => {
    if (dropped) return;
    dropped = true;
    if (asked) {
      native.abort();
      if (!started) setTimeout(detach, SETTLE_MS * 2);
    } else release();
    finish();
  };
  current?.();
  current = drop;
  const previous = settled;
  settled = new Promise((resolve) => (release = resolve));

  void Promise.race([previous, new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]).then(() => {
    if (dropped) return;
    subscriptions.push(
      native.addListener("start", () => {
        started = true;
        if (dropped) native.abort();
      }),
      native.addListener("result", (e) => {
        const text = e.results[0]?.transcript.trim() ?? "";
        if (!e.isFinal) interim = text;
        else {
          // Each final result is a new utterance; iOS may repeat the last one when it stops.
          if (text && text !== said[said.length - 1]) said.push(text);
          interim = "";
        }
      }),
      native.addListener("error", (e) => {
        error ??= { code: e.error, message: e.message };
      }),
      native.addListener("end", () => {
        if (dropped && !started) return;
        detach();
        finish();
      }),
    );
    if (onLevel) subscriptions.push(native.addListener("volumechange", (e) => onLevel(Math.max(0, Math.min(1, e.value / 10)))));
    asked = true;
    try {
      native.start({ interimResults: true, continuous: true, addsPunctuation: true, ...options });
    } catch (err) {
      error = { code: "audio-capture", message: err instanceof Error ? err.message : String(err) };
      detach();
      finish();
    }
  });

  return {
    stop: () => {
      if (done) return;
      if (!started) return drop();
      native.stop();
      late = setTimeout(() => {
        native.abort();
        finish();
        setTimeout(detach, SETTLE_MS);
      }, END_WAIT_MS);
    },
    abort: drop,
  };
}

export type Listening = ReturnType<typeof recognize>;

/**
 * Dictation on the phone itself: listens until `stop` (or until the recognizer ends by itself, e.g. after a long
 * silence), `onLevel` hears the loudness (0..1) ten times a second and `onEnd` gets what was said.
 */
export function listen(lang: string, handlers: { onLevel: (level: number) => void; onEnd: (heard: Heard) => void }): Listening {
  return recognize({ lang, volumeChangeEventOptions: { enabled: true, intervalMillis: 100 } }, handlers.onEnd, handlers.onLevel);
}

/** What a recording of up to `FILE_MAX_MS` says, written down on the phone (iOS, `tag` the Voice language); "" when it can't. */
export async function recognizeFile(uri: string, tag: string): Promise<string> {
  if (process.env.EXPO_OS !== "ios" || !phoneCanDictate()) return "";
  const lang = await speechLocale(tag);
  return new Promise((resolve) => {
    let late = false;
    const file = recognize({ lang, audioSource: { uri } }, (heard) => {
      clearTimeout(limit);
      // Cut off it would read as all that was said.
      resolve(late ? "" : heard.text);
    });
    const limit = setTimeout(() => {
      late = true;
      file.abort();
    }, FILE_WAIT_MS);
  });
}
