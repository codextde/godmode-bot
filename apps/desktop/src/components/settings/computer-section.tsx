import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppWindow, ArrowRight, CircleCheck, CircleDashed, Cpu, Eye, MonitorUp, ShieldCheck, Square, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { missingPermissions, useComputerSetupActions, useComputerStatus } from "@/components/computer/computer-setup";
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
  const { patch } = useSettingsPatch();
  const c = settings.computer;
  const qc = useQueryClient();
  const status = useComputerStatus();
  const { permissions, installCua } = useComputerSetupActions();
  const stopCua = useMutation({
    mutationFn: api.computer.stopCua,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.computer }),
    onError: (e) => toast.error("Couldn't stop Cua Driver", { description: errorMessage(e) }),
  });
  const s = status.data;
  const mac = s?.platform === "darwin";
  const missing = missingPermissions(s);

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Computer"
        description="Share a window, a screen or a browser tab with an agent — like sharing your screen with ChatGPT. A shared window is controlled in the background with Cua Driver, so you keep working."
      />

      <SettingsGroup
        title="Computer use"
        icon={<MonitorUp />}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/computer">
              Live view <ArrowRight />
            </Link>
          </Button>
        }
      >
        <SettingRow
          label="Let agents use shared windows and screens"
          htmlFor="computer-enabled"
          description="Agents only see what you share in a chat (or what you allow an agent in its settings), and only while it's shared."
        >
          <Switch id="computer-enabled" checked={c.enabled} onCheckedChange={(enabled) => patch({ computer: { enabled } })} />
        </SettingRow>
        <SettingRow
          label="Bring a shared window to the front when needed"
          htmlFor="computer-foreground"
          disabled={!c.enabled}
          description="Some apps ignore input in the background (e.g. menu shortcuts). Allow agents to bring the shared window forward for a moment — it steals focus briefly."
        >
          <Switch id="computer-foreground" checked={c.allowForeground} disabled={!c.enabled} onCheckedChange={(allowForeground) => patch({ computer: { allowForeground } })} />
        </SettingRow>
      </SettingsGroup>

      {mac && (
        <SettingsGroup
          title="macOS permissions"
          icon={<ShieldCheck />}
          description="Asked for the app that runs Godmode. Restart Godmode after granting them."
          actions={
            missing.length ? (
              <Button size="sm" onClick={() => permissions.mutate()} disabled={permissions.isPending}>
                {permissions.isPending && <Spinner />} Allow access
              </Button>
            ) : undefined
          }
        >
          <InfoRow label="Screen Recording — see windows and screens">
            <State ok={s?.permissions.screenRecording ?? null}>{s?.permissions.screenRecording ? "Allowed" : "Not allowed"}</State>
          </InfoRow>
          <InfoRow label="Accessibility — click, type, press buttons">
            <State ok={s?.permissions.accessibility ?? null}>{s?.permissions.accessibility ? "Allowed" : "Not allowed"}</State>
          </InfoRow>
        </SettingsGroup>
      )}

      <SettingsGroup
        title="Cua Driver"
        icon={<AppWindow />}
        description={
          <>
            Open-source background computer use from{" "}
            <a href="https://github.com/trycua/cua" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              trycua/cua
            </a>{" "}
            (MIT): it drives single windows through accessibility and background input on macOS, Windows and Linux.
          </>
        }
        actions={
          s?.cua.running ? (
            <Button variant="outline" size="sm" onClick={() => stopCua.mutate()} disabled={stopCua.isPending}>
              <Square /> Stop
            </Button>
          ) : s && c.useCuaDriver && !s.cua.installed ? (
            <Button size="sm" onClick={() => installCua.mutate()} disabled={installCua.isPending}>
              {installCua.isPending && <Spinner />} {installCua.isPending ? "Installing…" : "Install"}
            </Button>
          ) : undefined
        }
      >
        <SettingRow
          label="Use Cua Driver for shared windows"
          htmlFor="computer-cua"
          disabled={!c.enabled}
          description={
            mac
              ? "Recommended. Without it, Godmode's built-in helper controls windows (clicks and keys to the app, buttons through accessibility)."
              : "Needed on Windows and Linux to see and control windows and the screen."
          }
        >
          <Switch id="computer-cua" checked={c.useCuaDriver} disabled={!c.enabled} onCheckedChange={(useCuaDriver) => patch({ computer: { useCuaDriver } })} />
        </SettingRow>
        <InfoRow label="Status">
          <State ok={s ? s.cua.installed && c.useCuaDriver : null}>{s?.cua.detail ?? "…"}</State>
        </InfoRow>
        <SettingRow
          label="Show the agent's cursor"
          htmlFor="computer-agent-cursor"
          disabled={!c.enabled || (!mac && !c.useCuaDriver)}
          description="An agent works in the background without moving your pointer — this draws its own pointer on the window it controls, so you can see where it clicks."
        >
          <Switch
            id="computer-agent-cursor"
            checked={c.agentCursor}
            disabled={!c.enabled || (!mac && !c.useCuaDriver)}
            onCheckedChange={(agentCursor) => patch({ computer: { agentCursor } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Live view" icon={<Eye />}>
        <SettingRow label="Stream what agents see" htmlFor="computer-live" description="Pictures are only taken while you're watching.">
          <Switch id="computer-live" checked={c.liveView} onCheckedChange={(liveView) => patch({ computer: { liveView } })} />
        </SettingRow>
        <SettingRow label="Frames per second" htmlFor="computer-fps" disabled={!c.liveView} description="Higher is smoother, lower saves CPU.">
          <NumberField id="computer-fps" min={1} max={10} suffix="fps" disabled={!c.liveView} value={c.liveViewFps} onCommit={(v) => v !== null && patch({ computer: { liveViewFps: v } })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Advanced" icon={<Wrench />}>
        <SettingRow
          label="Screenshot size for the model"
          htmlFor="computer-shot"
          description="Long edge in pixels. Larger shows more detail but costs more tokens; agents can zoom in either way."
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
          label="Cua Driver command"
          htmlFor="computer-cua-cmd"
          description={
            <>
              Leave empty to use the pinned version through uv. Example: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]">~/.local/bin/cua-driver</code>
            </>
          }
        >
          <CommitInput
            id="computer-cua-cmd"
            className="w-72 font-mono text-[13px]"
            placeholder="Auto (uvx cua-driver)"
            value={c.cuaDriverCommand}
            onCommit={(cuaDriverCommand) => patch({ computer: { cuaDriverCommand: cuaDriverCommand.trim() } })}
          />
        </SettingRow>
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Cpu className="size-3.5" />
          {s?.native.available ? "Godmode's built-in helper is ready (every display, window capture, background input)." : (s?.native.detail ?? "Checking the built-in helper…")}
        </div>
      </SettingsGroup>
    </div>
  );
}
