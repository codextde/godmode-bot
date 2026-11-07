import { File, Paths } from "expo-file-system";
import { ApiError, reachableBase } from "./api";
import { t } from "./i18n";
import { useSession } from "./session";

const SPEAK_MS = 60_000;

/** The previous sample, removed when the next one arrives. */
let last: File | null = null;

/**
 * Has the computer say `text` with the voice set up in Settings → Voice (OpenAI or ElevenLabs) and keeps the audio in
 * the phone's cache, ready for expo-audio. Fetched directly: the answer is audio, not JSON.
 */
export async function speakSample(text: string): Promise<File> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  const found = await reachableBase(connection);
  if (!found || found instanceof ApiError) throw found ?? new ApiError(0, t("system:api.offline"), "offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEAK_MS);
  try {
    const res = await fetch(`${found.base}/api/voice/speak`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", accept: "audio/*" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      throw new ApiError(res.status, body?.error ?? t("system:api.requestFailed", { status: res.status }), body?.code);
    }
    const type = res.headers.get("content-type") ?? "";
    const ext = type.includes("wav") ? "wav" : type.includes("ogg") ? "ogg" : "mp3";
    const file = new File(Paths.cache, `voice-test-${Date.now()}.${ext}`);
    file.create();
    await file.write(new Uint8Array(await res.arrayBuffer()));
    if (last?.exists) last.delete();
    last = file;
    return file;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, t("system:api.noAnswer"), "timeout");
  } finally {
    clearTimeout(timer);
  }
}
