import type { Hono } from "hono";
import { body, z } from "../validate";
import { MAX_AUDIO_BYTES, speak, transcribe } from "../../voice/voice";
import { badRequest, HttpError } from "../../util";

const speakSchema = z.object({ text: z.string() });

export function registerVoiceRoutes(app: Hono): void {
  app.post("/api/voice/transcribe", async (c) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_AUDIO_BYTES + 1024 * 1024) throw new HttpError(413, "Recordings are limited to 25 MB", "too_large");
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw badRequest("Upload the recording as multipart/form-data with an `audio` field");
    }
    const audio = form.get("audio");
    if (!(audio instanceof Blob)) throw badRequest("Missing `audio` recording");
    const language = form.get("language");
    return c.json(
      await transcribe(audio, {
        language: typeof language === "string" ? language : null,
        filename: audio instanceof File ? audio.name : null,
      }),
    );
  });

  app.post("/api/voice/speak", async (c) => {
    const { text } = await body(c, speakSchema);
    const audio = await speak(text);
    return new Response(audio.stream, { headers: { "content-type": audio.contentType, "cache-control": "no-store" } });
  });
}
