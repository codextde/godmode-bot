import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MonitorOff, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { ComputerStatus } from "@godmode/shared";
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
        toast.info("Allow Godmode in System Settings", {
          description: "Privacy & Security → Accessibility and Screen & System Audio Recording. Restart Godmode if pictures stay black afterwards.",
        });
      }
      refresh();
    },
    onError: (e) => toast.error("Couldn't ask for access", { description: errorMessage(e) }),
  });
  const installCua = useMutation({
    mutationFn: api.computer.installCua,
    onSuccess: (r) => {
      if (r.ok) toast.success("Cua Driver is ready");
      else toast.error("Cua Driver couldn't be installed", { description: r.output });
      refresh();
    },
    onError: (e) => toast.error("Cua Driver couldn't be installed", { description: errorMessage(e) }),
  });
  return { permissions, installCua };
}

/** What still stands between the human and computer use: turned off, missing macOS permissions, Cua Driver. */
export function ComputerSetupNotice({ status, className, showCua = true }: { status: ComputerStatus | undefined; className?: string; showCua?: boolean }) {
  const { permissions, installCua } = useComputerSetupActions();
  if (!status) return null;
  const missing = missingPermissions(status);
  const items: React.ReactNode[] = [];

  if (!status.enabled) {
    items.push(
      <Notice key="off" icon={<MonitorOff />} tone="muted" title="Computer use is turned off">
        Turn it on in{" "}
        <Link to="/settings/computer" className="font-medium text-foreground underline underline-offset-2">
          Settings → Computer
        </Link>{" "}
        to share windows and screens with agents.
      </Notice>,
    );
  } else if (missing.length) {
    items.push(
      <Notice
        key="perm"
        icon={<ShieldAlert />}
        tone="warn"
        title={`Godmode needs ${missing.join(" and ")}`}
        action={
          <Button size="sm" onClick={() => permissions.mutate()} disabled={permissions.isPending}>
            {permissions.isPending && <Spinner />} Allow access
          </Button>
        }
      >
        macOS asks once. {missing.includes("Screen Recording") ? "Without Screen Recording, agents can't see windows. " : ""}
        {missing.includes("Accessibility") ? "Without Accessibility, they can't click or type." : ""}
      </Notice>,
    );
  }

  if (showCua && status.enabled && status.cua.enabled && !status.cua.installed) {
    items.push(
      <Notice
        key="cua"
        icon={<Download />}
        tone="muted"
        title="Install Cua Driver for sharing single windows"
        action={
          <Button size="sm" variant="outline" onClick={() => installCua.mutate()} disabled={installCua.isPending}>
            {installCua.isPending && <Spinner />} {installCua.isPending ? "Installing…" : "Install"}
          </Button>
        }
      >
        {status.platform === "darwin"
          ? "Open-source (trycua/cua): clicks buttons and fills fields through accessibility, even when the window is covered. Godmode's built-in helper works without it."
          : "Open-source (trycua/cua): needed on this system to see and control windows and the screen."}
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
