import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AudioLines, KeyRound, Languages, Mic, Play, Square, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["settings", "common"]);
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
        toast.error(t("voice.noSynthesis"));
        return;
      }
      const u = new SpeechSynthesisUtterance(t("voice.sample"));
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
      const blob = await api.voice.speak(t("voice.sample"));
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
      toastApiError(e, t("voice.testFailed"), qc);
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeading title={t("voice.title")} description={t("voice.description")} />

      <SettingsGroup
        title={t("voice.mode.title")}
        icon={<AudioLines />}
        actions={
          <Button size="sm" variant={playing ? "secondary" : "outline"} onClick={testVoice} disabled={playing === "loading"}>
            {playing === "loading" ? <Spinner /> : playing ? <Square /> : <Play />}
            {playing ? t("common:actions.stop") : t("voice.mode.test")}
          </Button>
        }
      >
        <SettingRow label={t("voice.mode.enable")} htmlFor="voice-enabled" description={t("voice.mode.enableDescription")}>
          <Switch id="voice-enabled" checked={v.enabled} onCheckedChange={(enabled) => patch({ voice: { enabled } })} />
        </SettingRow>
        <SettingRow label={t("voice.mode.autoSpeak")} htmlFor="auto-speak" description={t("voice.mode.autoSpeakDescription")}>
          <Switch id="auto-speak" checked={v.autoSpeak} onCheckedChange={(autoSpeak) => patch({ voice: { autoSpeak } })} />
        </SettingRow>
        <SettingRow label={t("voice.mode.language")} htmlFor="voice-lang" description={t("voice.mode.languageDescription")} stacked>
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

      <SettingsGroup title={t("voice.stt.title")} icon={<Mic />}>
        <SettingRow
          label={t("voice.provider")}
          description={v.sttProvider === "browser" ? t("voice.stt.browserDescription") : t("voice.stt.openaiDescription")}
        >
          <Segmented<SttProvider>
            aria-label={t("voice.stt.providerLabel")}
            value={v.sttProvider}
            onChange={(sttProvider) => patch({ voice: { sttProvider } })}
            options={[
              { value: "browser", label: t("voice.browser") },
              { value: "openai", label: "OpenAI" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("voice.tts.title")} icon={<Volume2 />}>
        <SettingRow label={t("voice.provider")} description={t("voice.tts.description")}>
          <Segmented<TtsProvider>
            aria-label={t("voice.tts.providerLabel")}
            value={v.ttsProvider}
            onChange={(ttsProvider) => patch({ voice: { ttsProvider } })}
            options={[
              { value: "browser", label: t("voice.browser") },
              { value: "openai", label: "OpenAI" },
              { value: "elevenlabs", label: "ElevenLabs" },
            ]}
          />
        </SettingRow>

        {v.ttsProvider === "browser" && (
          <>
            <SettingRow label={t("voice.tts.voice")} htmlFor="browser-voice" description={voices.length ? t("voice.tts.voicesAvailable", { count: voices.length }) : t("voice.tts.noVoices")}>
              <Select value={v.browserVoice || DEFAULT_VOICE} onValueChange={(x) => patch({ voice: { browserVoice: x === DEFAULT_VOICE ? "" : x } })}>
                <SelectTrigger id="browser-voice" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={DEFAULT_VOICE}>{t("voice.tts.systemDefault")}</SelectItem>
                  {matching.length > 0 && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>{v.language ? t("voice.tts.matching", { language: v.language }) : t("voice.tts.matchingLanguage")}</SelectLabel>
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
                        <SelectLabel>{t("voice.tts.otherLanguages")}</SelectLabel>
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
            <SettingRow label={t("voice.tts.rate")} description={t("voice.tts.rateDescription")}>
              <div className="flex w-64 items-center gap-3">
                <Slider
                  aria-label={t("voice.tts.rate")}
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
          <SettingRow label={t("voice.tts.elevenlabsVoice")} htmlFor="el-voice" description={t("voice.tts.elevenlabsVoiceDescription")}>
            <CommitInput
              id="el-voice"
              className="w-64 font-mono text-[13px]"
              placeholder={t("voice.tts.elevenlabsPlaceholder")}
              value={v.elevenlabsVoiceId}
              onCommit={(elevenlabsVoiceId) => patch({ voice: { elevenlabsVoiceId: elevenlabsVoiceId.trim() } })}
            />
          </SettingRow>
        )}
      </SettingsGroup>

      {usesOpenAi && (
        <SettingsGroup title="OpenAI" icon={<Languages />} description={t("voice.openai.description")}>
          <SettingRow label={t("voice.openai.baseUrl")} htmlFor="oai-base">
            <CommitInput
              id="oai-base"
              className="w-72 font-mono text-[13px]"
              placeholder="https://api.openai.com/v1"
              value={v.openaiBaseUrl}
              onCommit={(openaiBaseUrl) => patch({ voice: { openaiBaseUrl: openaiBaseUrl.trim() } })}
            />
          </SettingRow>
          {v.sttProvider === "openai" && (
            <SettingRow label={t("voice.openai.sttModel")} htmlFor="oai-stt">
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
              <SettingRow label={t("voice.openai.ttsModel")} htmlFor="oai-tts">
                <CommitInput
                  id="oai-tts"
                  className="w-56 font-mono text-[13px]"
                  placeholder="gpt-4o-mini-tts"
                  value={v.ttsModel}
                  onCommit={(ttsModel) => patch({ voice: { ttsModel: ttsModel.trim() } })}
                />
              </SettingRow>
              <SettingRow label={t("voice.tts.voice")} htmlFor="oai-voice">
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
        <Callout tone="info" icon={<KeyRound className="text-brand-strong" />} title={t("voice.keys.title")}>
          <Trans
            t={t}
            i18nKey="voice.keys.body"
            values={{ providers: usesOpenAi && v.ttsProvider === "elevenlabs" ? t("voice.keys.both") : usesOpenAi ? "OpenAI" : "ElevenLabs" }}
            components={{ link: <Link to="/settings/api-keys" className="font-medium text-primary underline-offset-2 hover:underline" /> }}
          />
        </Callout>
      )}
    </div>
  );
}
