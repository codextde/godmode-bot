import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, HeartPulse, RotateCcw, ScrollText, Server } from "lucide-react";
import type { Bootstrap } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DoctorChecklist } from "@/components/onboarding/doctor-checklist";
import { CopyButton } from "@/components/vault/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { InfoRow, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

function joinPath(dir: string, ...parts: string[]) {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

export function SystemSection({ bootstrap }: { bootstrap: Bootstrap | undefined }) {
  const qc = useQueryClient();
  const [confirmOnboarding, setConfirmOnboarding] = useState(false);
  const rerun = useMutation({
    mutationFn: () => api.settings.update({ onboardingComplete: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (e) => toastApiError(e, "Could not restart onboarding", qc),
  });

  const dataDir = bootstrap?.dataDir ?? "";
  const logPath = dataDir ? joinPath(dataDir, "logs", "core.log") : "";

  return (
    <div className="space-y-5">
      <SectionHeading title="System" description="Health of the tools Godmode relies on, and where your data lives." />

      <SettingsGroup title="System check" icon={<HeartPulse />} description="Everything agents need to work. Missing pieces can be installed with one click." bodyClassName="py-4">
        <DoctorChecklist ids={["claude", "claude-auth", "uv", "browser-use", "chrome", "git"]} />
      </SettingsGroup>

      <SettingsGroup title="Installation" icon={<Server />}>
        <InfoRow label="Version">
          <span className="font-mono text-xs">{bootstrap?.version ?? "—"}</span>
        </InfoRow>
        <InfoRow label="Mode">
          <Badge variant="secondary" className="font-normal">
            {bootstrap?.mode === "server" ? "Web dashboard (godmode serve)" : isTauri ? "Desktop app" : "Desktop core"}
          </Badge>
        </InfoRow>
        <InfoRow label="Platform">
          <span className="font-mono text-xs">{bootstrap?.platform ?? "—"}</span>
        </InfoRow>
        <InfoRow label={<span className="flex items-center gap-1.5"><FolderOpen className="size-3.5" /> Data directory</span>}>
          <code className="truncate rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px]" title={dataDir}>
            {dataDir || "—"}
          </code>
          {dataDir && <CopyButton value={dataDir} label="Copy path" size="icon-xs" toastLabel="Path copied" />}
        </InfoRow>
        <InfoRow label={<span className="flex items-center gap-1.5"><ScrollText className="size-3.5" /> Logs</span>}>
          <code className="truncate rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px]" title={logPath}>
            {logPath || "—"}
          </code>
          {logPath && <CopyButton value={logPath} label="Copy log path" size="icon-xs" toastLabel="Path copied" />}
        </InfoRow>
        <p className="py-3 text-xs text-muted-foreground">
          Something off? Open the log file in a text editor, or run <code className="rounded-[4px] bg-secondary px-1 font-mono">godmode doctor</code> in a terminal.
        </p>
      </SettingsGroup>

      <SettingsGroup title="Setup" icon={<RotateCcw />}>
        <SettingRow label="Run onboarding again" description="Walk through the setup wizard again. Your data, vault and agents are kept.">
          <Button variant="outline" size="sm" onClick={() => setConfirmOnboarding(true)} disabled={rerun.isPending}>
            {rerun.isPending ? <Spinner /> : <RotateCcw />} Re-run onboarding
          </Button>
        </SettingRow>
      </SettingsGroup>

      <AlertDialog open={confirmOnboarding} onOpenChange={setConfirmOnboarding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-run onboarding?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll see the welcome wizard again. Nothing is deleted — steps that are already done (like the vault) are skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => rerun.mutate()}>Start onboarding</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
