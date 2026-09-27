import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { isVaultLocked } from "@/components/vault/vault-utils";

/** Inline error card for failed list queries. A 423 flips the app to the unlock screen. */
export function QueryError({ error, onRetry, title = "Couldn't load this", className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const qc = useQueryClient();
  const locked = isVaultLocked(error);
  useEffect(() => {
    if (locked) {
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      void qc.invalidateQueries({ queryKey: qk.vaultStatus });
    }
  }, [locked, qc]);
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/[0.05] p-4", className)} role="alert">
      {locked ? <Lock className="mt-0.5 size-4 shrink-0 text-warning" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{locked ? "The vault is locked" : title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{locked ? "Unlock the vault to manage integrations." : errorMessage(error)}</p>
      </div>
      {onRetry && !locked && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      )}
    </div>
  );
}
