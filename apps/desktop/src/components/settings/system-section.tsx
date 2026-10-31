import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { CircleArrowDown, FolderOpen, HeartPulse, RotateCcw, ScrollText, Server, ShieldCheck, WandSparkles, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["settings", "common"]);
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
      if (!report.results.length) toast.info(t("system.nothingToFix"));
      else if (report.results.every((r) => r.outcome === "fixed")) toast.success(t("system.fixed", { names: report.results.map((r) => r.name).join(", ") }));
      else report.results.forEach(toastFix);
      void qc.invalidateQueries({ queryKey: qk.doctor });
    },
    onError: (e) => toastApiError(e, t("system.fixError"), qc),
  });
  const rerun = useMutation({
    mutationFn: () => api.settings.update({ onboardingComplete: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (e) => toastApiError(e, t("system.onboardingError"), qc),
  });

  const dataDir = bootstrap?.dataDir ?? "";
  const logPath = dataDir ? joinPath(dataDir, "logs", "godmode.jsonl") : "";

  return (
    <div className="space-y-5">
      <SectionHeading title={t("system.title")} description={t("system.description")} />

      <SettingsGroup
        title={t("system.check.title")}
        icon={<HeartPulse />}
        description={t("system.check.description")}
        bodyClassName="py-4"
        actions={
          fixable > 0 && (
            <Button size="sm" onClick={() => fixAll.mutate()} disabled={fixAll.isPending}>
              {fixAll.isPending ? <Spinner /> : <Wrench />}
              {fixAll.isPending ? t("system.check.fixing") : t("system.check.fixAll")}
            </Button>
          )
        }
      >
        <DoctorChecklist ids={["claude", "claude-auth", "uv", "browser-use", "chrome", "git"]} />
      </SettingsGroup>

      <SettingsGroup
        title={t("system.permissions.title")}
        icon={<ShieldCheck />}
        description={t("system.permissions.description")}
        bodyClassName="py-4"
      >
        <PermissionsChecklist />
      </SettingsGroup>

      <SettingsGroup title={t("system.updates.title")} icon={<CircleArrowDown />} description={t("system.updates.description")} actions={<UpdateActions updates={updates} />}>
        <ToolUpdateList updates={updates} />
      </SettingsGroup>

      {settings && (
        <SettingsGroup title={t("system.upkeep.title")} icon={<WandSparkles />} description={t("system.upkeep.description")}>
          <UpkeepSettings settings={settings} />
        </SettingsGroup>
      )}

      <SettingsGroup title={t("system.install.title")} icon={<Server />}>
        <InfoRow label={t("system.install.version")}>
          <span className="font-mono text-xs">{bootstrap?.version ?? "—"}</span>
        </InfoRow>
        <InfoRow label={t("general.appearance.mode")}>
          <Badge variant="secondary" className="font-normal">
            {bootstrap?.mode === "server" ? t("system.install.modeServer") : isTauri ? t("system.install.modeApp") : t("system.install.modeCore")}
          </Badge>
        </InfoRow>
        <InfoRow label={t("system.install.platform")}>
          <span className="font-mono text-xs">{bootstrap?.platform ?? "—"}</span>
        </InfoRow>
        <InfoRow label={<span className="flex items-center gap-1.5"><FolderOpen className="size-3.5" /> {t("system.install.dataDir")}</span>}>
          <code className="truncate rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px]" title={dataDir}>
            {dataDir || "—"}
          </code>
          {dataDir && <CopyButton value={dataDir} label={t("system.install.copyPath")} size="icon-xs" toastLabel={t("system.install.pathCopied")} />}
        </InfoRow>
        <InfoRow label={<span className="flex items-center gap-1.5"><ScrollText className="size-3.5" /> {t("logs.title")}</span>}>
          <code className="truncate rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px]" title={logPath}>
            {logPath || "—"}
          </code>
          {logPath && <CopyButton value={logPath} label={t("system.install.copyLogPath")} size="icon-xs" toastLabel={t("system.install.pathCopied")} />}
        </InfoRow>
        <p className="py-3 text-xs text-muted-foreground">
          <Trans
            t={t}
            i18nKey="system.install.help"
            values={{ command: "godmode doctor" }}
            components={{ link: <Link to="/settings/logs" className="font-medium text-foreground underline-offset-4 hover:underline" />, code: <code className="rounded-[4px] bg-secondary px-1 font-mono" /> }}
          />
        </p>
      </SettingsGroup>

      <SettingsGroup title={t("system.setup.title")} icon={<RotateCcw />}>
        <SettingRow label={t("system.setup.label")} description={t("system.setup.description")}>
          <Button variant="outline" size="sm" onClick={() => setConfirmOnboarding(true)} disabled={rerun.isPending}>
            {rerun.isPending ? <Spinner /> : <RotateCcw />} {t("system.setup.button")}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <AlertDialog open={confirmOnboarding} onOpenChange={setConfirmOnboarding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("system.setup.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("system.setup.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => rerun.mutate()}>{t("system.setup.start")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
