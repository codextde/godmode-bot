import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CircleAlert, CircleCheck, CircleX, KeyRound, RefreshCw, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { FixResult, PermissionId, PermissionReport, PermissionStatus } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** After asking macOS, the answer is given in System Settings: look again for a while. */
const WAIT_FOR_ANSWER_MS = 2 * 60_000;

export function usePermissions(watch = false) {
  return useQuery({ queryKey: qk.permissions, queryFn: api.doctor.permissions, staleTime: 10_000, refetchInterval: watch ? 2_000 : false });
}

/** Tell the human what a repair did (shared by single repairs and "Fix all"). */
export function toastFix(result: FixResult) {
  if (result.outcome === "fixed") toast.success(`${result.name} fixed`);
  else if (result.outcome === "pending") toast.info(`Allow ${result.name} for Godmode`, { description: result.output });
  else if (result.outcome === "manual") toast.info(`${result.name} needs you`, { description: <span className="whitespace-pre-line">{result.output}</span> });
  else toast.error(`Couldn't fix ${result.name}`, { description: <span className="whitespace-pre-line">{result.output}</span> });
}

/**
 * What Godmode may do on this computer — its files, its tools and (macOS) the privacy permissions — with a repair
 * for everything it can repair or ask for itself.
 */
export function PermissionsChecklist({ className }: { className?: string }) {
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
        <p className="font-medium text-destructive">Could not check the permissions</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );

  const open = data.permissions.filter((p) => !p.ok).length;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2 pb-1 text-xs text-muted-foreground">
        <span>{open ? `${open} ${open === 1 ? "permission needs" : "permissions need"} attention` : "Everything is allowed"}</span>
        <Button size="xs" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Spinner className="size-3" /> : <RefreshCw />} Re-check
        </Button>
      </div>
      {data.permissions.map((permission, i) => (
        <motion.div key={permission.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
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
  const fix = useMutation({
    mutationFn: () => api.doctor.fixPermission(permission.id),
    onSuccess: (result) => {
      toastFix(result);
      onFixed(result);
    },
    onError: (e) => toast.error(`Couldn't fix ${permission.name}`, { description: errorMessage(e) }),
  });

  const state: "ok" | "warn" | "error" = permission.ok ? "ok" : permission.required ? "error" : "warn";
  const Icon = state === "ok" ? CircleCheck : state === "error" ? CircleX : CircleAlert;
  const request = permission.fix === "request";

  return (
    <div className={cn("rounded-lg border bg-card p-3.5 transition-colors", state === "error" && "border-destructive/25", state === "warn" && "border-warning/25")}>
      <div className="flex items-start gap-3">
        <Icon
          className={cn("mt-0.5 size-5 shrink-0", state === "ok" && "text-success", state === "warn" && "text-warning", state === "error" && "text-destructive")}
          aria-label={state === "ok" ? "Allowed" : "Not allowed"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{permission.name}</span>
            {!permission.required && (
              <Badge variant="outline" className="h-5 rounded-[5px] text-[10px] font-normal text-muted-foreground">
                optional
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
        {!permission.ok && permission.fix !== "manual" && (
          <Button size="sm" variant={permission.required ? "default" : "outline"} onClick={() => fix.mutate()} disabled={fix.isPending}>
            {fix.isPending ? <Spinner /> : request ? <KeyRound /> : <Wrench />}
            {request ? "Allow" : fix.isPending ? "Fixing…" : "Fix"}
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
