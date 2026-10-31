import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MonitorOff, ShieldAlert } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ComputerStatus } from "@godmode/shared";
import { useMacPermissionsGuide } from "@/components/permissions/mac-permissions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function useComputerStatus(enabled = true) {
  return useQuery({ queryKey: qk.computerStatus, queryFn: api.computer.status, enabled, staleTime: 5_000 });
}

export function missingPermissions(status: ComputerStatus | undefined): string[] {
  if (!status) return [];
  const missing: string[] = [];
  if (status.permissions.accessibility === false) missing.push("Accessibility");
  if (status.permissions.screenRecording === false) missing.push("Screen Recording");
  return missing;
}

export function useComputerSetupActions() {
  const { t } = useTranslation("computer");
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.computer });
    void qc.invalidateQueries({ queryKey: qk.doctor });
  };
  const permissions = useMutation({
    mutationFn: api.computer.requestPermissions,
    onSuccess: (status) => {
      qc.setQueryData(qk.computerStatus, status);
      if (missingPermissions(status).length) {
        toast.info(t("setup.allowTitle"), {
          description: t("setup.allowDescription"),
        });
      }
      refresh();
    },
    onError: (e) => toast.error(t("setup.askFailed"), { description: errorMessage(e) }),
  });
  const installCua = useMutation({
    mutationFn: api.computer.installCua,
    onSuccess: (r) => {
      if (r.ok) toast.success(t("setup.cuaReady"));
      else toast.error(t("setup.cuaFailed"), { description: r.output });
      refresh();
    },
    onError: (e) => toast.error(t("setup.cuaFailed"), { description: errorMessage(e) }),
  });
  return { permissions, installCua };
}

/** What still stands between the human and computer use: turned off, missing macOS permissions, Cua Driver. */
export function ComputerSetupNotice({ status, className, showCua = true }: { status: ComputerStatus | undefined; className?: string; showCua?: boolean }) {
  const { t } = useTranslation("computer");
  const { installCua } = useComputerSetupActions();
  const showGuide = useMacPermissionsGuide((s) => s.show);
  if (!status) return null;
  const missing = missingPermissions(status);
  const items: React.ReactNode[] = [];

  if (!status.enabled) {
    items.push(
      <Notice key="off" icon={<MonitorOff />} tone="muted" title={t("setup.offTitle")}>
        <Trans
          t={t}
          i18nKey="setup.offBody"
          components={{ link: <Link to="/settings/computer" className="font-medium text-foreground underline underline-offset-2" /> }}
        />
      </Notice>,
    );
  } else if (missing.length) {
    items.push(
      <Notice
        key="perm"
        icon={<ShieldAlert />}
        tone="warn"
        title={missing.length > 1 ? t("setup.permTitleBoth") : missing[0] === "Accessibility" ? t("setup.permTitleAccessibility") : t("setup.permTitleScreen")}
        action={
          <Button size="sm" onClick={() => showGuide(status.permissions.accessibility === false ? "accessibility" : "screen-recording")}>
            {t("setup.setUp")}
          </Button>
        }
      >
        {t("setup.guide", { count: missing.length })} {missing.includes("Screen Recording") ? `${t("setup.noScreen")} ` : ""}
        {missing.includes("Accessibility") ? t("setup.noAccessibility") : ""}
      </Notice>,
    );
  }

  if (showCua && status.enabled && status.cua.enabled && !status.cua.installed) {
    items.push(
      <Notice
        key="cua"
        icon={<Download />}
        tone="muted"
        title={t("setup.cuaTitle")}
        action={
          <Button size="sm" variant="outline" onClick={() => installCua.mutate()} disabled={installCua.isPending}>
            {installCua.isPending && <Spinner />} {installCua.isPending ? t("setup.installing") : t("setup.install")}
          </Button>
        }
      >
        {status.platform === "darwin"
          ? t("setup.cuaMac")
          : t("setup.cuaOther")}
      </Notice>,
    );
  }

  if (!items.length) return null;
  return <div className={cn("space-y-2", className)}>{items}</div>;
}

function Notice({
  icon,
  title,
  children,
  action,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  tone: "warn" | "muted";
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-[13px]",
        tone === "warn" ? "border-amber-500/30 bg-amber-500/8 dark:bg-amber-400/10" : "bg-paper-2",
      )}
    >
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
