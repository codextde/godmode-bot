import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { LiveDot } from "@/components/aicss/Motion";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLive } from "@/stores/live";
import { installUpdate, useUpdater } from "@/stores/updater";

export function useRestartToUpdate() {
  const { t } = useTranslation("layout");
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
      toast.error(t("update.installFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const restart = () => (running > 0 ? setConfirming(true) : void install());

  const dialog = (
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      destructive={false}
      title={t("update.confirmTitle")}
      description={t("update.confirmDescription", { count: running })}
      confirmLabel={t("update.restartNow")}
      onConfirm={() => void install()}
    />
  );
  return { restart, dialog };
}

export function UpdateButton() {
  const { t } = useTranslation("layout");
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
              <LiveDot live={false} className="bg-brand" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[12.5px] font-medium">{t("update.ready")}</p>
                <p className="truncate font-mono text-[10.5px] text-muted-foreground">v{version}</p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="xs" className="h-7 px-2.5" onClick={restart} disabled={installing}>
                    {installing ? <Spinner className="size-3" /> : <RotateCw />}
                    {installing ? t("update.restarting") : t("update.restart")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("update.installAndReopen", { version })}</TooltipContent>
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
                    aria-label={t("update.restartToUpdate", { version })}
                  >
                    {installing ? <Spinner /> : <RotateCw />}
                    <LiveDot live={false} className="absolute top-1 right-1 bg-brand" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{t("update.restartToUpdate", { version })}</TooltipContent>
              </Tooltip>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {dialog}
    </>
  );
}
