import { requireOptionalNativeModule } from "expo";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { create } from "zustand";
import type { Message, VoiceSettings } from "@godmode/shared";
import { ApiError, pictureBases } from "./api";
import { currentLanguage, t } from "./i18n";
import { useSession } from "./session";

/** The computer's voices stop at this many characters. */
const MAX_SPEAK_CHARS = 4000;

/** Plain words for a voice: no Markdown signs, code or links' addresses. */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_`>|~]/g, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** What the agent asks, said out loud: the question and its suggested answers, or the step it wants an OK for. */
function spokenQuestion(m: Message): string {
  const q = [...m.blocks].reverse().find((b) => b.type === "question");
  if (!q || q.type !== "question" || q.status !== "open") return "";
  if (q.kind === "approval") return t("chat:voiceMode.approval", { action: q.title.replace(/^[A-Z]/, (c) => c.toLowerCase()) });
  const options = q.options.map((o, i) => t("chat:voiceMode.option", { n: i + 1, label: o.label })).join(" ");
  return `${q.title}${options ? ` ${options}` : ""}`;
}

/** What an assistant message says, for reading it out (and showing it while that happens). */
export function replyText(m: Message): string {
  const asked = spokenQuestion(m);
  if (m.content.trim()) return asked ? `${m.content}\n\n${asked}` : m.content;
  const text = m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
  if (text.trim() || asked) return [text.trim(), asked].filter(Boolean).join("\n\n");
  if (m.blocks.some((b) => b.type === "error")) return t("chat:voiceMode.errorReply");
  return "";
}

/** One reply per stretch of a message: a run that asks and goes on writes into the same message; both parts are spoken. */
export function replyKey(m: Message): string {
  const open = m.blocks.some((b) => b.type === "question" && b.status === "open");
  return `${m.id}:${m.blocks.filter((b) => b.type === "pause").length}:${open ? "asking" : "done"}`;
}

async function fetchSpeech(text: string): Promise<ArrayBuffer> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  let last: unknown = null;
  for (const base of pictureBases(connection)) {
    try {
      const res = await fetch(`${base}/api/voice/speak`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, MAX_SPEAK_CHARS) }),
      });
      if (!res.ok) throw new ApiError(res.status, t("chat:voiceMode.playFailed"));
      return await res.arrayBuffer();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      last = err;
    }
  }
  throw last instanceof Error ? last : new ApiError(0, t("system:api.offline"), "offline");
}

export interface Speech {
  done: Promise<void>;
  stop: () => void;
}

/** The audio comes from the computer and plays on the phone. */
function speakFromComputer(text: string): Speech {
  let player: AudioPlayer | null = null;
  let file: File | null = null;
  let stopped = false;
  let finish = () => {};
  const clean = () => {
    try {
      player?.remove();
    } catch {
      // Gone already.
    }
    player = null;
    try {
      if (file?.exists) file.delete();
    } catch {
      // The cache clears itself.
    }
  };
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    void (async () => {
      try {
        const audio = await fetchSpeech(text);
        if (stopped) return resolve();
        file = new File(Paths.cache, `voice-reply-${Date.now()}.mp3`);
        file.create({ overwrite: true });
        file.write(new Uint8Array(audio));
        await setAudioModeAsync({ playsInSilentMode: true });
        if (stopped) return resolve();
        const p = createAudioPlayer({ uri: file.uri });
        player = p;
        p.addListener("playbackStatusUpdate", (status) => {
          if (status.didJustFinish) resolve();
        });
        p.play();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }).finally(clean);
  return {
    done,
    stop: () => {
      stopped = true;
      try {
        player?.pause();
      } catch {
        // Nothing plays.
      }
      finish();
    },
  };
}

/** The phone's own voices; null in a build without them. */
const phoneSpeech = () => (requireOptionalNativeModule("ExpoSpeech") ? import("expo-speech") : Promise.resolve(null));

const tagOf = (language: string) => language.toLowerCase().replace("_", "-");

/** The phone's voice for `tag` (the language of the chat, else of the app): that one exactly or the same language, the better sounding first. */
async function phoneVoice(speech: NonNullable<Awaited<ReturnType<typeof phoneSpeech>>>, tag: string): Promise<{ language: string; voice?: string }> {
  const language = tag.trim() || currentLanguage();
  const voices = await speech.getAvailableVoicesAsync().catch(() => []);
  const wanted = tagOf(language);
  const exact = voices.filter((v) => tagOf(v.language) === wanted);
  const near = exact.length ? exact : voices.filter((v) => tagOf(v.language).split("-")[0] === wanted.split("-")[0]);
  const best = near.find((v) => v.quality === speech.VoiceQuality.Enhanced) ?? near[0];
  return best ? { language: best.language, voice: best.identifier } : { language };
}

/** Android takes a few thousand characters at a time: cut at line ends where it can. */
function inParts(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const end = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Reads `text` out with a voice of the phone, in the language and speed set in Settings → Voice. */
function speakOnPhone(text: string, voice: VoiceSettings | undefined): Speech {
  let stopped = false;
  let halt = () => {};
  let finish = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    void (async () => {
      try {
        const speech = await phoneSpeech();
        if (!speech) throw new Error(t("chat:voiceMode.playFailed"));
        const chosen = await phoneVoice(speech, voice?.language ?? "");
        await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
        if (stopped) return resolve();
        halt = () => void speech.stop();
        const parts = inParts(text, speech.maxSpeechInputLength);
        if (!parts.length) return resolve();
        parts.forEach((part, i) =>
          speech.speak(part, {
            ...chosen,
            rate: voice?.rate && voice.rate > 0 ? voice.rate : 1,
            onStopped: resolve,
            onError: (err) => reject(err instanceof Error ? err : new Error(String(err))),
            ...(i === parts.length - 1 ? { onDone: resolve } : {}),
          }),
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
  return {
    done,
    stop: () => {
      stopped = true;
      halt();
      finish();
    },
  };
}

/** Reads `text` out the way Settings → Voice says; a computer voice that fails gives way to the phone's, like the desktop. */
export function speak(text: string, voice: VoiceSettings | undefined): Speech {
  if (!voice || voice.ttsProvider === "browser") return speakOnPhone(text, voice);
  const computer = speakFromComputer(text);
  let phone: Speech | null = null;
  let stopped = false;
  return {
    done: computer.done.catch(() => {
      if (stopped) return;
      phone = speakOnPhone(text, voice);
      return phone.done;
    }),
    stop: () => {
      stopped = true;
      computer.stop();
      phone?.stop();
    },
  };
}

/** The reply being read aloud right now (one at a time), so its button can say so. */
export const useReadAloud = create<{ key: string | null }>(() => ({ key: null }));

let reading: { speech: Speech } | null = null;

export function stopReading() {
  reading?.speech.stop();
  reading = null;
  useReadAloud.setState({ key: null });
}

/** Reads a reply out on its own, outside voice mode. */
export function readAloud(text: string, voice: VoiceSettings | undefined, key: string): Promise<void> {
  stopReading();
  const words = forSpeech(text);
  if (!words) return Promise.resolve();
  const me = { speech: speak(words, voice) };
  reading = me;
  useReadAloud.setState({ key });
  return me.speech.done.finally(() => {
    if (reading !== me) return;
    reading = null;
    useReadAloud.setState({ key: null });
  });
}
