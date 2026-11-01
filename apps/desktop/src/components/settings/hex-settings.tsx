import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatBytes, HEX_MODELS, type VoiceSettings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { toastApiError } from "@/components/vault/vault-utils";
import { Callout, CommitInput, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const HEX_URL = "https://anoma.ly/hex/";

export function HexSettings({ voice }: { voice: VoiceSettings }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["voice", "hex", voice.hexPath, voice.hexModel, voice.language],
    queryFn: api.voice.hex,
    refetchInterval: (q) => (q.state.data?.progress ? 1000 : false),
  });
  const prepare = useMutation({
    mutationFn: () => api.voice.prepareHex(voice.language),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["voice", "hex"] }),
    onError: (e) => toastApiError(e, t("voice.hex.downloadFailed"), qc),
  });

  const s = status.data;
  const progress = s?.progress;
  const percent = (progress?.phase === "downloading" || progress?.phase === "installing") && progress.totalBytes ? Math.round((progress.downloadedBytes / progress.totalBytes) * 100) : null;
  const installing = progress?.phase === "installing";
  const usable = !!s && (!!s.path || s.canInstall);
  const needsSetup = !!s && usable && !s.installed && !progress && !s.error;
  const autoKey = `${voice.hexModel}:${voice.language}:${voice.hexPath}`;
  const autoStarted = useRef<string | null>(null);
  const { mutate: startPrepare } = prepare;
  useEffect(() => {
    if (!needsSetup || autoStarted.current === autoKey) return;
    autoStarted.current = autoKey;
    startPrepare();
  }, [needsSetup, autoKey, startPrepare]);
  const language = voice.language.toLowerCase().startsWith("de") ? "de" : voice.language.toLowerCase().startsWith("en") ? "en" : null;

  return (
    <SettingsGroup
      title="Hex"
      icon={<Download />}
      description={t("voice.hex.description")}
      actions={
        <Button size="sm" variant="ghost" onClick={() => void status.refetch()} disabled={status.isFetching} aria-label={t("voice.hex.refresh")}>
          {status.isFetching ? <Spinner /> : <RefreshCw />}
        </Button>
      }
    >
      {status.isLoading ? (
        <SettingRow label={t("voice.hex.app")}>
          <Spinner />
        </SettingRow>
      ) : s && !s.path && s.canInstall ? (
        <SettingRow
          label={t("voice.hex.app")}
          description={installing ? t("voice.hex.phase.installing", { percent: percent ?? 0 }) : t("voice.hex.autoInstall", { size: s.appBytes ? formatBytes(s.appBytes) : "" })}
        >
          {installing ? (
            <Progress value={percent ?? undefined} className="w-40" />
          ) : (
            !progress && (
              <Button size="sm" onClick={() => prepare.mutate()} disabled={prepare.isPending}>
                {prepare.isPending ? <Spinner /> : <Download />}
                {t("voice.hex.installAction")}
              </Button>
            )
          )}
        </SettingRow>
      ) : !s?.path ? (
        voice.hexPath.trim() ? (
          <Callout tone="warning" title={t("voice.hex.notFoundTitle")}>
            {t("voice.hex.notFoundBody")}
          </Callout>
        ) : (
          <Callout tone="warning" title={t("voice.hex.missingTitle")}>
            {t("voice.hex.missingBody")}{" "}
            <a href={HEX_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
              anoma.ly/hex <ExternalLink className="size-3" />
            </a>
          </Callout>
        )
      ) : (
        <SettingRow label={t("voice.hex.app")} description={<span className="break-all font-mono text-[11px]">{s.path}</span>}>
          <span className="text-sm text-muted-foreground">{s.version ? t("voice.hex.version", { version: s.version }) : t("voice.hex.found")}</span>
        </SettingRow>
      )}

      {s?.error && !progress && (
        <Callout tone="danger" title={t("voice.hex.errorTitle")}>
          {s.error}
        </Callout>
      )}

      <SettingRow label={t("voice.hex.model")} htmlFor="hex-model" description={t("voice.hex.modelDescription")}>
        <Select value={voice.hexModel} onValueChange={(hexModel) => patch({ voice: { hexModel } })}>
          <SelectTrigger id="hex-model" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HEX_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} <span className="text-xs text-muted-foreground">{t("voice.hex.size", { size: formatBytes(m.sizeMb * 1024 * 1024) })}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {usable && (
        <SettingRow
          label={t("voice.hex.download")}
          description={
            installing
              ? t("voice.hex.afterInstall")
              : progress
              ? t(`voice.hex.phase.${progress.phase}`, { percent: percent ?? 0 })
              : s.installed
                ? t("voice.hex.ready")
                : t("voice.hex.notDownloaded", { size: formatBytes(s.downloadBytes ?? (HEX_MODELS.find((m) => m.id === voice.hexModel)?.sizeMb ?? 0) * 1024 * 1024) })
          }
        >
          {installing ? null : progress ? (
            <Progress value={percent ?? undefined} className="w-40" />
          ) : (
            !s.installed && (
              <Button size="sm" onClick={() => prepare.mutate()} disabled={prepare.isPending}>
                {prepare.isPending ? <Spinner /> : <Download />}
                {t("voice.hex.downloadAction")}
              </Button>
            )
          )}
        </SettingRow>
      )}

      {!language && (
        <Callout tone="muted" title={t("voice.hex.languageTitle")}>
          {t("voice.hex.languageBody", { language: voice.language })}
        </Callout>
      )}

      <SettingRow label={t("voice.hex.path")} htmlFor="hex-path" description={t("voice.hex.pathDescription")}>
        <CommitInput
          id="hex-path"
          className="w-72 font-mono text-[13px]"
          placeholder="/Applications/Hex.app"
          value={voice.hexPath}
          onCommit={(hexPath) => patch({ voice: { hexPath: hexPath.trim() } })}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
