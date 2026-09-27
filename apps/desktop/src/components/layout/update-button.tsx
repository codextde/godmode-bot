import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { LiveDot } from "@/components/aicss/Motion";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLive } from "@/stores/live";
import { installUpdate, useUpdater } from "@/stores/updater";

/** Installs the downloaded update, asking first when agents are still working. */
export function useRestartToUpdate() {
  const running = useLive((s) => Object.keys(s.runs).length);
  const [confirming, setConfirming] = useState(false);
  const installing = useRef(false);

  const install = async () => {
    if (installing.current) return;
    installing.current = true;
    try {
      await installUpdate();
    } catch (e) {
      installing.current = false;
      toast.error("Couldn't install the update", { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const restart = () => (running > 0 ? setConfirming(true) : void install());

  const dialog = (
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      destructive={false}
      title="Restart to update?"
      description={`${running === 1 ? "1 agent is" : `${running} agents are`} still working. Restarting stops ${running === 1 ? "it" : "them"} — you can pick up where you left off once Godmode is back.`}
      confirmLabel="Restart now"
      onConfirm={() => void install()}
    />
  );
  return { restart, dialog };
}

export function UpdateButton() {
  const update = useUpdater((s) => s.update);
  const { restart, dialog } = useRestartToUpdate();
  const visible = update.status === "ready" || update.status === "installing";
  const installing = update.status === "installing";
  const version = visible ? update.version : "";

  return (
    <>
      <AnimatePresence initial={false}>
        {visible && (
          <motion.div
            key="update"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="flex w-full items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 shadow-card group-data-[collapsible=icon]:hidden">
              <LiveDot />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[12.5px] font-medium">Update ready</p>
                <p className="truncate font-mono text-[10.5px] text-muted-foreground">v{version}</p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="xs" className="h-7 px-2.5" onClick={restart} disabled={installing}>
                    {installing ? <Spinner className="size-3" /> : <RotateCw />}
                    {installing ? "Restarting" : "Restart"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Install v{version} and reopen Godmode</TooltipContent>
              </Tooltip>
            </div>

            <div className="hidden flex-col items-center rounded-lg border bg-card p-1 shadow-card group-data-[collapsible=icon]:flex">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative size-8"
                    onClick={restart}
                    disabled={installing}
                    aria-label={`Restart to update to v${version}`}
                  >
                    {installing ? <Spinner /> : <RotateCw />}
                    <LiveDot className="absolute top-1 right-1" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Restart to update to v{version}</TooltipContent>
              </Tooltip>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {dialog}
    </>
  );
}
