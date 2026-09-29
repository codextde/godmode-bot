import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Box, CircleCheck, CircleDashed, EyeOff, Globe, KeyRound, Moon, Power, PowerOff, RectangleEllipsis, ScrollText, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { Settings, VmSettings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useShortPath } from "@/components/chat/folder-picker";
import { useVaultGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useVmStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Callout, ChoiceCards, CommitInput, InfoRow, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

function Fact({ icon, children, caution }: { icon: React.ReactNode; children: React.ReactNode; caution?: boolean }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-md border bg-paper-2 px-2 py-1 text-xs text-muted-foreground [&_svg]:size-3.5">
      <span className={caution ? "text-warning" : "text-foreground"}>{icon}</span>
      {children}
    </li>
  );
}

function State({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px]", ok ? "text-foreground" : "text-muted-foreground")}>
      {ok ? <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <CircleDashed className="size-3.5" />}
      {children}
    </span>
  );
}

export function VmSection({ settings }: { settings: Settings }) {
  const { patch, patchAsync } = useSettingsPatch();
  const v = settings.vm;
  const qc = useQueryClient();
  const status = useVmStatus();
  const s = status.data;
  const short = useShortPath();
  const install = useMutation({
    mutationFn: api.vms.install,
    onSuccess: (res) => {
      if (res.ok) toast.success("Tart is ready");
      else toast.error("Tart couldn't be installed", { description: res.output || undefined });
      void qc.invalidateQueries({ queryKey: qk.vms });
    },
    onError: (e) => toastApiError(e, "Tart couldn't be installed", qc),
  });
  const removeImage = useMutation({
    mutationFn: (image: string) => api.vms.removeImage(image),
    onSuccess: () => {
      toast.success("Image removed");
      void qc.invalidateQueries({ queryKey: qk.vms });
    },
    onError: (e) => toastApiError(e, "The image couldn't be removed", qc),
  });
  const downloaded = s?.images.filter((i) => i.downloaded) ?? [];
  const set = (p: Partial<VmSettings>) => patch({ vm: p });
  const ensureGrant = useVaultGrant();
  const setVaultFill = async (vaultFill: boolean) => {
    if (vaultFill) {
      try {
        await ensureGrant("Enter your vault passphrase to let agents type your logins and 2FA codes into their VMs.");
      } catch {
        return;
      }
    }
    set({ vaultFill });
  };
  // Another binary changes what the status reports (installed, version). Failures are toasted by the patch hook.
  const saveTartPath = (tartPath: string) =>
    void patchAsync({ vm: { tartPath: tartPath.trim() } })
      .then(() => qc.invalidateQueries({ queryKey: qk.vms }))
      .catch(() => undefined);

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Virtual machines"
        description="Give agents their own macOS: they install tools, run builds and use apps in an isolated VM on this Mac instead of on your computer. A run uses its chat's VM, else its agent's, else its workspace's."
      />

      {s && !s.supported && (
        <Callout tone="warning" title="Virtual machines aren't available on this machine">
          {s.reason ?? "macOS VMs need a Mac with Apple silicon."}
        </Callout>
      )}

      <SettingsGroup
        title="Virtual machines"
        icon={<Box />}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/vms">
              Manage VMs <ArrowRight />
            </Link>
          </Button>
        }
      >
        <SettingRow
          label="Let agents work in virtual machines"
          htmlFor="vm-enabled"
          description="Agents, chats and workspaces with a VM assigned run there. Turned off, every run works on this Mac and VM controls are hidden in chats and agent settings."
        >
          <Switch id="vm-enabled" checked={v.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        </SettingRow>
        <SettingRow
          label="Keep agents with a VM off this Mac"
          htmlFor="vm-isolate"
          disabled={!v.enabled}
          description="Claude Code's own Bash tool — which runs on this Mac — is turned off for their runs and permissions aren't bypassed, so commands can't touch your computer and file tools only reach the agent's repository, the chat's folder and the VM's shared folder."
        >
          <Switch id="vm-isolate" checked={v.isolateHostShell} disabled={!v.enabled} onCheckedChange={(isolateHostShell) => set({ isolateHostShell })} />
        </SettingRow>
        <SettingRow
          label="Stop idle VMs after"
          htmlFor="vm-idle"
          description="Frees memory and CPU when no run used a VM for this long. 0 = keep them running."
        >
          <NumberField
            id="vm-idle"
            min={0}
            max={1440}
            suffix="min"
            value={v.idleStopMinutes}
            onCommit={(n) => n !== null && set({ idleStopMinutes: n })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Logins and 2FA codes"
        icon={<KeyRound />}
        description="Let agents sign in to websites and apps inside their VM with the logins and 2FA codes from your vault."
      >
        <SettingRow
          label="Type logins and 2FA codes into VMs"
          htmlFor="vm-vault-fill"
          disabled={!v.enabled}
          description="Godmode types the value into the field the agent clicked on the VM's screen, so it never passes through the AI. But the agent controls the VM: Godmode can't check which website a field belongs to, and a determined agent could capture what's typed there. Turning this on asks for your vault passphrase."
        >
          <Switch id="vm-vault-fill" checked={v.vaultFill} disabled={!v.enabled} onCheckedChange={(on) => void setVaultFill(on)} />
        </SettingRow>
        <ul aria-label="How it works" className="flex flex-wrap gap-2 py-3.5">
          <Fact icon={<EyeOff />}>Typed by Godmode, not the AI</Fact>
          <Fact icon={<RectangleEllipsis />}>Passwords only into password fields</Fact>
          <Fact icon={<ScrollText />}>Every fill audited</Fact>
          <Fact icon={<Globe />} caution>
            Not bound to a website
          </Fact>
        </ul>
      </SettingsGroup>

      <SettingsGroup
        title="When Godmode quits"
        icon={<Power />}
        description="What happens to running VMs. Their disks are always kept."
        bodyClassName="py-4"
      >
        <ChoiceCards<VmSettings["onQuit"]>
          name="vm-on-quit"
          value={v.onQuit}
          onChange={(onQuit) => set({ onQuit })}
          className="@xl:grid-cols-3"
          options={[
            {
              value: "suspend",
              title: "Suspend",
              icon: <Moon />,
              badge: <span className="rounded-[5px] border border-brand/25 bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand-strong">Default</span>,
              description: "Their memory is saved to disk — they resume where they left off.",
            },
            { value: "stop", title: "Stop", icon: <PowerOff />, description: "macOS shuts down in each VM; the next start boots fresh." },
            { value: "keep", title: "Keep running", icon: <Power />, description: "They stay up; Godmode picks them up again when it starts." },
          ]}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Tart"
        icon={<Wrench />}
        description={
          <>
            Runs the VMs with Apple's Virtualization framework —{" "}
            <a href="https://tart.run" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              tart.run
            </a>
            , free for personal use.
          </>
        }
        actions={
          s?.supported && !s.tart.installed ? (
            <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
              {install.isPending && <Spinner />} {install.isPending ? "Installing…" : "Install"}
            </Button>
          ) : undefined
        }
      >
        <InfoRow label="Status">
          {s ? (
            <State ok={s.tart.installed}>
              {s.tart.installed
                ? [s.tart.version ? `Tart ${s.tart.version}` : "Installed", s.tart.managed ? "Godmode's own copy" : "from this Mac"].join(" · ")
                : s.supported
                  ? `Not installed — Godmode installs Tart ${s.tart.bundledVersion} when you set up or create a VM`
                  : "Not available"}
            </State>
          ) : (
            <State ok={null}>Checking…</State>
          )}
        </InfoRow>
        {s?.tart.path && (
          <InfoRow label="Binary" mono>
            <span className="break-all">{short(s.tart.path)}</span>
          </InfoRow>
        )}
        <InfoRow label="VMs and shared folders" mono>
          <span className="break-all">{s ? short(s.storageDir) : "…"}</span>
        </InfoRow>
        {s?.host.freeDiskGb != null && <InfoRow label="Free space">{s.host.freeDiskGb} GB</InfoRow>}
        {downloaded.map((img) => (
          <SettingRow
            key={img.id}
            label={img.name}
            description={`Downloaded image${img.sizeBytes ? ` · ${(img.sizeBytes / 1e9).toFixed(1)} GB` : ""} — new VMs from it are ready in seconds. Removing it frees the space; existing VMs keep working.`}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={removeImage.isPending && removeImage.variables === img.id}
              onClick={() => removeImage.mutate(img.id)}
            >
              {removeImage.isPending && removeImage.variables === img.id && <Spinner />} Remove
            </Button>
          </SettingRow>
        ))}
        <SettingRow
          label="Custom tart binary"
          htmlFor="vm-tart-path"
          description="Leave empty to use Godmode's own copy (installed on demand) or one on your PATH."
        >
          <CommitInput
            id="vm-tart-path"
            className="w-72 font-mono text-[13px]"
            placeholder="Godmode's own copy"
            value={v.tartPath}
            onCommit={saveTartPath}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
