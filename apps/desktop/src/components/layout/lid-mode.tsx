import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { LaptopMinimal, LaptopMinimalCheck } from "lucide-react";
import { toast } from "sonner";
import type { PowerStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api } from "@/lib/api";
import { cloudContext } from "@/lib/core";
import { usePower } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const ASKING_TOAST = "lid-mode-password";
/** Shared by the footer button and the settings switch: one switch at a time, one password dialog. */
const LID_MUTATION = ["power", "lid"];

/** Short state line for the footer tooltip and the settings row. */
export function lidModeLine(status: PowerStatus): string {
  switch (status.state) {
    case "on":
      return status.lidClosed ? "The lid is closed and agents keep working." : "Close the lid: agents keep working.";
    case "idle":
      return "No agent is working, so the Mac may sleep. It stays awake again as soon as one starts.";
    case "low_battery":
      return `Paused at ${status.battery?.percent ?? "low"}% battery. Plug in the Mac to continue.`;
    case "error":
      return status.error ?? "macOS refused the change.";
    default:
      return "Closing the lid puts the Mac to sleep.";
  }
}

/** Switches lid-closed mode. The first time macOS asks for the password on the Mac, so the request may wait for a human. */
export function useLidMode() {
  const qc = useQueryClient();
  const power = usePower();
  const toggle = useMutation({
    mutationKey: LID_MUTATION,
    mutationFn: (enabled: boolean) => api.power.setLid(enabled),
    onMutate: (enabled) => {
      if (enabled && power.data && !power.data.permission) {
        toast.loading("Enter your Mac password", { id: ASKING_TOAST, description: "macOS asks once so Godmode can keep the Mac awake with the lid closed." });
      }
    },
    onSuccess: (status) => {
      toast.dismiss(ASKING_TOAST);
      qc.setQueryData(qk.power, status);
      if (!status.enabled) toast.success("Lid-closed mode off", { description: "Your Mac sleeps again when you close the lid." });
      else if (status.state === "on") toast.success("Lid-closed mode on", { description: "Close the lid whenever you like. Your agents keep working." });
      else toast.info("Lid-closed mode on", { description: lidModeLine(status) });
    },
    onError: (err) => {
      toast.dismiss(ASKING_TOAST);
      if (err instanceof ApiRequestError && err.code === "power_cancelled") toast.info("Nothing changed", { description: "The Mac password wasn't entered." });
      else toastApiError(err, "Could not switch lid-closed mode", qc);
      void qc.invalidateQueries({ queryKey: qk.power });
    },
  });
  const pending = useIsMutating({ mutationKey: LID_MUTATION }) > 0;
  // Shown while it holds the Mac awake even if a reading missed the lid, so it can always be turned off.
  const visible = !cloudContext && !!power.data && (power.data.supported || power.data.enabled || (power.data.active && power.data.owned));
  return { status: power.data, visible, toggle: toggle.mutate, pending };
}

/** Footer switch next to Settings: only on a Mac with a lid, and only on the computer itself. */
export function LidModeButton() {
  const { status, visible, toggle, pending } = useLidMode();
  if (!visible || !status) return null;
  const on = status.enabled;
  const paused = on && (status.state === "idle" || status.state === "low_battery");
  // Also when off: sleep couldn't be given back, and the click does exactly that.
  const broken = status.state === "error";
  const Icon = on ? LaptopMinimalCheck : LaptopMinimal;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-pressed={on}
          aria-label={broken && !on ? "Let the Mac sleep" : on ? "Turn off lid-closed mode" : "Keep working with the lid closed"}
          disabled={pending}
          onClick={() => toggle(broken ? false : !on)}
          className={cn(
            "relative size-8",
            on && !paused && !broken && "bg-brand-soft text-brand-strong hover:bg-brand-soft hover:text-brand-strong",
            paused && "text-muted-foreground",
            broken && "text-warning hover:text-warning",
          )}
        >
          {pending ? <Spinner className="size-4" /> : <Icon className="size-4" />}
          {(on || broken) && !pending && (
            <span
              aria-hidden
              className={cn(
                "absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-card",
                broken ? "bg-warning" : paused ? "bg-muted-foreground/60" : "bg-brand",
              )}
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <p className="font-medium">Lid-closed mode {broken ? "needs attention" : on ? (paused ? "paused" : "on") : "off"}</p>
        <p className="opacity-80">{on || broken ? lidModeLine(status) : "Click to keep agents working when you close the lid."}</p>
      </TooltipContent>
    </Tooltip>
  );
}
