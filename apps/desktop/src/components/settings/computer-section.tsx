import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppWindow, ArrowRight, CircleCheck, CircleDashed, Cpu, Eye, MonitorUp, ShieldCheck, Square, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { missingPermissions, useComputerSetupActions, useComputerStatus } from "@/components/computer/computer-setup";
import { useMacPermissionsGuide } from "@/components/permissions/mac-permissions";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CommitInput, InfoRow, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

function State({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px]", ok ? "text-foreground" : "text-muted-foreground")}>
      {ok ? <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <CircleDashed className="size-3.5" />}
      {children}
    </span>
  );
}

export function ComputerSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const { patch } = useSettingsPatch();
  const c = settings.computer;
  const qc = useQueryClient();
  const status = useComputerStatus();
  const { installCua } = useComputerSetupActions();
  const showGuide = useMacPermissionsGuide((st) => st.show);
  const stopCua = useMutation({
    mutationFn: api.computer.stopCua,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.computer }),
    onError: (e) => toast.error(t("computer.stopError"), { description: errorMessage(e) }),
  });
  const s = status.data;
  const mac = s?.platform === "darwin";
  const missing = missingPermissions(s);

  return (
    <div className="space-y-5">
      <SectionHeading title={t("computer.title")} description={t("computer.description")} />

      <SettingsGroup
        title={t("computer.use.title")}
        icon={<MonitorUp />}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/computer">
              {t("computer.use.liveView")} <ArrowRight />
            </Link>
          </Button>
        }
      >
        <SettingRow
          label={t("computer.use.enabled")}
          htmlFor="computer-enabled"
          description={t("computer.use.enabledDescription")}
        >
          <Switch id="computer-enabled" checked={c.enabled} onCheckedChange={(enabled) => patch({ computer: { enabled } })} />
        </SettingRow>
        <SettingRow
          label={t("computer.use.foreground")}
          htmlFor="computer-foreground"
          disabled={!c.enabled}
          description={t("computer.use.foregroundDescription")}
        >
          <Switch id="computer-foreground" checked={c.allowForeground} disabled={!c.enabled} onCheckedChange={(allowForeground) => patch({ computer: { allowForeground } })} />
        </SettingRow>
      </SettingsGroup>

      {mac && (
        <SettingsGroup
          title={t("computer.permissions.title")}
          icon={<ShieldCheck />}
          description={t("computer.permissions.description")}
          actions={
            <Button size="sm" variant={missing.length ? "default" : "outline"} onClick={() => showGuide(s?.permissions.accessibility === false ? "accessibility" : s?.permissions.screenRecording === false ? "screen-recording" : undefined)}>
              {missing.length ? t("computer.permissions.setUp") : t("computer.permissions.guide")}
            </Button>
          }
        >
          <InfoRow label={t("computer.permissions.screenRecording")}>
            <State ok={s?.permissions.screenRecording ?? null}>{s?.permissions.screenRecording ? t("computer.permissions.allowed") : t("computer.permissions.notAllowed")}</State>
          </InfoRow>
          <InfoRow label={t("computer.permissions.accessibility")}>
            <State ok={s?.permissions.accessibility ?? null}>{s?.permissions.accessibility ? t("computer.permissions.allowed") : t("computer.permissions.notAllowed")}</State>
          </InfoRow>
        </SettingsGroup>
      )}

      <SettingsGroup
        title="Cua Driver"
        icon={<AppWindow />}
        description={
          <Trans
            t={t}
            i18nKey="computer.cua.description"
            components={{ link: <a href="https://github.com/trycua/cua" target="_blank" rel="noreferrer" className="underline underline-offset-2" /> }}
          />
        }
        actions={
          s?.cua.running ? (
            <Button variant="outline" size="sm" onClick={() => stopCua.mutate()} disabled={stopCua.isPending}>
              <Square /> {t("common:actions.stop")}
            </Button>
          ) : s && c.useCuaDriver && !s.cua.installed ? (
            <Button size="sm" onClick={() => installCua.mutate()} disabled={installCua.isPending}>
              {installCua.isPending && <Spinner />} {installCua.isPending ? t("computer.cua.installing") : t("computer.cua.install")}
            </Button>
          ) : undefined
        }
      >
        <SettingRow
          label={t("computer.cua.use")}
          htmlFor="computer-cua"
          disabled={!c.enabled}
          description={
            mac
              ? t("computer.cua.useDescriptionMac")
              : t("computer.cua.useDescriptionOther")
          }
        >
          <Switch id="computer-cua" checked={c.useCuaDriver} disabled={!c.enabled} onCheckedChange={(useCuaDriver) => patch({ computer: { useCuaDriver } })} />
        </SettingRow>
        <InfoRow label={t("computer.cua.status")}>
          <State ok={s ? s.cua.installed && c.useCuaDriver : null}>{s?.cua.detail ?? "…"}</State>
        </InfoRow>
        <SettingRow
          label={t("computer.cua.cursor")}
          htmlFor="computer-agent-cursor"
          disabled={!c.enabled || (!mac && !c.useCuaDriver)}
          description={t("computer.cua.cursorDescription")}
        >
          <Switch
            id="computer-agent-cursor"
            checked={c.agentCursor}
            disabled={!c.enabled || (!mac && !c.useCuaDriver)}
            onCheckedChange={(agentCursor) => patch({ computer: { agentCursor } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("computer.live.title")} icon={<Eye />}>
        <SettingRow label={t("computer.live.stream")} htmlFor="computer-live" description={t("computer.live.streamDescription")}>
          <Switch id="computer-live" checked={c.liveView} onCheckedChange={(liveView) => patch({ computer: { liveView } })} />
        </SettingRow>
        <SettingRow label={t("computer.live.fps")} htmlFor="computer-fps" disabled={!c.liveView} description={t("computer.live.fpsDescription")}>
          <NumberField id="computer-fps" min={1} max={10} suffix="fps" disabled={!c.liveView} value={c.liveViewFps} onCommit={(v) => v !== null && patch({ computer: { liveViewFps: v } })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("computer.advanced.title")} icon={<Wrench />}>
        <SettingRow
          label={t("computer.advanced.screenshot")}
          htmlFor="computer-shot"
          description={t("computer.advanced.screenshotDescription")}
        >
          <NumberField
            id="computer-shot"
            min={640}
            max={1568}
            step={16}
            suffix="px"
            value={c.screenshotMaxSize}
            onCommit={(v) => v !== null && patch({ computer: { screenshotMaxSize: v } })}
          />
        </SettingRow>
        <SettingRow
          label={t("computer.advanced.command")}
          htmlFor="computer-cua-cmd"
          description={
            <Trans t={t} i18nKey="computer.advanced.commandDescription" values={{ example: "~/.local/bin/cua-driver" }} components={{ code: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }} />
          }
        >
          <CommitInput
            id="computer-cua-cmd"
            className="w-72 font-mono text-[13px]"
            placeholder={t("computer.advanced.commandPlaceholder")}
            value={c.cuaDriverCommand}
            onCommit={(cuaDriverCommand) => patch({ computer: { cuaDriverCommand: cuaDriverCommand.trim() } })}
          />
        </SettingRow>
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Cpu className="size-3.5" />
          {s?.native.available ? t("computer.advanced.helperReady") : (s?.native.detail ?? t("computer.advanced.helperChecking"))}
        </div>
      </SettingsGroup>
    </div>
  );
}
