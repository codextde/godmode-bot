import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CircleAlert, CircleCheck, CircleX, KeyRound, RefreshCw, Wrench } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { FixResult, PermissionId, PermissionReport, PermissionStatus } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { isPrivacyPermission, useMacPermissionsGuide } from "@/components/permissions/mac-permissions";
import { api, errorMessage } from "@/lib/api";
import { t as translate } from "@/i18n";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useReduceAnimations } from "@/lib/motion";

/** After asking macOS, the answer is given in System Settings: look again for a while. */
const WAIT_FOR_ANSWER_MS = 2 * 60_000;

/** `watch`: look every 2 s (a system dialog is open); `idleMs`: look now and then (the sidebar). */
export function usePermissions(watch = false, idleMs?: number) {
  return useQuery({ queryKey: qk.permissions, queryFn: api.doctor.permissions, staleTime: 10_000, refetchInterval: watch ? 2_000 : (idleMs ?? false) });
}

/** Tell the human what a repair did (shared by single repairs and "Fix all"). */
export function toastFix(result: FixResult) {
  if (result.outcome === "fixed") toast.success(translate("settings:system.perm.fixed", { name: result.name }));
  else if (result.outcome === "pending") toast.info(translate("settings:system.perm.allowFor", { name: result.name }), { description: result.output });
  else if (result.outcome === "manual") toast.info(translate("settings:system.perm.needsYou", { name: result.name }), { description: <span className="whitespace-pre-line">{result.output}</span> });
  else toast.error(translate("settings:system.perm.fixError", { name: result.name }), { description: <span className="whitespace-pre-line">{result.output}</span> });
}

/**
 * What Godmode may do on this computer — its files, its tools and (macOS) the privacy permissions — with a repair
 * for everything it can repair or ask for itself.
 */
export function PermissionsChecklist({ className }: { className?: string }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  // The permission the human was just asked for in a system dialog.
  const [asked, setAsked] = useState<{ id: PermissionId; at: number } | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching } = usePermissions(asked !== null);

  // Stop looking once the human has answered, or didn't.
  useEffect(() => {
    if (!asked) return;
    if (data && data.permissions.find((p) => p.id === asked.id)?.ok !== false) return setAsked(null);
    const timer = setTimeout(() => setAsked(null), Math.max(0, asked.at + WAIT_FOR_ANSWER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [asked, data]);

  if (isLoading)
    return (
      <div className={cn("space-y-2", className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  if (isError || !data)
    return (
      <div className={cn("rounded-lg border border-destructive/25 bg-destructive/[0.05] p-4 text-sm", className)}>
        <p className="font-medium text-destructive">{t("system.perm.loadError")}</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw /> {t("common:actions.tryAgain")}
        </Button>
      </div>
    );

  const open = data.permissions.filter((p) => !p.ok).length;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2 pb-1 text-xs text-muted-foreground">
        <span>{open ? t("system.perm.needAttention", { count: open }) : t("system.perm.allAllowed")}</span>
        <Button size="xs" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Spinner className="size-3" /> : <RefreshCw />} {t("system.perm.recheck")}
        </Button>
      </div>
      {data.permissions.map((permission, i) => (
        <motion.div key={permission.id} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <PermissionRow
            permission={permission}
            onFixed={(result) => {
              if (result.outcome === "pending") setAsked({ id: permission.id, at: Date.now() });
              void qc.invalidateQueries({ queryKey: qk.permissions });
              // Tools that couldn't be started show up in the system check as broken.
              if (permission.id === "tool-binaries") void qc.invalidateQueries({ queryKey: qk.doctor });
            }}
          />
        </motion.div>
      ))}
    </div>
  );
}

function PermissionRow({ permission, onFixed }: { permission: PermissionStatus; onFixed: (result: FixResult) => void }) {
  const { t } = useTranslation("settings");
  const fix = useMutation({
    mutationFn: () => api.doctor.fixPermission(permission.id),
    onSuccess: (result) => {
      toastFix(result);
      onFixed(result);
    },
    onError: (e) => toast.error(t("system.perm.fixError", { name: permission.name }), { description: errorMessage(e) }),
  });

  const showGuide = useMacPermissionsGuide((s) => s.show);
  const guided = isPrivacyPermission(permission.id) && !!permission.privacy;
  const state: "ok" | "warn" | "error" = permission.ok && !permission.privacy?.restartNeeded ? "ok" : permission.required ? "error" : "warn";
  const Icon = state === "ok" ? CircleCheck : state === "error" ? CircleX : CircleAlert;
  const request = permission.fix === "request";

  return (
    <div className={cn("rounded-lg border bg-card p-3.5 transition-colors", state === "error" && "border-destructive/25", state === "warn" && "border-warning/25")}>
      <div className="flex items-start gap-3">
        <Icon
          className={cn("mt-0.5 size-5 shrink-0", state === "ok" && "text-success", state === "warn" && "text-warning", state === "error" && "text-destructive")}
          aria-label={state === "ok" ? t("computer.permissions.allowed") : t("computer.permissions.notAllowed")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{permission.name}</span>
            {!permission.required && (
              <Badge variant="outline" className="h-5 rounded-[5px] text-[10px] font-normal text-muted-foreground">
                {t("system.perm.optional")}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs break-words text-muted-foreground">{permission.detail}</p>
          {permission.ok && permission.path && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">{permission.path}</p>}
          {!permission.ok && permission.fixHint && (
            <p className="mt-1.5 text-xs leading-relaxed break-words text-foreground/85">
              <InlineCode text={permission.fixHint} />
            </p>
          )}
        </div>
        {guided ? (
          <Button size="sm" variant={permission.ok && !permission.privacy?.restartNeeded ? "ghost" : "outline"} onClick={() => showGuide(permission.id)}>
            {permission.ok && !permission.privacy?.restartNeeded ? t("logs.detail.details") : t("computer.permissions.setUp")}
          </Button>
        ) : !permission.ok && permission.fix !== "manual" && (
          <Button size="sm" variant={permission.required ? "default" : "outline"} onClick={() => fix.mutate()} disabled={fix.isPending}>
            {fix.isPending ? <Spinner /> : request ? <KeyRound /> : <Wrench />}
            {request ? t("system.perm.allow") : fix.isPending ? t("system.check.fixing") : t("system.perm.fix")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Problems "Fix all" can take care of: Godmode's own files, and required tools it can install. */
export function fixablePermissions(report: PermissionReport | undefined): number {
  return report?.permissions.filter((p) => !p.ok && p.fix === "auto").length ?? 0;
}
