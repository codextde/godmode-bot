import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AudioLines, KeyRound, Languages, Mic, Play, Square, Volume2 } from "lucide-react";
import { toast } from "sonner";
import type { Settings, SttProvider, TtsProvider } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toastApiError } from "@/components/vault/vault-utils";
import { useQueryClient } from "@tanstack/react-query";
import { Callout, CommitInput, Segmented, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const DEFAULT_VOICE = "__default__";
const LANG_SUGGESTIONS = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "pt-BR", "ja-JP"];
const SAMPLE = "Hi, I'm Godmode — your AI coworker. I'll take care of the busywork so you can focus on what matters.";

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

export function VoiceSection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const qc = useQueryClient();
  const v = settings.voice;
  const voices = useBrowserVoices();
  const [rate, setRate] = useState(v.rate);
  const [playing, setPlaying] = useState<"loading" | "playing" | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => setRate(v.rate), [v.rate]);
  useEffect(() => () => stop(), []);

  const lang = v.language.toLowerCase();
  const [matching, others] = useMemo(() => {
    const prefix = lang.split("-")[0];
    const m = voices.filter((x) => x.lang.toLowerCase().startsWith(prefix));
    return [m, voices.filter((x) => !m.includes(x))];
  }, [voices, lang]);

  const usesOpenAi = v.sttProvider === "openai" || v.ttsProvider === "openai";

  function stop() {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlaying(null);
  }

  const testVoice = async () => {
    if (playing) return stop();
    if (v.ttsProvider === "browser") {
      if (typeof speechSynthesis === "undefined") {
        toast.error("Speech synthesis is not available in this browser");
        return;
      }
      const u = new SpeechSynthesisUtterance(SAMPLE);
      const voice = voices.find((x) => x.name === v.browserVoice);
      if (voice) u.voice = voice;
      u.lang = v.language || voice?.lang || "en-US";
      u.rate = rate;
      u.onend = () => setPlaying(null);
      u.onerror = () => setPlaying(null);
      speechSynthesis.cancel();
      setPlaying("playing");
      speechSynthesis.speak(u);
      return;
    }
    setPlaying("loading");
    try {
      const blob = await api.voice.speak(SAMPLE);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(null);
      };
      setPlaying("playing");
      await audio.play();
    } catch (e) {
      setPlaying(null);
      toastApiError(e, "Voice test failed", qc);
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeading title="Voice" description="Talk to your agents and hear their answers — hands-free, like a call with a coworker." />

      <SettingsGroup
        title="Voice mode"
        icon={<AudioLines />}
        actions={
          <Button size="sm" variant={playing ? "secondary" : "outline"} onClick={testVoice} disabled={playing === "loading"}>
            {playing === "loading" ? <Spinner /> : playing ? <Square /> : <Play />}
            {playing ? "Stop" : "Test voice"}
          </Button>
        }
      >
        <SettingRow label="Enable voice" htmlFor="voice-enabled" description="Shows the microphone in chat and enables spoken replies.">
          <Switch id="voice-enabled" checked={v.enabled} onCheckedChange={(enabled) => patch({ voice: { enabled } })} />
        </SettingRow>
        <SettingRow label="Speak replies to voice messages" htmlFor="auto-speak" description="When you dictate a message, the answer is read aloud automatically.">
          <Switch id="auto-speak" checked={v.autoSpeak} onCheckedChange={(autoSpeak) => patch({ voice: { autoSpeak } })} />
        </SettingRow>
        <SettingRow label="Language" htmlFor="voice-lang" description="BCP-47 code used for speech recognition and synthesis." stacked>
          <div className="flex flex-wrap items-center gap-2">
            <CommitInput
              id="voice-lang"
              className="w-32 font-mono text-[13px]"
              placeholder="en-US"
              value={v.language}
              onCommit={(language) => patch({ voice: { language: language.trim() } })}
            />
            <div className="flex flex-wrap gap-1.5">
              {LANG_SUGGESTIONS.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => patch({ voice: { language: l } })}
                  className={cn(
                    "h-7 rounded-md border px-2.5 font-mono text-[11px] transition hover:border-foreground/25 hover:text-foreground",
                    v.language === l ? "border-foreground/40 bg-secondary text-foreground" : "bg-card text-muted-foreground",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Speech to text" icon={<Mic />}>
        <SettingRow
          label="Provider"
          description={v.sttProvider === "browser" ? "Free, uses your system's speech recognition." : "OpenAI Whisper-class transcription — more accurate, needs an OpenAI API key."}
        >
          <Segmented<SttProvider>
            aria-label="Speech to text provider"
            value={v.sttProvider}
            onChange={(sttProvider) => patch({ voice: { sttProvider } })}
            options={[
              { value: "browser", label: "Browser" },
              { value: "openai", label: "OpenAI" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Text to speech" icon={<Volume2 />}>
        <SettingRow label="Provider" description="Browser voices are free; OpenAI and ElevenLabs sound more natural.">
          <Segmented<TtsProvider>
            aria-label="Text to speech provider"
            value={v.ttsProvider}
            onChange={(ttsProvider) => patch({ voice: { ttsProvider } })}
            options={[
              { value: "browser", label: "Browser" },
              { value: "openai", label: "OpenAI" },
              { value: "elevenlabs", label: "ElevenLabs" },
            ]}
          />
        </SettingRow>

        {v.ttsProvider === "browser" && (
          <>
            <SettingRow label="Voice" htmlFor="browser-voice" description={voices.length ? `${voices.length} voices available on this device.` : "No system voices found yet."}>
              <Select value={v.browserVoice || DEFAULT_VOICE} onValueChange={(x) => patch({ voice: { browserVoice: x === DEFAULT_VOICE ? "" : x } })}>
                <SelectTrigger id="browser-voice" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={DEFAULT_VOICE}>System default</SelectItem>
                  {matching.length > 0 && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Matching {v.language || "language"}</SelectLabel>
                        {matching.map((x) => (
                          <SelectItem key={x.voiceURI} value={x.name}>
                            {x.name} <span className="text-xs text-muted-foreground">{x.lang}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                  {others.length > 0 && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Other languages</SelectLabel>
                        {others.map((x) => (
                          <SelectItem key={x.voiceURI} value={x.name}>
                            {x.name} <span className="text-xs text-muted-foreground">{x.lang}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="Speaking rate" description="1× is normal speed.">
              <div className="flex w-64 items-center gap-3">
                <Slider
                  aria-label="Speaking rate"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={[rate]}
                  onValueChange={([x]) => setRate(x)}
                  onValueCommit={([x]) => patch({ voice: { rate: Math.round(x * 100) / 100 } })}
                />
                <span className="w-12 text-right font-mono text-xs tabular-nums">{rate.toFixed(2)}×</span>
              </div>
            </SettingRow>
          </>
        )}

        {v.ttsProvider === "elevenlabs" && (
          <SettingRow label="ElevenLabs voice ID" htmlFor="el-voice" description="Copy it from the voice library at elevenlabs.io.">
            <CommitInput
              id="el-voice"
              className="w-64 font-mono text-[13px]"
              placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              value={v.elevenlabsVoiceId}
              onCommit={(elevenlabsVoiceId) => patch({ voice: { elevenlabsVoiceId: elevenlabsVoiceId.trim() } })}
            />
          </SettingRow>
        )}
      </SettingsGroup>

      {usesOpenAi && (
        <SettingsGroup title="OpenAI" icon={<Languages />} description="Any OpenAI-compatible endpoint works (e.g. a local server).">
          <SettingRow label="Base URL" htmlFor="oai-base">
            <CommitInput
              id="oai-base"
              className="w-72 font-mono text-[13px]"
              placeholder="https://api.openai.com/v1"
              value={v.openaiBaseUrl}
              onCommit={(openaiBaseUrl) => patch({ voice: { openaiBaseUrl: openaiBaseUrl.trim() } })}
            />
          </SettingRow>
          {v.sttProvider === "openai" && (
            <SettingRow label="Transcription model" htmlFor="oai-stt">
              <CommitInput
                id="oai-stt"
                className="w-56 font-mono text-[13px]"
                placeholder="gpt-4o-transcribe"
                value={v.sttModel}
                onCommit={(sttModel) => patch({ voice: { sttModel: sttModel.trim() } })}
              />
            </SettingRow>
          )}
          {v.ttsProvider === "openai" && (
            <>
              <SettingRow label="Speech model" htmlFor="oai-tts">
                <CommitInput
                  id="oai-tts"
                  className="w-56 font-mono text-[13px]"
                  placeholder="gpt-4o-mini-tts"
                  value={v.ttsModel}
                  onCommit={(ttsModel) => patch({ voice: { ttsModel: ttsModel.trim() } })}
                />
              </SettingRow>
              <SettingRow label="Voice" htmlFor="oai-voice">
                <CommitInput
                  id="oai-voice"
                  className="w-56 font-mono text-[13px]"
                  placeholder="alloy"
                  value={v.ttsVoice}
                  onCommit={(ttsVoice) => patch({ voice: { ttsVoice: ttsVoice.trim() } })}
                />
              </SettingRow>
            </>
          )}
        </SettingsGroup>
      )}

      {(usesOpenAi || v.ttsProvider === "elevenlabs") && (
        <Callout tone="info" icon={<KeyRound className="text-brand-strong" />} title="API keys live in the vault">
          Add your {[usesOpenAi && "OpenAI", v.ttsProvider === "elevenlabs" && "ElevenLabs"].filter(Boolean).join(" and ")} key under{" "}
          <Link to="/integrations?tab=api-keys" className="font-medium text-primary underline-offset-2 hover:underline">
            Integrations → API keys
          </Link>
          . Keys are encrypted and never shown again.
        </Callout>
      )}
    </div>
  );
}
