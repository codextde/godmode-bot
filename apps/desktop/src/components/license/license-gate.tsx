import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { MASCOT_CHARACTER, MASCOT_COLOR, type LicenseState } from "@godmode/shared";
import { Backdrop } from "@/components/brand";
import { Character } from "@/components/character";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { ActivatePanel } from "./activate";

/** Replaces the app while the licence refuses new runs; a working key takes it away without a reload. */
export function LicenseGate({ state }: { state: LicenseState }) {
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: api.license.refresh,
    onSuccess: (next) => {
      qc.setQueryData(qk.license, next);
      if (next.blocked) toast("Nothing changed yet", { description: next.message ?? undefined });
    },
    onError: (err) => toast.error("Couldn't check the licence", { description: errorMessage(err) }),
  });

  return (
    <div className="relative min-h-full overflow-y-auto bg-background">
      <Backdrop />
      <div className="absolute inset-x-0 top-0 h-8" data-tauri-drag-region />
      <div className="relative mx-auto flex min-h-full w-full max-w-[480px] flex-col justify-center px-5 py-14">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
          className="flex flex-col items-center text-center"
        >
          <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={76} mood="idle" follow title="Godmode" />
          <p className="eyebrow mt-7">Godmode Pro</p>
          <h1 className="heading-display mt-2 text-[32px] sm:text-[36px]">Activate Godmode</h1>
          <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-balance text-muted-foreground">
            {state.message ?? "Start your free trial, or enter your licence key to keep your agents working."}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.2, 0.8, 0.2, 1] }}
          className="mt-8 rounded-2xl border bg-card p-6 shadow-float sm:p-7"
        >
          <ActivatePanel source="gate" />
        </motion.div>

        <div className="mt-6 flex min-h-8 items-center justify-center gap-3 text-xs text-muted-foreground">
          {state.keyHint && (
            <>
              <span>
                Key ending in <span className="font-mono text-foreground">{state.keyHint}</span>
              </span>
              <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                {refresh.isPending ? <Spinner className="size-3.5" /> : <RefreshCw />} Check again
              </Button>
            </>
          )}
          {!state.keyHint && <span>Your agents, chats and logins stay safe on this computer.</span>}
        </div>
      </div>
    </div>
  );
}
