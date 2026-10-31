import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Eye, Hand, Loader2, Maximize2, MonitorUp, PanelRightClose, PanelRightOpen, Repeat2, ScreenShareOff } from "lucide-react";
import type { Agent, ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { useNow } from "@/components/vault/use-now";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { subscribeComputer } from "@/lib/realtime";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { PANEL } from "@/lib/motion";
import { ComputerLiveView, targetIcon } from "./computer-live-view";
import { ComputerShareDialog } from "./share-dialog";
import { controlNote, viewsOf } from "./computer-utils";
import { currentLanguage } from "@/i18n";

export type ComputerFocusMode = "watch" | "control";

/** Views of a shared target — a shared desktop has one per display. */
export function useComputerViews(target: ComputerTarget | null): { view: string; label: string }[] {
  const { data } = useQuery({
    queryKey: qk.computerSources,
    queryFn: api.computer.sources,
    enabled: target?.kind === "desktop",
    staleTime: 30_000,
    retry: false,
  });
  return target ? viewsOf(target, data?.displays) : [];
}

/** Composer control: share a window, screen or tab — or, while sharing, what is shared (change / watch / stop). */
export function ComputerShareChip({
  target,
  agentName,
  onShare,
  onWatch,
  busy,
}: {
  target: ComputerTarget | null;
  agentName?: string;
  onShare: (target: ComputerTarget | null) => void | Promise<unknown>;
  onWatch?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation("computer");
  const [picking, setPicking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickAfterMenu = useRef(false);
  const dialog = (
    <ComputerShareDialog
      open={picking}
      onOpenChange={setPicking}
      current={target}
      agentName={agentName}
      sharing={busy}
      onShare={async (next) => {
        await onShare(next);
        setPicking(false);
      }}
    />
  );

  if (!target) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              onClick={() => setPicking(true)}
              aria-label={t("chip.share")}
              className="h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4"
            >
              {busy ? <Loader2 className="animate-spin" /> : <MonitorUp />}
              <span className="@max-sm/composer:sr-only">{t("chip.shareShort")}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chip.share")}</TooltipContent>
        </Tooltip>
        {dialog}
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label={t("chip.sharing", { label: computerTargetLabel(target, currentLanguage()) })}
                className="flex h-8 max-w-[15rem] min-w-0 items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft pr-1.5 pl-2 text-[13px] text-brand-strong transition hover:bg-brand-soft/80 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : targetIcon(target, "size-3.5 shrink-0")}
                <span className="truncate font-medium">{computerTargetLabel(target, currentLanguage())}</span>
                <LiveDot className="shrink-0" />
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{controlNote(target)}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-72"
          onCloseAutoFocus={(e) => {
            if (!pickAfterMenu.current) return;
            pickAfterMenu.current = false;
            e.preventDefault();
            setPicking(true);
          }}
        >
          <DropdownMenuLabel className="space-y-1 font-normal">
            <span className="block text-xs text-muted-foreground">{t("chip.sharedWith", { name: agentName ?? t("chip.theAgent") })}</span>
            <span className="block text-[13px] font-medium break-words text-foreground">{computerTargetLabel(target, currentLanguage())}</span>
            <span className="block text-[11px] text-muted-foreground">{controlNote(target)}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {onWatch && (
            <DropdownMenuItem onClick={onWatch}>
              <Eye /> {t("chip.watch")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => (pickAfterMenu.current = true)}>
            <Repeat2 /> {t("chip.shareElse")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void onShare(null)}>
            <ScreenShareOff /> {t("chip.stop")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

/** Right-hand panel of a chat that has something shared: live preview, what the agent does, take control, stop. */
export function ComputerPanel({
  target,
  agent,
  activity,
  onHide,
  onFocus,
  onStop,
  stopping,
}: {
  target: ComputerTarget;
  agent: Agent;
  activity: string | null;
  onHide: () => void;
  onFocus: (mode: ComputerFocusMode) => void;
  onStop: () => void;
  stopping?: boolean;
}) {
  const { t } = useTranslation("computer");
  const views = useComputerViews(target);
  const [index, setIndex] = useState(0);
  const view = views[Math.min(index, Math.max(0, views.length - 1))]?.view;
  const frame = useLive((s) => (view ? s.computerFrames[view] : undefined));
  const now = useNow(1000);
  const live = !!frame?.data && !frame.error && now - frame.at < 4000;

  useEffect(() => (view ? subscribeComputer(view) : undefined), [view]);

  return (
    <motion.aside
      aria-label={t("panel.aria")}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={PANEL}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full w-80 flex-col">
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b px-4", isTauri && isMac && "h-auto pt-7 pb-2")}>
          <span className="text-sm font-medium">{t("panel.title")}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
              live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
            )}
          >
            <LiveDot live={live} />
            {live ? t("panel.live") : t("panel.idle")}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1.5 ml-auto text-muted-foreground" onClick={onHide} aria-label={t("panel.hideAria")}>
                <PanelRightClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("panel.hide")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {views.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {views.map((v, i) => (
                <button
                  key={v.view}
                  type="button"
                  onClick={() => setIndex(i)}
                  className={cn(
                    "max-w-full truncate rounded-md border px-2 py-0.5 text-[11px] font-medium transition",
                    i === index ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <div className={cn("rounded-xl", activity && "glow-border")}>
            <button
              type="button"
              onClick={() => onFocus("watch")}
              aria-label={t("panel.watchFull")}
              className="group/preview relative block max-h-[45vh] w-full overflow-hidden rounded-xl border bg-card shadow-card outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              style={{ aspectRatio: frame?.width ? `${frame.width} / ${frame.height}` : "16 / 10" }}
            >
              {frame?.data ? (
                <img src={`data:${frame.mime};base64,${frame.data}`} alt="" draggable={false} className="absolute inset-0 size-full object-contain select-none" />
              ) : (
                <span className="absolute inset-0 grid place-items-center bg-paper-2 px-6 text-center">
                  <span className="flex flex-col items-center gap-2.5">
                    {frame?.error ? (
                      <span className="text-xs text-muted-foreground">{frame.error}</span>
                    ) : (
                      <>
                        <Orb variant="C3" size={24} label={t("panel.connectingLabel")} />
                        <span className="text-shimmer text-xs font-medium">{t("panel.connecting")}</span>
                      </>
                    )}
                  </span>
                </span>
              )}
              <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover/preview:bg-black/30 group-hover/preview:opacity-100 group-focus-visible/preview:bg-black/30 group-focus-visible/preview:opacity-100">
                <span className="glass inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground">
                  <Maximize2 className="size-3.5" /> {t("panel.watchFull")}
                </span>
              </span>
            </button>
          </div>

          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">{targetIcon(target, "size-3.5")}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-5 font-medium">{frame?.label || computerTargetLabel(target, currentLanguage())}</p>
              <p className="text-[11px] leading-4 text-muted-foreground">{controlNote(target)}</p>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {activity && (
              <motion.div key="activity" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-card">
                  <WorkingTicks count={8} className="shrink-0 text-brand" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activity}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => onFocus("control")} disabled={!frame?.data}>
              <Hand /> {t("panel.takeControl")}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" onClick={onStop} disabled={stopping} aria-label={t("chip.stop")}>
                  {stopping ? <Loader2 className="animate-spin" /> : <ScreenShareOff />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("chip.stop")}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="shrink-0 border-t px-4 py-3 text-[11px] text-muted-foreground">
          {t("panel.footer", { name: agent.name })}
        </div>
      </div>
    </motion.aside>
  );
}

/** Full-size live view on top of the chat, optionally starting in takeover mode. */
export function ComputerFocus({ target, mode, onClose }: { target: ComputerTarget | null; mode: ComputerFocusMode | null; onClose: () => void }) {
  const views = useComputerViews(target);
  return (
    <AnimatePresence>
      {target && mode && views.length > 0 && (
        <ComputerLiveView
          key={`${views[0]!.view}:${mode}`}
          target={target}
          views={views}
          expanded
          onExpandedChange={(expanded) => !expanded && onClose()}
          defaultTakeover={mode === "control"}
        />
      )}
    </AnimatePresence>
  );
}

/** Header button that brings the shared-screen panel back once it's hidden. */
export function ComputerToggle({ working, onClick }: { working: boolean; onClick: () => void }) {
  const { t } = useTranslation("computer");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("panel.show")} onClick={onClick} className="relative text-muted-foreground">
          <PanelRightOpen />
          {working && <LiveDot className="absolute top-1.5 right-1.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("panel.show")}</TooltipContent>
    </Tooltip>
  );
}
