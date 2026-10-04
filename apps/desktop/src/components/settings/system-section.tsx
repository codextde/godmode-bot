import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { CircleArrowDown, FolderOpen, HeartPulse, RotateCcw, ScrollText, Server, ShieldCheck, WandSparkles, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { Bootstrap, Settings } from "@godmode/shared";
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
import { DoctorChecklist, useDoctor } from "@/components/onboarding/doctor-checklist";
import { CopyButton } from "@/components/vault/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { InfoRow, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";
import { PermissionsChecklist, fixablePermissions, toastFix, usePermissions } from "./system-permissions";
import { ToolUpdateList, UpdateActions, UpkeepSettings, useToolUpdates } from "./system-updates";

function joinPath(dir: string, ...parts: string[]) {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** Renders without the settings document too (see STANDALONE in the settings page): only the upkeep switches need it. */
export function SystemSection({ bootstrap, settings }: { bootstrap: Bootstrap | undefined; settings: Settings | undefined }) {
  const qc = useQueryClient();
  const [confirmOnboarding, setConfirmOnboarding] = useState(false);
  const doctor = useDoctor();
  const permissions = usePermissions();
  const updates = useToolUpdates();
  // What "Fix all" takes care of: required tools Godmode can install, and its own files.
  const fixable = (doctor.data?.dependencies.filter((d) => !d.ok && d.required && d.installable).length ?? 0) + fixablePermissions(permissions.data);
  const fixAll = useMutation({
    mutationFn: api.doctor.fixAll,
    onSuccess: (report) => {
      if (!report.results.length) toast.info("Nothing to fix");
      else if (report.results.every((r) => r.outcome === "fixed")) toast.success(`Fixed ${report.results.map((r) => r.name).join(", ")}`);
      else report.results.forEach(toastFix);
      void qc.invalidateQueries({ queryKey: qk.doctor });
    },
    onError: (e) => toastApiError(e, "Could not fix the problems", qc),
  });
  const rerun = useMutation({
    mutationFn: () => api.settings.update({ onboardingComplete: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (e) => toastApiError(e, "Could not restart onboarding", qc),
  });

  const dataDir = bootstrap?.dataDir ?? "";
  const logPath = dataDir ? joinPath(dataDir, "logs", "godmode.jsonl") : "";

  return (
    <div className="space-y-5">
      <SectionHeading title="System" description="Health of the tools Godmode relies on, and where your data lives." />

      <SettingsGroup
        title="System check"
        icon={<HeartPulse />}
        description="Everything agents need to work. Missing pieces can be installed with one click."
        bodyClassName="py-4"
        actions={
          fixable > 0 && (
            <Button size="sm" onClick={() => fixAll.mutate()} disabled={fixAll.isPending}>
              {fixAll.isPending ? <Spinner /> : <Wrench />}
              {fixAll.isPending ? "Fixing…" : "Fix all"}
            </Button>
          )
        }
      >
        <DoctorChecklist ids={["claude", "claude-auth", "uv", "browser-use", "chrome", "git"]} />
      </SettingsGroup>

      <SettingsGroup
        title="Permissions"
        icon={<ShieldCheck />}
        description="What Godmode may do on this computer: its own files, its tools, and what the system lets it see and control."
        bodyClassName="py-4"
      >
        <PermissionsChecklist />
      </SettingsGroup>

      <SettingsGroup title="Updates" icon={<CircleArrowDown />} description="The tools Godmode has installed, and their versions." actions={<UpdateActions updates={updates} />}>
        <ToolUpdateList updates={updates} />
      </SettingsGroup>

      {settings && (
        <SettingsGroup title="Automatic upkeep" icon={<WandSparkles />} description="Let Godmode look after its tools in the background.">
          <UpkeepSettings settings={settings} />
        </SettingsGroup>
      )}

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
          Something off?{" "}
          <Link to="/settings/logs" className="font-medium text-foreground underline-offset-4 hover:underline">
            Open the logs
          </Link>{" "}
          to copy them for Claude, or run <code className="rounded-[4px] bg-secondary px-1 font-mono">godmode doctor</code> in a terminal.
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
