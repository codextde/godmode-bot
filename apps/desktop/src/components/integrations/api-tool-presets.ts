import type { LucideIcon } from "lucide-react";
import { AudioLines, Banana, Layers, Search, Sparkles, Wrench } from "lucide-react";
import type { ApiToolAuth } from "@godmode/shared";

export interface ApiToolPreset {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: LucideIcon;
  baseUrl: string;
  auth: ApiToolAuth;
  testPath: string;
  envVar: string;
  docsUrl: string;
  keyUrl: { href: string; label: string };
  keyPlaceholder: string;
  docs: string;
}

export const BEARER: ApiToolAuth = { in: "header", name: "Authorization", prefix: "Bearer " };

export const API_TOOL_PRESETS: ApiToolPreset[] = [
  {
    id: "gemini",
    name: "Nano Banana",
    tagline: "Images with Google Gemini",
    description: "Generate and edit images with Nano Banana (Google's Gemini image models): illustrations, product shots, photo edits, images with text.",
    icon: Banana,
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: { in: "header", name: "x-goog-api-key", prefix: "" },
    testPath: "/v1beta/models",
    envVar: "GEMINI_API_KEY",
    docsUrl: "https://ai.google.dev/gemini-api/docs/image-generation",
    keyUrl: { href: "https://aistudio.google.com/apikey", label: "aistudio.google.com" },
    keyPlaceholder: "AIza…",
    docs: `Generate and edit images with Google's Nano Banana models through the Gemini API.

## Models
- gemini-2.5-flash-image — Nano Banana: fast and cheap, good for most images and edits.
- gemini-3-pro-image-preview — Nano Banana Pro: best quality, sharp text in images, up to 4K.
If a model isn't found, list them with GET /v1beta/models and use the newest one with "image" in its name.

## Generate an image
POST /v1beta/models/gemini-2.5-flash-image:generateContent
{
  "contents": [{ "parts": [{ "text": "A watercolor fox reading a newspaper in a Berlin café, morning light" }] }],
  "generationConfig": { "responseModalities": ["IMAGE"], "imageConfig": { "aspectRatio": "16:9" } }
}
Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Nano Banana Pro also takes "imageSize": "1K" | "2K" | "4K" in imageConfig.
The image comes back as base64 in candidates[0].content.parts[].inlineData; Godmode saves it as a file.

## Edit or combine images
Send the pictures next to the instruction:
{ "contents": [{ "parts": [
  { "text": "Put this logo on the mug, keep everything else the same" },
  { "inlineData": { "mimeType": "image/png", "data": { "$file": "/path/to/logo.png" } } },
  { "inlineData": { "mimeType": "image/jpeg", "data": { "$file": "/path/to/mug.jpg" } } }
] }] }

## Tips
- Describe the scene in sentences (subject, style, lighting, composition, mood) rather than keyword lists.
- For text in an image, quote it exactly and prefer Nano Banana Pro.
- Use "responseModalities": ["TEXT", "IMAGE"] to also get a short description back.
- Generated images carry an invisible SynthID watermark.`,
  },
  {
    id: "openai",
    name: "OpenAI",
    tagline: "GPT Image, GPT, speech",
    description: "Images with GPT Image (generate and edit), plus OpenAI's GPT models for text and vision, text-to-speech and transcription.",
    icon: Sparkles,
    baseUrl: "https://api.openai.com",
    auth: BEARER,
    testPath: "/v1/models",
    envVar: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/docs/guides/image-generation",
    keyUrl: { href: "https://platform.openai.com/api-keys", label: "platform.openai.com" },
    keyPlaceholder: "sk-…",
    docs: `OpenAI's API: images (GPT Image), text and vision (GPT models), speech and transcription.
If a model below isn't available, list them with GET /v1/models and pick the newest of that family.

## Generate an image
POST /v1/images/generations
{ "model": "gpt-image-1", "prompt": "A flat illustration of a paper rocket", "size": "1024x1024", "quality": "high" }
Sizes: 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait), auto. Quality: low, medium, high, auto.
"background": "transparent" gives a PNG with transparency; "output_format": "png" | "jpeg" | "webp"; "n" for several images.
Images come back as base64 in data[].b64_json; Godmode saves them as files.

## Edit an image
POST /v1/images/edits as a multipart form:
form: { "model": "gpt-image-1", "prompt": "Add a red scarf", "image": { "$file": "/path/to/photo.png" } }
Add "mask" (a PNG whose transparent area marks what to change) to edit only part of it.

## Text and vision
POST /v1/responses
{ "model": "gpt-5", "input": "Summarize this in 3 bullets: …" }
The answer is in output[].content[].text.

## Speech
POST /v1/audio/speech { "model": "gpt-4o-mini-tts", "voice": "alloy", "input": "Hello!" } returns an MP3.
POST /v1/audio/transcriptions as a form: { "model": "gpt-4o-transcribe", "file": { "$file": "/path/to/audio.m4a" } }`,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    tagline: "Voices and sound effects",
    description: "Lifelike speech in many voices and languages, sound effects from a description, and speech-to-text.",
    icon: AudioLines,
    baseUrl: "https://api.elevenlabs.io",
    auth: { in: "header", name: "xi-api-key", prefix: "" },
    testPath: "/v1/models",
    envVar: "ELEVENLABS_API_KEY",
    docsUrl: "https://elevenlabs.io/docs/api-reference/introduction",
    keyUrl: { href: "https://elevenlabs.io/app/settings/api-keys", label: "elevenlabs.io" },
    keyPlaceholder: "sk_…",
    docs: `Lifelike speech, sound effects and transcription.

## Voices
GET /v1/voices lists voices (voices[].voice_id, name, labels).

## Text to speech
POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
{ "text": "Welcome to the show.", "model_id": "eleven_multilingual_v2" }
Returns an MP3; Godmode saves it. "eleven_flash_v2_5" is fastest, "eleven_v3" the most expressive.

## Sound effects
POST /v1/sound-generation { "text": "Rain on a tin roof, distant thunder", "duration_seconds": 8 }

## Speech to text
POST /v1/speech-to-text as a form: { "model_id": "scribe_v1", "file": { "$file": "/path/to/audio.mp3" } }`,
  },
  {
    id: "replicate",
    name: "Replicate",
    tagline: "Thousands of open models",
    description: "Run open models for images (FLUX), video, audio, upscaling and background removal.",
    icon: Layers,
    baseUrl: "https://api.replicate.com",
    auth: BEARER,
    testPath: "/v1/account",
    envVar: "REPLICATE_API_TOKEN",
    docsUrl: "https://replicate.com/docs/reference/http",
    keyUrl: { href: "https://replicate.com/account/api-tokens", label: "replicate.com" },
    keyPlaceholder: "r8_…",
    docs: `Run open models: images (FLUX, SDXL), video, audio, upscaling, background removal.

## Run a model and wait for it
POST /v1/models/{owner}/{name}/predictions with the header "Prefer": "wait"
{ "input": { "prompt": "a cinematic photo of a lighthouse at dawn", "aspect_ratio": "16:9" } }
e.g. black-forest-labs/flux-schnell (fast) or black-forest-labs/flux-1.1-pro (quality).
The result is in "output", usually URLs on replicate.delivery. Download them without the key (curl -L -o file <url>); they expire after an hour.
If "status" is still "starting" or "processing", poll GET /v1/predictions/{id} until "succeeded" or "failed".

## Find models and their inputs
GET /v1/models/{owner}/{name} shows a model's input schema (latest_version.openapi_schema). Browse replicate.com/explore.
Files as input: a public URL, or { "$file": "/path/to/image.png", "as": "dataUrl" } in the input field.`,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    tagline: "Web search with sources",
    description: "Up-to-date answers from the web with cited sources — research, news, fact checks.",
    icon: Search,
    baseUrl: "https://api.perplexity.ai",
    auth: BEARER,
    testPath: "",
    envVar: "PERPLEXITY_API_KEY",
    docsUrl: "https://docs.perplexity.ai",
    keyUrl: { href: "https://www.perplexity.ai/account/api/keys", label: "perplexity.ai" },
    keyPlaceholder: "pplx-…",
    docs: `Search the web and get answers with sources.

## Ask
POST /chat/completions
{ "model": "sonar", "messages": [{ "role": "user", "content": "What changed in the EU AI Act this month?" }] }
The answer is in choices[0].message.content, the sources in search_results (and citations).

## Models
sonar (fast), sonar-pro (deeper), sonar-reasoning-pro (multi-step), sonar-deep-research (long reports, slow — pass timeoutSeconds: 600).

## Options
"search_recency_filter": "day" | "week" | "month", "search_domain_filter": ["example.com"] (prefix a domain with - to exclude it).`,
  },
];

export const CUSTOM_ICON = Wrench;

export function presetById(id: string | null | undefined): ApiToolPreset | undefined {
  return id ? API_TOOL_PRESETS.find((p) => p.id === id) : undefined;
}

export function toolIcon(preset: string | null | undefined): LucideIcon {
  return presetById(preset)?.icon ?? CUSTOM_ICON;
}

/** `Nano Banana` → `NANO_BANANA_API_KEY` */
export function suggestEnvVar(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!base) return "API_KEY";
  const safe = /^[0-9]/.test(base) ? `_${base}` : base;
  return /(_KEY|_TOKEN)$/.test(safe) ? safe : `${safe}_API_KEY`;
}

export const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
